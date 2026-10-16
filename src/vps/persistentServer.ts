import { createHash, randomBytes, randomUUID, scrypt as deriveKey, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, utimes } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { atomicWriteFile } from '../core/atomicFile';
import { portableRelativePath } from '../core/projectPath';
import { classifyFile } from '../core/projectFiles';
import { PersistentWorkspace, PersistentStorageError } from './persistentStorage';
import { PersistentComputePolicy, type PersistentComputeState, type PersistentDeviceInput } from './persistentCompute';
import { PersistentHistory } from './persistentHistory';
import * as Y from 'yjs';
import { loadNotebookCrdt, saveNotebookCrdt, sharedNotebook } from './persistentNotebookCrdt';
import { persistentNotebookOutputs } from './persistentNotebookOutputs';
import { PersistentLive, type PersistentPresence } from './persistentLive';
import { createSharedCursorPosition, encodeRelativeOffset, resolveRelativeOffset, resolveSharedCursorPosition, type SharedCursorPosition } from '../core/cursorPosition';
import type { TextChange } from '../core/crdt';
import { editSharedNotebook, type NotebookSyncReply } from './persistentNotebookCrdt';
import type { PersistentCommand, PersistentDevice, PersistentExecution, PersistentMember, PersistentMembership, PersistentRpcRequest, PersistentSessionView } from './persistentProtocol';
import { safeJobPath, VPS_ID, visibleVpsText } from './protocol';
import { defaultPermissions, mayEdit, mayChangeTree, normalizePermissions, type ParticipantPermissions } from '../core/permissions';
import { MAX_LINE_COMMENTS, normalizeCommentInput, normalizeLineComment, reanchorComment, commentColor, participantColor, type LineComment } from '../core/lineComments';

const scrypt = (value: string, salt: string): Promise<Buffer> => new Promise((resolve, reject) => {
  deriveKey(value, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
});
const PRESENCE_MS = 20_000;
const MAX_RPC_BYTES = 12 * 1024 * 1024;
const MAX_EVENTS_BYTES = 8 * 1024 * 1024;
const MAX_COMMAND_BYTES = 64 * 1024 * 1024;
const MAX_CONTROL_BYTES = 256 * 1024;
const MAX_EXECUTIONS = 32;
const MAX_SESSIONS = 16;
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const token = (): string => randomBytes(32).toString('base64url');

class SessionError extends Error {
  public constructor(public readonly status: number, message: string) { super(message); }
}
interface MemberRecord { id: string; name: string; role: PersistentMember['role']; tokenHash: string; revoked: boolean; invitationId?: string; expiresAt?: number; readOnly?: boolean; permissions?: ParticipantPermissions }
interface Invitation { id: string; tokenHash: string; expiresAt: number; readOnly: boolean; revoked: boolean }
interface ExecutionRecord {
  execution: PersistentExecution; requestId: string; commandId: string; cellIdentity: string;
  sourceHash: string; notebookVersion: number; offset: number; reports: { offset: number; digest: string; end: number }[];
  notebookIdentity?: string;
  aclEpoch: number; controls: { id: string; command: Record<string, unknown> }[];
  kernelCommand?: 'restart' | 'release';
  mergePending?: boolean;
  outputPublication?: { fromVersion: number; toVersion: number };
}
interface SessionRecord {
  version: 1; id: string; name: string; state: 'running' | 'stopped'; ownerId: string;
  password: { salt: string; hash: string }; members: MemberRecord[]; policy: PersistentComputeState;
  executions: ExecutionRecord[];
  aclEpoch: number;
  invitations?: Invitation[];
  comments?: LineComment[];
  commentRevision?: number;
}
interface Session { record: SessionRecord; workspace: PersistentWorkspace; policy: PersistentComputePolicy; seen: Map<string, number>; history: PersistentHistory; live: PersistentLive }
interface NotebookCell { id?: string; cell_type?: string; source?: string | string[]; outputs?: unknown[]; execution_count?: number | null }
interface Notebook { cells: NotebookCell[]; [key: string]: unknown }
export interface PersistentHostOptions { directory: string; administrativeTokens: string[]; vpsAgentToken?: string }

/** Disk-backed Session Host. A disconnected editor never owns its lifecycle. */
export class PersistentSessionHost {
  private readonly sessions = new Map<string, Session>();
  private readonly failures = new Map<string, { count: number; until: number }>();
  private serial: Promise<unknown> = Promise.resolve();
  private sweep: NodeJS.Timeout | undefined;
  private vpsInventory: PersistentDevice | undefined;
  private closing = false;
  public constructor(private readonly options: PersistentHostOptions) {}

  public async start(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(this.options.directory)).isSymbolicLink()) throw new Error('Session store must not be a symlink.');
    const entries = await readdir(this.options.directory, { withFileTypes: true });
    const directories = entries.filter((entry) => VPS_ID.test(entry.name));
    if (directories.length > MAX_SESSIONS) throw new Error('Session store exceeds its limit.');
    for (const directory of directories) {
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid saved session directory.');
      const record = JSON.parse(await this.readMetadata(path.join(this.options.directory, directory.name, 'session.json'), 40 * 1024 * 1024)) as SessionRecord;
      this.validateRecord(record, directory.name);
      const workspace = new PersistentWorkspace(path.join(this.options.directory, record.id, 'workspace'));
      await workspace.init();
      const policy = new PersistentComputePolicy(record.id, record.ownerId, record.policy);
      const session: Session = { record, workspace, policy, seen: new Map(), history: new PersistentHistory(this.directory(record.id)), live: new PersistentLive() };
      policy.setMembers(this.members(session));
      for (const run of record.executions) {
        if (run.execution.state === 'queued') {
          run.execution.state = 'interrupted'; run.execution.error = 'The server restarted. Run the cell explicitly to create a new execution.';
        }
      }
      this.retireRevokedReporting(session);
      this.sessions.set(record.id, session);
      for (const run of record.executions) if (run.mergePending) await this.finishResultMerge(session, run);
      await this.retainResultPublications(session);
      await this.persist(session);
    }
    this.sweep = setInterval(() => {
      void this.enqueue(async () => {
        for (const session of this.sessions.values()) {
          const before = JSON.stringify(session.policy.serialize());
          const states = session.record.executions.map((run) => run.execution.state).join(',');
          session.policy.setMembers(this.members(session));
          this.retireRevokedReporting(session);
          if (JSON.stringify(session.policy.serialize()) !== before || states !== session.record.executions.map((run) => run.execution.state).join(',')) await this.persist(session);
        }
        const now = Date.now();
        for (const [key, failure] of this.failures) if (failure.until < now) this.failures.delete(key);
      }).catch(() => undefined);
    }, 5000);
    this.sweep.unref();
  }

  public async stop(): Promise<void> {
    this.closing = true;
    this.closeLiveConnections();
    if (this.sweep) clearInterval(this.sweep);
    await this.serial;
    for (const session of this.sessions.values()) await this.persist(session);
  }
  public closeLiveConnections(): void {
    for (const session of this.sessions.values()) session.live.close();
  }

  public async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('cache-control', 'no-store'); response.setHeader('content-type', 'application/json');
    const deadline = setTimeout(() => request.destroy(), 15_000); deadline.unref();
    try {
      if (this.closing) throw new SessionError(503, 'Session service is stopping.');
      if (request.method !== 'POST') throw new SessionError(405, 'Use POST.');
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) { size += (chunk as Buffer).length; if (size > MAX_RPC_BYTES) throw new SessionError(413, 'Request exceeds session limits.'); chunks.push(chunk as Buffer); }
      let body: PersistentRpcRequest;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as PersistentRpcRequest; } catch { throw new SessionError(400, 'Invalid JSON.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.operation !== 'string') throw new SessionError(400, 'Invalid session operation.');
      const auth = request.headers.authorization;
      const credential = typeof auth === 'string' && /^Bearer [A-Za-z0-9_-]{32,256}$/.test(auth) ? auth.slice(7) : '';
      if (body.operation === 'subscribe') {
        await this.enqueue(async () => {
          const session = this.sessions.get(this.string(body, 'sessionId')); if (!session) throw new SessionError(404, 'Session unavailable.');
          const member = this.membership(session, credential); this.active(session);
          session.live.attach({ response, memberId: member.id,
            valid: () => { try { return !this.closing && session.record.state === 'running' && this.membership(session, credential).id === member.id; } catch { return false; } },
            visible: (filename) => session.workspace.snapshot(member.id === session.record.ownerId).entries.some((entry) => entry.path === filename && entry.type === 'file'),
          });
          for (const run of session.record.executions) if (run.execution.state === 'queued' || run.execution.state === 'running') this.publishExecution(session, run);
        });
        return;
      }
      const value = await this.enqueue(async () => {
        const result = await this.dispatch(body, credential, request.socket.remoteAddress ?? 'unknown');
        if (['write', 'mkdir', 'rename', 'remove', 'visibility', 'lifecycle', 'revoke', 'revokeInvitation', 'password'].includes(body.operation)) this.sessions.get(body.sessionId ?? '')?.live.invalidate();
        return result;
      });
      response.end(JSON.stringify(value));
    } catch (error) {
      let status = error instanceof SessionError ? error.status : 500;
      if (error instanceof PersistentStorageError) status = ({ CONFLICT: 409, NOT_FOUND: 404, INVALID_PATH: 400, FORBIDDEN: 403, QUOTA_EXCEEDED: 413, INVALID_CONTENT: 400 } as Record<string, number>)[error.code] ?? 500;
      const policyStatus = (error as { status?: unknown }).status;
      if (typeof policyStatus === 'number' && policyStatus >= 400 && policyStatus < 500) status = policyStatus;
      response.statusCode = status;
      const requestId = randomUUID();
      if (status >= 500) {
        const code = (error as NodeJS.ErrnoException).code;
        const frames = error instanceof Error ? error.stack?.split('\n').slice(1, 9).join('\n') : undefined;
        console.error(`[persistent] request=${requestId} code=${typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : 'INTERNAL'}\n${frames ?? ''}`);
      }
      response.end(JSON.stringify({ error: status < 500 ? (error as Error).message : 'Persistent session operation failed.', ...(status >= 500 ? { requestId } : {}) }));
    } finally { clearTimeout(deadline); }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation); this.serial = result.catch(() => undefined); return result;
  }
  private directory(id: string): string { return path.join(this.options.directory, id); }
  private async persist(session: Session): Promise<void> {
    session.record.policy = session.policy.serialize();
    await this.writeMetadata(path.join(this.directory(session.record.id), 'session.json'), JSON.stringify(session.record));
  }
  private async trimHistory(session: Session, capacity = false, reserveBytes = 0, excludedId = ''): Promise<void> {
    const bytes = (): number => session.record.executions.reduce((total, run) => total + Buffer.byteLength(JSON.stringify(run.execution.events)), 0);
    while ((capacity && session.record.executions.length >= MAX_EXECUTIONS) || bytes() + reserveBytes > 32 * 1024 * 1024) {
      const index = session.record.executions.findIndex((run) => !run.mergePending && !this.hasOutputDependents(session, run) && run.execution.id !== excludedId && run.execution.state !== 'queued' && run.execution.state !== 'running');
      if (index < 0) break;
      const run = session.record.executions[index]!;
      const artifact = path.join(this.directory(session.record.id), 'results', `${run.execution.id}.json`);
      try { await lstat(artifact); run.execution.error = `${run.execution.error ? run.execution.error + ' ' : ''}Returned artifact transport retention expired; merged project files remain on VPS.`; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await session.history.archive(run); session.record.executions.splice(index, 1); await this.persist(session);
      await rm(path.join(this.directory(session.record.id), 'commands', `${run.commandId}.json`), { force: true }); await rm(artifact, { force: true });
      await rm(path.join(this.directory(session.record.id), 'command-files', run.commandId), { recursive: true, force: true });
      await rm(path.join(this.directory(session.record.id), 'uploads', run.execution.id), { recursive: true, force: true });
    }
  }
  private async safeDirectories(directory: string): Promise<void> {
    const parent = path.dirname(directory); if (parent !== directory) await this.safeDirectories(parent);
    const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Session metadata directory is unsafe.');
  }
  private async readMetadata(filename: string, maximum: number): Promise<string> {
    await this.safeDirectories(path.dirname(filename));
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat(); if (!info.isFile() || info.nlink !== 1 || info.size > maximum) throw new Error('Session metadata is unsafe or too large.');
      const bytes = await handle.readFile(); if (bytes.length > maximum) throw new Error('Session metadata grew beyond limits.'); return bytes.toString('utf8');
    } finally { await handle.close(); }
  }
  private async writeMetadata(filename: string, content: string): Promise<void> {
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 }); await this.safeDirectories(path.dirname(filename));
    try { const info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Session metadata target is unsafe.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await atomicWriteFile(filename, content);
  }
  private validateRecord(record: SessionRecord, id: string): void {
    for (const member of record.members ?? []) if (member.permissions !== undefined) normalizePermissions(member.permissions);
    if (record.comments !== undefined) {
      if (!Array.isArray(record.comments) || record.comments.length > MAX_LINE_COMMENTS) throw new Error('Invalid saved comments.');
      record.comments = record.comments.map(normalizeLineComment);
    }
    if (!record || record.version !== 1 || record.id !== id || !VPS_ID.test(record.ownerId) || !visibleVpsText(record.name, 120)
      || !['running', 'stopped'].includes(record.state) || !record.password || !/^[a-f0-9]{32}$/.test(record.password.salt)
      || !/^[a-f0-9]{128}$/.test(record.password.hash) || !Array.isArray(record.members) || record.members.length > 128
      || record.members.some((member) => !member || !VPS_ID.test(member.id) || !visibleVpsText(member.name, 120)
        || !['owner', 'admin', 'member'].includes(member.role) || !/^[a-f0-9]{64}$/.test(member.tokenHash) || typeof member.revoked !== 'boolean')
      || record.members.filter((member) => member.role === 'owner' && member.id === record.ownerId && !member.revoked).length !== 1
      || record.members.some((member) => member.role === 'owner' && member.id !== record.ownerId)
      || new Set(record.members.map((member) => member.id)).size !== record.members.length
      || record.members.some((member) => (member.expiresAt !== undefined && !Number.isSafeInteger(member.expiresAt)) || (member.readOnly !== undefined && typeof member.readOnly !== 'boolean') || (member.invitationId !== undefined && !VPS_ID.test(member.invitationId)))
      || (record.invitations !== undefined && (!Array.isArray(record.invitations) || record.invitations.length > 64 || record.invitations.some((invite) => !invite || !VPS_ID.test(invite.id) || !/^[a-f0-9]{64}$/.test(invite.tokenHash) || !Number.isSafeInteger(invite.expiresAt) || typeof invite.readOnly !== 'boolean' || typeof invite.revoked !== 'boolean')))
      || !Number.isSafeInteger(record.aclEpoch) || record.aclEpoch < 1
      || !Array.isArray(record.executions) || record.executions.length > MAX_EXECUTIONS) throw new Error('Invalid saved session authority.');
    for (const run of record.executions) {
      if (!run || !run.execution || !VPS_ID.test(run.execution.id) || !VPS_ID.test(run.commandId) || !VPS_ID.test(run.requestId)
        || !safeJobPath(run.execution.notebook) || !Number.isSafeInteger(run.execution.generation) || run.execution.generation < 1
        || !Number.isSafeInteger(run.offset) || run.offset < 0 || !Array.isArray(run.execution.events)
        || Buffer.byteLength(JSON.stringify(run.execution.events)) > MAX_EVENTS_BYTES || !Array.isArray(run.reports) || run.reports.length > 4096
        || !Number.isSafeInteger(run.aclEpoch) || run.aclEpoch < 1 || !Array.isArray(run.controls) || run.controls.length > 128
        || (run.execution.scope !== undefined && !['public', 'private'].includes(run.execution.scope))
        || (run.notebookIdentity !== undefined && (typeof run.notebookIdentity !== 'string' || !/^[a-f0-9]{32}$/.test(run.notebookIdentity)))
        || (run.kernelCommand !== undefined && run.kernelCommand !== 'restart' && run.kernelCommand !== 'release')
        || (run.mergePending !== undefined && (typeof run.mergePending !== 'boolean' || (run.mergePending && !['completed', 'failed'].includes(run.execution.state))))
        || (run.outputPublication !== undefined && (!run.outputPublication || !Number.isSafeInteger(run.outputPublication.fromVersion) || run.outputPublication.fromVersion < 1 || !Number.isSafeInteger(run.outputPublication.toVersion) || run.outputPublication.toVersion <= run.outputPublication.fromVersion))
        || !['queued', 'running', 'completed', 'failed', 'interrupted'].includes(run.execution.state)) throw new Error('Invalid saved execution.');
    }
  }
  private matches(actual: string, expectedHash: string): boolean { return !!actual && timingSafeEqual(Buffer.from(sha(actual), 'hex'), Buffer.from(expectedHash, 'hex')); }
  private administrative(credential: string): boolean { return this.options.administrativeTokens.some((value) => this.matches(credential, sha(value))); }
  private agent(credential: string): boolean { return !!this.options.vpsAgentToken && this.matches(credential, sha(this.options.vpsAgentToken)); }
  private membership(session: Session, credential: string): MemberRecord {
    const member = session.record.members.find((candidate) => this.validMember(session, candidate) && this.matches(credential, candidate.tokenHash));
    if (!member) throw new SessionError(401, 'Session membership is invalid or revoked.'); return member;
  }
  private members(session: Session): PersistentMember[] {
    return session.record.members.filter((member) => this.validMember(session, member)).map((member) => ({ id: member.id, name: member.name, role: member.role,
      online: (session.seen.get(member.id) ?? 0) > Date.now() - PRESENCE_MS, permissions: this.permissions(member) }));
  }
  private validMember(session: Session, member: MemberRecord): boolean {
    return !member.revoked && (member.expiresAt === undefined || member.expiresAt > Date.now())
      && (!member.invitationId || session.record.invitations?.some((invite) => invite.id === member.invitationId && !invite.revoked && invite.expiresAt > Date.now()) === true);
  }
  private limitAuthentication(address: string): void {
    const key = `authentication:${address}`; const previous = this.failures.get(key);
    if (previous && previous.until > Date.now() && previous.count >= 20) throw new SessionError(429, 'Too many authentication attempts. Try later.');
    if (this.failures.size >= 1024 && !this.failures.has(key)) this.failures.delete(this.failures.keys().next().value!);
    this.failures.set(key, { count: previous && previous.until > Date.now() ? previous.count + 1 : 1, until: previous && previous.until > Date.now() ? previous.until : Date.now() + 60_000 });
  }
  private retireRevokedReporting(session: Session): void {
    const members = new Set(session.record.members.filter((member) => this.validMember(session, member)).map((member) => member.id));
    const deviceOwners = new Map(session.policy.view().devices.map((device) => [device.id, device.ownerId]));
    for (const run of session.record.executions) {
      if (run.execution.state !== 'queued' && run.execution.state !== 'running') continue;
      const reporter = deviceOwners.get(run.execution.deviceId);
      if (run.execution.deviceId !== 'vps' && reporter && !members.has(reporter)) {
        run.execution.state = 'interrupted';
        run.execution.error = 'Execution reporting access revoked; accepted code may still be running and results are retained locally';
      } else if (run.execution.state === 'queued' && !members.has(run.execution.requesterId)) {
        run.execution.state = 'interrupted'; run.execution.error = 'Execution requester membership was revoked before launch; no automatic relaunch.';
      }
    }
  }
  private active(session: Session): void { if (session.record.state !== 'running') throw new SessionError(409, 'Session is stopped. Start it explicitly.'); }
  private async privacyBarrier(session: Session): Promise<void> {
    session.record.aclEpoch++; session.policy.invalidateKernels(); await this.persist(session);
  }
  private owner(session: Session, member: MemberRecord): void { if (member.id !== session.record.ownerId) throw new SessionError(403, 'Only the owner can change this authority.'); }
  private permissions(member: MemberRecord): ParticipantPermissions {
    return member.readOnly ? defaultPermissions(true) : member.permissions ?? defaultPermissions();
  }
  private requireEdit(session: Session, member: MemberRecord, filename: string, destination?: string): void {
    if (portableRelativePath(filename) !== filename || (destination !== undefined && portableRelativePath(destination) !== destination)) throw new SessionError(400, 'Invalid project path.');
    if (member.id === session.record.ownerId) return;
    if (!mayChangeTree(this.permissions(member), filename, session.workspace.snapshot(false).entries.map((entry) => entry.path), destination)) throw new SessionError(403, 'You do not have permission to edit these project files.');
  }
  private administrator(member: MemberRecord): void { if (member.role !== 'owner' && member.role !== 'admin') throw new SessionError(403, 'Session administration permission is required.'); }
  private string(body: PersistentRpcRequest, key: string): string { const value = body[key]; if (typeof value !== 'string') throw new SessionError(400, `Invalid ${key}.`); return value; }
  private revision(body: PersistentRpcRequest): number { const value = body.expectedRevision; if (!Number.isSafeInteger(value) || (value as number) < 0) throw new SessionError(400, 'Expected revision is required.'); return value as number; }
  private async password(value: unknown): Promise<SessionRecord['password']> {
    if (typeof value !== 'string' || value.length < 12 || value.length > 1024) throw new SessionError(400, 'Use a session password of 12–1024 characters.');
    const salt = randomBytes(16).toString('hex'); const key = await scrypt(value, salt);
    return { salt, hash: key.toString('hex') };
  }
  private view(session: Session, member: MemberRecord): PersistentSessionView {
    const policy = session.policy.view();
    const devices = policy.devices.map((device) => ({ ...device, usingMemberIds: [...new Set(session.record.executions
      .filter((run) => (member.id === session.record.ownerId || run.execution.scope !== 'private') && run.execution.state === 'running' && run.execution.deviceId === device.id).map((run) => run.execution.requesterId))] }));
    return { id: session.record.id, name: session.record.name, state: session.record.state, ownerId: session.record.ownerId,
      collaborationRevision: (session.record.commentRevision ?? 0) + session.record.aclEpoch,
      memberId: member.id, members: this.members(session), revision: session.workspace.snapshot(member.id === session.record.ownerId).revision,
      allowMemberSwitch: policy.allowMemberSwitch, devices, target: policy.target, generation: policy.generation,
      consents: policy.consents.filter((consent) => member.id === session.record.ownerId || consent.requesterId === member.id || policy.devices.some((device) => device.id === consent.deviceId && device.ownerId === member.id)) };
  }

  private async dispatch(body: PersistentRpcRequest, credential: string, address: string): Promise<unknown> {
    if (this.closing) throw new SessionError(503, 'Session service is stopping.');
    if (['discover', 'join', 'acceptInvitation'].includes(body.operation)) this.limitAuthentication(address);
    if (body.operation === 'discover') {
      const value = typeof body.password === 'string' && body.password.length >= 12 && body.password.length <= 1024 ? body.password : '';
      const matches: { id: string; name: string }[] = [];
      for (const session of this.sessions.values()) {
        const actual = await scrypt(value, session.record.password.salt);
        if (timingSafeEqual(actual, Buffer.from(session.record.password.hash, 'hex')) && session.record.state === 'running') matches.push({ id: session.record.id, name: session.record.name });
      }
      if (!matches.length) throw new SessionError(401, 'Session access is unavailable.');
      return { sessions: matches };
    }
    if (body.operation === 'acceptInvitation') {
      const invitationToken = typeof body.invitationToken === 'string' ? body.invitationToken : '';
      const session = this.sessions.get(String(body.sessionId));
      const invite = session?.record.invitations?.find((entry) => this.matches(invitationToken, entry.tokenHash) && !entry.revoked && entry.expiresAt > Date.now());
      if (!session || !invite || session.record.state !== 'running') throw new SessionError(401, 'Session access is unavailable.');
      return this.addMember(session, body, invite);
    }
    if (body.operation === 'create') {
      if (!this.administrative(credential)) throw new SessionError(401, 'An administrative credential is required to create sessions.');
      if (this.sessions.size >= MAX_SESSIONS) throw new SessionError(409, 'Session limit reached.');
      const name = this.string(body, 'name'); if (!visibleVpsText(name, 120)) throw new SessionError(400, 'Invalid session name.');
      const password = await this.password(body.password); const id = randomUUID(); const memberId = randomUUID(); const secret = token();
      const policy = new PersistentComputePolicy(id, memberId); const workspace = new PersistentWorkspace(path.join(this.directory(id), 'workspace')); await workspace.init();
      const session: Session = { record: { version: 1, id, name, state: 'running', ownerId: memberId, password,
        members: [{ id: memberId, name: typeof body.memberName === 'string' && visibleVpsText(body.memberName, 120) ? body.memberName : 'Owner', role: 'owner', tokenHash: sha(secret), revoked: false }], policy: policy.serialize(), executions: [], aclEpoch: 1 }, workspace, policy, seen: new Map([[memberId, Date.now()]]), history: new PersistentHistory(this.directory(id)), live: new PersistentLive() };
      policy.setMembers(this.members(session)); if (this.vpsInventory) policy.registerVps(this.vpsInventory);
      await this.persist(session); this.sessions.set(id, session);
      return { sessionId: id, memberId, token: secret, name } satisfies PersistentMembership;
    }
    if (body.operation === 'list') {
      if (!this.administrative(credential)) throw new SessionError(401, 'An administrative credential is required.');
      return { sessions: [...this.sessions.values()].map(({ record }) => ({ id: record.id, name: record.name, state: record.state })) };
    }
    if ((body.operation === 'registerDevice' || body.operation === 'claim') && !body.sessionId) {
      if (!this.agent(credential) || (body.deviceId !== 'vps' && (body.device as { id?: unknown } | undefined)?.id !== 'vps')) throw new SessionError(403, 'Only the configured VPS agent can act across sessions.');
      if (body.operation === 'registerDevice') {
        const input = body.device as PersistentDeviceInput;
        for (const session of this.sessions.values()) { this.vpsInventory = session.policy.registerVps(input); await this.persist(session); }
        if (!this.sessions.size) { const check = new PersistentComputePolicy('inventory', 'operator'); this.vpsInventory = check.registerVps(input); }
        return { registered: true };
      }
      for (const session of this.sessions.values()) session.policy.heartbeatDevice('vps');
      // One configured VPS worker serves every session. Recover its accepted
      // work first, including stopped sessions, before claiming another queue.
      const running = [...this.sessions.values()].find((session) => session.record.executions.some((run) => run.execution.deviceId === 'vps' && run.execution.state === 'running'));
      if (running) return this.claim(running, 'vps');
      for (const session of this.sessions.values()) {
        if (session.record.state === 'running') { const result = await this.claim(session, 'vps'); if (result.command) return result; }
      }
      return { command: null };
    }
    const id = this.string(body, 'sessionId'); if (!VPS_ID.test(id)) throw new SessionError(400, 'Invalid session ID.');
    const session = this.sessions.get(id); if (!session) throw new SessionError(404, 'Session does not exist.');
    if (body.operation === 'readChunk' || body.operation === 'artifactChunk') {
      const deviceId = this.string(body, 'deviceId');
      if (deviceId === 'vps') { if (!this.agent(credential)) throw new SessionError(403, 'Agent credential required.'); }
      else { const member = this.membership(session, credential); if (!session.policy.view().devices.some((device) => device.id === deviceId && device.ownerId === member.id)) throw new SessionError(403, 'Device owner required.'); }
      const run = session.record.executions.find((item) => item.execution.id === body.executionId);
      if (!run || run.commandId !== body.commandId || run.execution.deviceId !== deviceId || run.execution.generation !== body.generation
        || run.execution.state !== 'running' || run.aclEpoch !== session.record.aclEpoch) throw new SessionError(403, 'Transfer does not match active execution authority.');
      return this.transferChunk(session, run, body);
    }
    if (body.operation === 'join') return this.join(session, body, address);
    if ((body.operation === 'registerDevice' || body.operation === 'claim' || body.operation === 'report') && body.deviceId === 'vps') {
      if (!this.agent(credential)) throw new SessionError(403, 'The configured VPS agent credential is required.');
      if (body.operation === 'registerDevice') { this.vpsInventory = session.policy.registerVps(body.device as PersistentDeviceInput); await this.persist(session); return { registered: true }; }
      if (body.operation === 'claim') return this.claim(session, 'vps');
      return this.report(session, body, 'vps');
    }
    const member = this.membership(session, credential);
    if (!['leave', 'claim', 'report', 'registerDevice', 'share'].includes(body.operation)) session.seen.set(member.id, Date.now());
    session.policy.setMembers(this.members(session));
    const owner = member.id === session.record.ownerId;
    if (body.operation === 'permissions') {
      this.owner(session, member);
      const target = session.record.members.find((candidate) => candidate.id === body.memberId && this.validMember(session, candidate));
      if (!target || target.id === session.record.ownerId) throw new SessionError(400, 'Select a non-owner participant.');
      try { target.permissions = normalizePermissions(body.permissions); } catch (error) { throw new SessionError(400, (error as Error).message); }
      target.readOnly = false;
      await this.persist(session); session.live.invalidate(); return this.view(session, member);
    }
    if (['write', 'mkdir', 'rename', 'remove', 'commitUpload'].includes(body.operation)) this.requireEdit(session, member, this.string(body, 'path'), body.operation === 'rename' ? this.string(body, 'newPath') : undefined);
    if (body.operation === 'uploadChunk') this.requireEdit(session, member, this.string(body, 'path'));
    if (['execute', 'kernel', 'kernelControl', 'select'].includes(body.operation) && !owner && !this.permissions(member).execute) throw new SessionError(403, 'Code execution is disabled for this participant.');
    if (body.operation === 'comments') {
      const visible = new Set(session.workspace.snapshot(owner).entries.map((entry) => entry.path));
      return { comments: (session.record.comments ?? []).filter((comment) => visible.has(comment.path)) };
    }
    if (body.operation === 'addComment' || body.operation === 'removeComment') {
      this.active(session);
      if (!owner && !this.permissions(member).comment) throw new SessionError(403, 'Comments are disabled for this participant.');
      const comments = session.record.comments ??= [];
      if (body.operation === 'removeComment') {
        const comment = comments.find((entry) => entry.id === body.commentId);
        if (!comment) throw new SessionError(404, 'Comment is unavailable.');
        if (!owner) await session.workspace.read(comment.path, false);
        if (!owner && comment.authorId !== member.id) throw new SessionError(403, 'Only the author or owner can remove a comment.');
        session.record.comments = comments.filter((entry) => entry !== comment);
      } else {
        let input: ReturnType<typeof normalizeCommentInput>;
        try { input = normalizeCommentInput(body.comment); } catch (error) { throw new SessionError(400, (error as Error).message); }
        const file = await session.workspace.read(input.path, owner);
        if (comments.length >= MAX_LINE_COMMENTS) throw new SessionError(409, 'Resolve an existing comment before adding more.');
        if (input.cellId) {
          const { doc, epoch } = loadNotebookCrdt(file.content);
          try {
            const cell = sharedNotebook(doc).cells.find((cell) => cell.id === input.cellId);
            if (!cell || input.epoch !== epoch) throw new SessionError(409, 'Notebook cell changed. Select its lines again.');
            const text = doc.getMap<Y.Map<unknown>>('cells').get(cell.id)?.get('source');
            if (!(text instanceof Y.Text)) throw new SessionError(400, 'Invalid comment anchor.');
            try { input = reanchorComment(input, text); } catch (error) { throw new SessionError(409, (error as Error).message); }
          } finally { doc.destroy(); }
        } else {
          const source = Buffer.from(file.content, 'base64').toString('utf8');
          type Replica = { epoch: string; hash: string; update: string; previous?: Replica };
          let replica: Replica;
          try { replica = JSON.parse(await this.readMetadata(path.join(this.directory(id), 'text-replicas', sha(input.path) + '.json'), 25 * 1024 * 1024)) as Replica; }
          catch { throw new SessionError(409, 'Open and synchronize the text file before commenting.'); }
          if (replica.hash !== sha(source) && replica.previous?.hash === sha(source)) replica = replica.previous;
          if (replica.epoch !== input.epoch || replica.hash !== sha(source)) throw new SessionError(409, 'Text file changed. Select its lines again.');
          const doc = new Y.Doc();
          try {
            Y.applyUpdate(doc, Buffer.from(replica.update, 'base64'));
            input = reanchorComment(input, doc.getText('content'));
          } catch (error) { throw new SessionError(409, (error as Error).message); } finally { doc.destroy(); }
        }
        comments.push({ ...input, id: randomUUID(), authorId: member.id, authorName: member.name, createdAt: Date.now() });
      }
      session.record.commentRevision = (session.record.commentRevision ?? 0) + 1;
      await this.persist(session); session.live.invalidate(); return { saved: true };
    }
    if (member.readOnly && !['view', 'heartbeat', 'leave', 'snapshot', 'read', 'execution', 'executions', 'artifacts', 'notebookSync', 'textSync', 'presence'].includes(body.operation)) throw new SessionError(403, 'This invitation grants read access only.');
    if (['uploadChunk', 'commitUpload', 'discardUpload'].includes(body.operation)) {
      const uploadId = this.string(body, 'uploadId'); if (!/^[a-f0-9]{64}$/.test(uploadId)) throw new SessionError(400, 'Invalid upload identifier.');
      const directory = path.join(this.directory(id), 'uploads', 'member-' + member.id);
      if (body.operation === 'uploadChunk') return this.transferChunk(session, undefined, { ...body, operation: 'artifactChunk' }, directory);
      const metadata = path.join(directory, uploadId + '.json'); const filename = path.join(directory, uploadId + '.bin');
      if (body.operation === 'discardUpload') { await rm(metadata, { force: true }); await rm(filename, { force: true }); return { discarded: true }; }
      const name = this.string(body, 'path'); if (!safeJobPath(name)) throw new SessionError(400, 'Invalid upload path.');
      const publication = uploadId + ':write:0';
      if (session.workspace.hasPublication(publication)) { await session.workspace.read(name, owner); return session.workspace.snapshot(owner); }
      const saved = JSON.parse(await this.readMetadata(metadata, 4096)) as { path: string; sha256: string; size: number };
      if (saved.path !== name || saved.sha256 !== body.sha256) throw new SessionError(409, 'Upload identity changed.');
      if (body.visibility !== undefined && (!owner || body.visibility !== 'private')) throw new SessionError(403, 'Only the owner can create a Private file.');
      let snapshot;
      if (name.endsWith('.ipynb')) {
        const content = await this.readMetadata(filename, 32 * 1024 * 1024);
        if (sha(content) !== saved.sha256) throw new SessionError(400, 'Uploaded notebook checksum differs.');
        snapshot = await session.workspace.write(name, Buffer.from(content).toString('base64'), this.revision(body), owner, publication, body.visibility === 'private');
      } else snapshot = await session.workspace.writeStaged(name, filename, saved.size, saved.sha256, this.revision(body), owner, publication, body.visibility === 'private');
      session.live.invalidate(); return snapshot;
    }
    if (body.operation === 'invitations') { this.owner(session, member); return { invitations: (session.record.invitations ?? []).map((invite) => ({ id: invite.id, expiresAt: invite.expiresAt, readOnly: invite.readOnly, revoked: invite.revoked })) }; }
    if (body.operation === 'createInvitation') {
      this.owner(session, member);
      if (!Number.isSafeInteger(body.lifetimeSeconds) || (body.lifetimeSeconds as number) < 60 || (body.lifetimeSeconds as number) > 7 * 86400 || typeof body.readOnly !== 'boolean') throw new SessionError(400, 'Choose an invitation lifetime from 60 seconds to seven days and its permissions.');
      const invitations = (session.record.invitations ?? []).filter((invite) => !invite.revoked && invite.expiresAt > Date.now());
      if (invitations.length >= 64) throw new SessionError(409, 'Invitation limit reached.');
      const secret = token(); const invite: Invitation = { id: randomUUID(), tokenHash: sha(secret), expiresAt: Date.now() + (body.lifetimeSeconds as number) * 1000, readOnly: body.readOnly as boolean, revoked: false };
      session.record.invitations = [...invitations, invite]; await this.persist(session);
      return { id: invite.id, invitationToken: secret, sessionId: session.record.id, expiresAt: invite.expiresAt, readOnly: invite.readOnly };
    }
    if (body.operation === 'revokeInvitation') {
      this.owner(session, member); const invite = session.record.invitations?.find((entry) => entry.id === body.invitationId);
      if (!invite) throw new SessionError(404, 'Invitation is unavailable.');
      invite.revoked = true;
      for (const guest of session.record.members) if (guest.invitationId === invite.id) { guest.revoked = true; session.seen.delete(guest.id); }
      session.policy.setMembers(this.members(session)); this.retireRevokedReporting(session); await this.persist(session); return { revoked: true };
    }
    if (body.operation === 'view' || body.operation === 'heartbeat') { await this.persist(session); return this.view(session, member); }
    if (body.operation === 'leave') { session.live.remove(member.id); session.seen.delete(member.id); session.policy.setMembers(this.members(session)); await this.persist(session); return { left: true }; }
    if (body.operation === 'lifecycle') return this.lifecycle(session, member, this.string(body, 'action'));
    if (body.operation === 'password') {
      this.owner(session, member); session.record.password = await this.password(body.password);
      session.record.invitations = [];
      for (const guest of session.record.members) if (guest.id !== member.id) { guest.revoked = true; session.seen.delete(guest.id); }
      session.policy.setMembers(this.members(session)); this.retireRevokedReporting(session); await this.persist(session); return this.view(session, member);
    }
    if (body.operation === 'revoke' || body.operation === 'role') {
      this.owner(session, member); const target = session.record.members.find((candidate) => candidate.id === body.memberId && !candidate.revoked);
      if (!target || target.id === member.id) throw new SessionError(400, 'Invalid target member.');
      if (body.operation === 'revoke') { target.revoked = true; session.seen.delete(target.id); }
      else { if (body.role !== 'admin' && body.role !== 'member') throw new SessionError(400, 'Invalid role.'); target.role = body.role; }
      session.policy.setMembers(this.members(session)); this.retireRevokedReporting(session); await this.persist(session); return this.view(session, member);
    }
    if (body.operation === 'report') {
      const deviceId = this.string(body, 'deviceId'); const device = session.policy.view().devices.find((candidate) => candidate.id === deviceId);
      if (!device || device.ownerId !== member.id || deviceId === 'vps') throw new SessionError(403, 'Only the device owner can report.');
      return this.report(session, body, deviceId);
    }
    this.active(session);
    if (body.operation === 'executions') {
      const visible = new Set(session.workspace.snapshot(owner).entries.filter((entry) => entry.type === 'file').map((entry) => entry.path));
      return { executions: session.record.executions.filter((run) => !run.kernelCommand && ['queued', 'running'].includes(run.execution.state)
        && visible.has(run.execution.notebook) && (owner || (run.execution.scope !== 'private' && run.aclEpoch === session.record.aclEpoch))).map((run) => ({ ...run.execution, events: [] })) };
    }
    if (body.operation === 'presence') {
      if (!body.path) session.live.update(member.id, undefined);
      else {
        const filename = this.string(body, 'path'); const file = await session.workspace.read(filename, owner);
        const { doc, epoch } = loadNotebookCrdt(file.content);
        try {
          if (body.epoch !== epoch) throw new SessionError(409, 'Notebook was replaced.');
          const cellId = this.string(body, 'cellId'); const text = doc.getMap<Y.Map<unknown>>('cells').get(cellId)?.get('source');
          if (!(text instanceof Y.Text) || !sharedNotebook(doc).cells.some((cell) => cell.id === cellId)) throw new SessionError(404, 'Cell unavailable.');
          const anchor = this.string(body, 'activeLineAnchor'); const offset = resolveRelativeOffset(text, anchor, undefined);
          if (offset === undefined) throw new SessionError(400, 'Invalid presence anchor.');
          if (body.cursor !== undefined && (!body.cursor || typeof body.cursor !== 'object' || Array.isArray(body.cursor))) throw new SessionError(400, 'Invalid presence cursor.');
          const cursor = body.cursor === undefined ? undefined : resolveSharedCursorPosition(text, body.cursor as SharedCursorPosition);
          if (body.cursor !== undefined && !cursor) throw new SessionError(400, 'Invalid presence cursor.');
          session.live.update(member.id, { peer: { peerId: member.id, displayName: member.name, joinOrder: session.record.members.indexOf(member) },
            epoch, readOnly: !!member.readOnly, kernelStatus: 'Idle', activeFile: filename, activeNotebookCellId: cellId,
            activeLineAnchor: anchor, activeLine: text.toString().slice(0, offset).split('\n').length - 1, shareCursor: true, cursorColor: typeof body.cursorColor === 'string' ? commentColor(body.cursorColor) : participantColor(member.id), ...(cursor ? { cursor: createSharedCursorPosition(text, cursor.anchor, cursor.active) } : {}) });
        } finally { doc.destroy(); }
      }
      return { states: session.live.states((filename) => session.workspace.snapshot(owner).entries.some((entry) => entry.path === filename && entry.type === 'file')) };
    }
    if (body.operation === 'textSync') {
      const filename = this.string(body, 'path');
      const file = await session.workspace.read(filename, owner);
      const bytes = Buffer.from(file.content, 'base64');
      if (classifyFile(filename, bytes.length) !== 'text' || !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new SessionError(400, 'Select a UTF-8 text file.');
      const stateFile = path.join(this.directory(id), 'text-replicas', sha(filename) + '.json');
      type Replica = { epoch: string; hash: string; update: string; aclEpoch: number };
      type Saved = Replica & { previous?: Replica };
      let saved: Saved | undefined;
      try {
        saved = JSON.parse(await this.readMetadata(stateFile, 25 * 1024 * 1024)) as Saved;
        if (!saved || typeof saved.epoch !== 'string' || typeof saved.update !== 'string' || typeof saved.hash !== 'string') throw new SyntaxError('Invalid text replica.');
        const probe = new Y.Doc();
        try { Y.applyUpdate(probe, Buffer.from(saved.update, 'base64')); if (sha(probe.getText('content').toString()) !== saved.hash) throw new SyntaxError('Text replica checksum differs.'); }
        finally { probe.destroy(); }
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          if ((error as NodeJS.ErrnoException).code) throw error;
          await rename(stateFile, stateFile + '.invalid-' + randomUUID());
        }
        saved = undefined;
      }
      if (saved?.aclEpoch !== session.record.aclEpoch) saved = undefined;
      const hash = sha(bytes.toString('utf8')); if (saved?.hash !== hash) saved = saved?.previous?.hash === hash ? saved.previous : undefined;
      const doc = new Y.Doc(); const epoch = saved?.epoch ?? randomUUID();
      try {
        if (saved) Y.applyUpdate(doc, Buffer.from(saved.update, 'base64')); else doc.getText('content').insert(0, bytes.toString('utf8'));
        if (body.epoch !== undefined && body.epoch !== epoch) throw new SessionError(409, 'Text file was replaced.');
        const vector = Y.encodeStateVector(doc);
        if (body.update !== undefined) {
          if (!owner && !mayEdit(this.permissions(member), filename)) throw new SessionError(403, 'You do not have permission to edit this file.');
          const update = this.string(body, 'update'); if (update.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(update)) throw new SessionError(413, 'Text update exceeds limits.');
          try { Y.applyUpdate(doc, Buffer.from(update, 'base64')); } catch { throw new SessionError(400, 'Invalid text update.'); }
        }
        const content = doc.getText('content').toString();
        const record: Saved = { epoch, hash: sha(content), aclEpoch: session.record.aclEpoch, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'), ...(saved ? { previous: { epoch: saved.epoch, hash: saved.hash, aclEpoch: saved.aclEpoch, update: saved.update } } : {}) };
        if (Buffer.byteLength(record.update) > 12 * 1024 * 1024) throw new SessionError(413, 'Text replica exceeds limits.');
        // Write ahead: after an uncertain file commit either hash selects its exact replica.
        await this.writeMetadata(stateFile, JSON.stringify(record));
        const revision = content === bytes.toString('utf8') ? file.revision : (await session.workspace.write(filename, Buffer.from(content).toString('base64'), file.revision, owner)).revision;
        if (revision !== file.revision) session.live.broadcast({ kind: 'text', path: filename, epoch, revision, update: Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString('base64') });
        const requestedVector = typeof body.stateVector === 'string' && body.stateVector.length < 65536 ? Buffer.from(body.stateVector, 'base64') : undefined;
        return { epoch, revision, update: Buffer.from(Y.encodeStateAsUpdate(doc, requestedVector)).toString('base64') };
      } finally { doc.destroy(); }
    }
    if (body.operation === 'notebookSync') {
      const filename = this.string(body, 'path');
      if (!filename.endsWith('.ipynb')) throw new SessionError(400, 'Select a notebook.');
      const file = await session.workspace.read(filename, owner);
      const { doc, epoch, template } = loadNotebookCrdt(file.content);
      try {
        if (template.cells.length === 0 && sharedNotebook(doc).cells.length === 0
          && (!template.metadata?.pair_crdt || template.metadata.pair_crdt.bootstrapEmpty === true)
          && body.bootstrapEmpty !== true && body.update === undefined && body.snapshot === undefined && body.intent === undefined && body.stateVector === undefined) {
          throw new SessionError(426, 'Update Pair Notebook to 0.6.6 before opening this new notebook; its unsaved first cell must be preserved.');
        }
        if (body.epoch !== undefined && body.epoch !== epoch) throw new SessionError(409, 'Notebook was replaced. Preserve offline edits and reopen it.');
        const before = Buffer.from(Y.encodeStateAsUpdate(doc));
        const previous = sharedNotebook(doc);
        let intentApplied = false;
        let implicitPresence: PersistentPresence | undefined;
        if (body.intent !== undefined) {
          if (!owner && !mayEdit(this.permissions(member), filename)) throw new SessionError(403, 'You do not have permission to edit this file.');
          const intent = body.intent as { actor: string; sequence: number; cellId: string; baseline: string; changes: TextChange[]; update?: string };
          if (!intent || !/^[A-Za-z0-9_-]{32,64}$/.test(intent.actor) || !Number.isSafeInteger(intent.sequence) || intent.sequence < 1
            || typeof intent.baseline !== 'string' || Buffer.byteLength(intent.baseline) > 2 * 1024 * 1024 || !Array.isArray(intent.changes) || !intent.changes.length || intent.changes.length > 100) throw new SessionError(400, 'Invalid text intent.');
          let end = 0;
          for (const change of [...intent.changes].sort((a, b) => a.offset - b.offset)) {
            if (!Number.isSafeInteger(change.offset) || !Number.isSafeInteger(change.deleteCount) || change.offset < end || change.deleteCount < 0 || change.offset + change.deleteCount > intent.baseline.length || typeof change.insertText !== 'string' || Buffer.byteLength(change.insertText) > 2 * 1024 * 1024) throw new SessionError(400, 'Invalid text changes.');
            end = change.offset + change.deleteCount;
          }
          const ledger = (template.metadata?.pair_crdt?.intents ?? {}) as Record<string, { member: string; sequence: number; digest: string }>;
          const last = ledger[intent.actor]; const digest = sha(JSON.stringify(intent));
          if (last && (last.member !== member.id || (last.sequence === intent.sequence && last.digest !== digest))) throw new SessionError(409, 'Text intent identity was reused.');
          if (!last || intent.sequence > last.sequence) {
            if (intent.sequence !== (last?.sequence ?? 0) + 1 && !intent.update) throw new SessionError(409, 'Text intent sequence is unavailable.');
            const cell = previous.cells.find((item) => item.id === intent.cellId); if (!cell) throw new SessionError(409, 'Cell was removed.');
            const changes = intent.changes;
            const text = doc.getMap<Y.Map<unknown>>('cells').get(cell.id)!.get('source') as Y.Text;
            if (intent.update) {
              if (intent.update.length > 2 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(intent.update)) throw new SessionError(413, 'Text update exceeds limits.');
              try { Y.applyUpdate(doc, Buffer.from(intent.update, 'base64')); } catch { throw new SessionError(400, 'Invalid text update.'); }
              const after = sharedNotebook(doc);
              if (JSON.stringify(after.metadata) !== JSON.stringify(previous.metadata)
                || after.cells.length !== previous.cells.length || after.cells.some((item, index) => {
                  const old = previous.cells[index]!; return item.id !== old.id || item.cell_type !== old.cell_type
                    || JSON.stringify(item.metadata) !== JSON.stringify(old.metadata) || (item.id !== cell.id && item.source !== old.source);
                })) throw new SessionError(400, 'Text update changed another notebook field.');
            } else {
              // Old clients do not send character identities. Never guess the
              // identity of repeated text after concurrent edits.
              if (intent.baseline !== cell.source) throw new SessionError(409, 'Refresh the legacy text baseline before editing.');
              doc.transact(() => { for (const change of [...changes].sort((a, b) => b.offset - a.offset)) { if (change.deleteCount) text.delete(change.offset, change.deleteCount); if (change.insertText) text.insert(change.offset, change.insertText); } });
            }
            const offset = Math.min(text.length, (changes[0]?.offset ?? 0) + (changes[0]?.insertText.length ?? 0));
            const start = offset <= 0 ? 0 : text.toString().lastIndexOf('\n', offset - 1) + 1;
            if (!intent.update) implicitPresence = { peer: { peerId: member.id, displayName: member.name, joinOrder: session.record.members.indexOf(member) }, epoch, readOnly: false,
              kernelStatus: 'Idle', activeFile: filename, activeNotebookCellId: cell.id, activeLineAnchor: encodeRelativeOffset(text, start),
              activeLine: text.toString().slice(0, start).split('\n').length - 1, cursor: createSharedCursorPosition(text, offset, offset), shareCursor: true, cursorColor: typeof body.cursorColor === 'string' ? commentColor(body.cursorColor) : participantColor(member.id) };
            template.metadata ??= {};
            const retained = Object.fromEntries(Object.entries(ledger).filter(([actor]) => actor !== intent.actor).slice(-63));
            template.metadata.pair_crdt = { ...template.metadata.pair_crdt, intents: { ...retained, [intent.actor]: { member: member.id, sequence: intent.sequence, digest } } }; intentApplied = true;
          }
        }
        if (body.update !== undefined) {
          const update = this.string(body, 'update');
          if (update.length > 2 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(update)) throw new SessionError(413, 'CRDT update exceeds limits.');
          try { Y.applyUpdate(doc, Buffer.from(update, 'base64')); } catch { throw new SessionError(400, 'Invalid CRDT update.'); }
        }
        if (body.snapshot !== undefined) {
          if (typeof body.snapshotStateVector !== 'string' || body.snapshotStateVector !== Buffer.from(Y.encodeStateVector(doc)).toString('base64')) throw new SessionError(409, 'Notebook changed before its structural save.');
          const snapshot = body.snapshot as ReturnType<typeof sharedNotebook>;
          // Text uses host-serialized intents; a structural save must not replace unseen input.
          if (!snapshot || !Array.isArray(snapshot.cells) || snapshot.cells.some((cell) => previous.cells.some((old) => old.id === cell.id && old.source !== cell.source))) throw new SessionError(409, 'Reload notebook text before changing its structure.');
          try { editSharedNotebook(doc, snapshot); } catch { throw new SessionError(400, 'Invalid notebook structure.'); }
        }
        if (!owner && !mayEdit(this.permissions(member), filename) && !Buffer.from(Y.encodeStateAsUpdate(doc)).equals(before)) throw new SessionError(403, 'You do not have permission to edit this file.');
        let content: string;
        try { content = saveNotebookCrdt(doc, epoch, template); } catch { throw new SessionError(400, 'Invalid or oversized notebook CRDT.'); }
        const revision = content === file.content && !intentApplied ? file.revision : (await session.workspace.write(filename, content, file.revision, owner, undefined, false, true)).revision;
        const actor = body.intent ? (body.intent as { actor: string }).actor : typeof body.actor === 'string' ? body.actor : undefined;
        const receipt = actor ? template.metadata?.pair_crdt?.intents?.[actor] : undefined;
        const acknowledgedSequence = receipt?.member === member.id ? receipt.sequence : 0;
        if (revision !== file.revision) session.live.broadcast({ kind: 'notebook', path: filename, epoch, revision, update: Buffer.from(Y.encodeStateAsUpdate(doc, Y.encodeStateVectorFromUpdate(before))).toString('base64'), ...(actor && acknowledgedSequence ? { acknowledgement: { actor, sequence: acknowledgedSequence } } : {}) });
        if (implicitPresence) session.live.update(member.id, implicitPresence);
        const vector = typeof body.stateVector === 'string' && body.stateVector.length <= 65536 ? Buffer.from(body.stateVector, 'base64') : undefined;
        let update: string;
        try { update = Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString('base64'); } catch { throw new SessionError(400, 'Invalid CRDT state vector.'); }
        const bootstrapEmpty = sharedNotebook(doc).cells.length === 0 && template.cells.length === 0
          && (!template.metadata?.pair_crdt || template.metadata.pair_crdt.bootstrapEmpty === true);
        return { epoch, revision, update, textProtocol: 'yjs-intents-v1', acknowledgedSequence, bootstrapEmpty, identity: session.workspace.notebookIdentity(filename, owner), ...(body.compact === true ? { cells: [], metadata: {} } : sharedNotebook(doc)) } satisfies NotebookSyncReply;
      } finally { doc.destroy(); }
    }
    if (body.operation === 'snapshot') return session.workspace.snapshot(owner);
    if (body.operation === 'read') return session.workspace.read(this.string(body, 'path'), owner);
    if (body.operation === 'write') {
      if (body.visibility !== undefined && (!owner || body.visibility !== 'private')) throw new SessionError(403, 'Only the owner can create a Private file.');
      return session.workspace.write(this.string(body, 'path'), this.string(body, 'content'), this.revision(body), owner, undefined, body.visibility === 'private');
    }
    if (body.operation === 'mkdir') {
      if (body.visibility !== undefined && (!owner || (body.visibility !== 'public' && body.visibility !== 'private'))) throw new SessionError(403, 'Only the owner can create a directory with explicit visibility.');
      return session.workspace.mkdir(this.string(body, 'path'), this.revision(body), owner, body.visibility as 'public' | 'private' | undefined);
    }
    if (body.operation === 'rename') {
      const source = portableRelativePath(this.string(body, 'path')); const target = portableRelativePath(this.string(body, 'newPath'));
      if (!source || !target) throw new SessionError(400, 'Invalid project path.');
      const entries = session.workspace.snapshot(owner).entries;
      const hidesPublicFiles = owner && entries.some((entry) => entry.visibility === 'public' && (entry.path === source || entry.path.startsWith(`${source}/`)))
        && entries.some((entry) => entry.visibility === 'private' && entry.type === 'directory' && target.startsWith(`${entry.path}/`));
      return session.workspace.rename(source, target, this.revision(body), owner, hidesPublicFiles ? () => this.privacyBarrier(session)
        : undefined).then(async (snapshot) => {
          for (const comment of session.record.comments ?? []) if (comment.path === source || comment.path.startsWith(source + '/')) comment.path = target + comment.path.slice(source.length);
          session.record.commentRevision = (session.record.commentRevision ?? 0) + 1;
          for (const run of session.record.executions) if (['queued', 'running'].includes(run.execution.state)
            && (run.execution.notebook === source || run.execution.notebook.startsWith(`${source}/`))) {
            run.execution.notebook = target + run.execution.notebook.slice(source.length);
          }
          await this.persist(session); return snapshot;
        });
    }
    if (body.operation === 'remove') {
      const filename = this.string(body, 'path');
      const snapshot = await session.workspace.remove(filename, this.revision(body), owner);
      session.record.comments = (session.record.comments ?? []).filter((comment) => comment.path !== filename && !comment.path.startsWith(filename + '/'));
      session.record.commentRevision = (session.record.commentRevision ?? 0) + 1;
      await this.persist(session); return snapshot;
    }
    if (body.operation === 'visibility') {
      this.owner(session, member); if (body.visibility !== 'public' && body.visibility !== 'private') throw new SessionError(400, 'Invalid visibility.');
      // Commit the prospective privacy barrier before publishing changed ACLs.
      return session.workspace.setVisibility(this.string(body, 'path'), body.visibility, this.revision(body), () => this.privacyBarrier(session));
    }
    if (body.operation === 'settings') { if (typeof body.allowMemberSwitch !== 'boolean') throw new SessionError(400, 'Invalid switching setting.'); session.policy.setAllowMemberSwitch(member.id, body.allowMemberSwitch); }
    else if (body.operation === 'registerDevice') session.policy.registerDevice(member.id, body.device as PersistentDeviceInput);
    else if (body.operation === 'share') { if (typeof body.enabled !== 'boolean') throw new SessionError(400, 'Invalid sharing setting.'); session.policy.share(member.id, this.string(body, 'deviceId'), body.enabled); }
    else if (body.operation === 'select') {
      const selected = session.policy.select(member.id, body.target as { deviceId: string; gpuUuid?: string });
      await this.persist(session); return { ...this.view(session, member), ...(selected.consent ? { consent: selected.consent } : {}) };
    }
    else if (body.operation === 'consent') { if (typeof body.approved !== 'boolean') throw new SessionError(400, 'Invalid consent decision.'); session.policy.decideConsent(member.id, this.string(body, 'consentId'), body.approved); }
    else if (body.operation === 'revokeConsent') session.policy.revokeConsent(member.id, this.string(body, 'consentId'));
    else if (body.operation === 'kernelControl') return this.kernelControl(session, member, body);
    else if (body.operation === 'execute' || body.operation === 'kernel') {
      if (body.operation === 'kernel' && (body.command === 'interrupt' || body.command === 'inputReply')) return this.kernelControl(session, member, body);
      return this.execute(session, member, body);
    }
    else if (body.operation === 'execution') {
      const run = session.record.executions.find((candidate) => candidate.execution.id === body.executionId || (candidate.requestId === body.requestId && candidate.execution.requesterId === member.id))
        ?? (typeof body.executionId === 'string' ? await session.history.lookupExecution(body.executionId) : typeof body.requestId === 'string' ? await session.history.lookupRequest(body.requestId) : undefined);
      if (!run || (run.execution.scope === 'private' && !owner)) throw new SessionError(404, 'Execution does not exist.');
      if (run.aclEpoch !== session.record.aclEpoch && !owner) throw new SessionError(403, 'Execution results predate a workspace privacy change.');
      if (!owner) await session.workspace.read(run.execution.notebook, false); return run.execution;
    }
    else if (body.operation === 'artifacts') {
      const run = session.record.executions.find((candidate) => candidate.execution.id === body.executionId) ?? (typeof body.executionId === 'string' ? await session.history.lookupExecution(body.executionId) : undefined);
      if (!run || (run.execution.scope === 'private' && !owner) || (run.aclEpoch !== session.record.aclEpoch && !owner)) throw new SessionError(404, 'Execution artifacts are unavailable.');
      if (!owner) await session.workspace.read(run.execution.notebook, false);
      try { return JSON.parse(await this.readMetadata(path.join(this.directory(id), 'results', `${run.execution.id}.json`), 8 * 1024 * 1024)) as unknown; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { files: [], removedFiles: [], expired: true }; throw error; }
    }
    else if (body.operation === 'claim' || body.operation === 'report') {
      const deviceId = this.string(body, 'deviceId'); const device = session.policy.view().devices.find((candidate) => candidate.id === deviceId);
      if (!device || device.ownerId !== member.id || deviceId === 'vps') throw new SessionError(403, 'Only the device owner can claim or report.');
      if (body.operation === 'claim') return this.claim(session, deviceId); return this.report(session, body, deviceId);
    } else throw new SessionError(404, 'Unknown persistent operation.');
    await this.persist(session); return this.view(session, member);
  }

  private async join(session: Session, body: PersistentRpcRequest, address: string): Promise<PersistentMembership> {
    this.active(session); const key = `${address}:${session.record.id}`; const failure = this.failures.get(key);
    if (failure && failure.count >= 5 && failure.until > Date.now()) throw new SessionError(429, 'Too many failed joins. Try later.');
    const value = typeof body.password === 'string' && body.password.length <= 1024 ? body.password : '';
    const actual = await scrypt(value, session.record.password.salt);
    if (!timingSafeEqual(actual, Buffer.from(session.record.password.hash, 'hex'))) {
      if (this.failures.size >= 1024) this.failures.delete(this.failures.keys().next().value!);
      this.failures.set(key, { count: (failure?.count ?? 0) + 1, until: Date.now() + 60_000 }); throw new SessionError(401, 'Password is incorrect.');
    }
    this.failures.delete(key);
    return this.addMember(session, body);
  }

  private async addMember(session: Session, body: PersistentRpcRequest, invite?: Invitation): Promise<PersistentMembership> {
    const name = this.string(body, 'name'); if (!visibleVpsText(name, 120)) throw new SessionError(400, 'Invalid participant name.');
    session.record.members = session.record.members.filter((member) => this.validMember(session, member));
    session.policy.setMembers(this.members(session)); session.policy.pruneRetiredDevices(session.record.executions.filter((run) => run.execution.state === 'queued' || run.execution.state === 'running').map((run) => run.execution.deviceId));
    if (session.record.members.length >= 128) throw new SessionError(409, 'Active membership limit reached.');
    const memberId = randomUUID(); const secret = token(); session.record.members.push({ id: memberId, name, role: 'member', tokenHash: sha(secret), revoked: false, ...(invite ? { invitationId: invite.id, expiresAt: invite.expiresAt, readOnly: invite.readOnly } : {}) });
    session.seen.set(memberId, Date.now()); session.policy.setMembers(this.members(session)); await this.persist(session);
    return { sessionId: session.record.id, memberId, token: secret, name: session.record.name };
  }

  private async lifecycle(session: Session, member: MemberRecord, action: string): Promise<unknown> {
    this.administrator(member);
    if (!['start', 'stop', 'restart', 'delete'].includes(action)) throw new SessionError(400, 'Invalid lifecycle action.');
    if (action === 'delete') { session.record.state = 'stopped'; await this.persist(session); await rm(this.directory(session.record.id), { recursive: true }); session.live.close(); this.sessions.delete(session.record.id); return { deleted: true }; }
    if (action === 'stop' || action === 'restart') {
      session.record.state = 'stopped';
      for (const run of session.record.executions) if (run.execution.state === 'queued') { run.execution.state = 'interrupted'; run.execution.error = 'Session stopped before execution was claimed.'; }
      session.seen.clear(); session.policy.setMembers(this.members(session)); session.policy.invalidateKernels(); await this.persist(session);
    }
    if (action === 'start' || action === 'restart') session.record.state = 'running';
    await this.persist(session); return this.view(session, member);
  }

  private notebook(encoded: string): Notebook {
    let value: Notebook; try { value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Notebook; } catch { throw new SessionError(400, 'Notebook JSON is invalid.'); }
    if (!value || !Array.isArray(value.cells) || value.cells.length > 10000) throw new SessionError(400, 'Notebook cells are invalid.'); return value;
  }
  private source(cell: NotebookCell): string {
    if (typeof cell.source === 'string') return cell.source;
    if (Array.isArray(cell.source) && cell.source.every((line) => typeof line === 'string')) return cell.source.join('');
    throw new SessionError(400, 'Code cell source is invalid.');
  }
  private async execute(session: Session, member: MemberRecord, body: PersistentRpcRequest): Promise<PersistentExecution> {
    const requestId = body.operation === 'kernel' && body.requestId === undefined ? randomUUID() : this.string(body, 'requestId'); if (!VPS_ID.test(requestId)) throw new SessionError(400, 'Invalid execution request ID.');
    const existing = session.record.executions.find((run) => run.requestId === requestId) ?? await session.history.lookupRequest(requestId);
    if (existing) {
      if (existing.execution.requesterId !== member.id || existing.execution.notebook !== body.notebook || existing.execution.cellIndex !== (body.operation === 'kernel' ? 0 : body.cellIndex)) throw new SessionError(409, 'Execution request ID has different input.');
      if (body.expectedSourceHash !== undefined && body.expectedSourceHash !== existing.sourceHash) throw new SessionError(409, 'Execution request ID has different source.');
      if (existing.execution.scope === 'private' && member.id !== session.record.ownerId) throw new SessionError(404, 'Execution does not exist.');
      if (body.expectedCellId !== undefined && body.expectedCellId !== existing.cellIdentity) throw new SessionError(409, 'Execution request ID has different cell identity.');
      if (existing.aclEpoch !== session.record.aclEpoch && member.id !== session.record.ownerId) throw new SessionError(403, 'Execution predates a privacy change.');
      await session.workspace.read(existing.execution.notebook, member.id === session.record.ownerId);
      return existing.execution;
    }
    await this.trimHistory(session, true);
    if (session.record.executions.filter((run) => run.execution.state === 'queued' || run.execution.state === 'running').length >= 4) throw new SessionError(409, 'Four executions are already pending in this session. Wait for one to finish.');
    const notebookPath = this.string(body, 'notebook'); if (!notebookPath.endsWith('.ipynb')) throw new SessionError(400, 'Select a notebook.');
    const file = await session.workspace.read(notebookPath, member.id === session.record.ownerId);
    const snapshot = session.workspace.snapshot(member.id === session.record.ownerId);
    const privateExecution = snapshot.entries.find((entry) => entry.path === notebookPath)?.visibility === 'private';
    const scope = privateExecution ? 'private' : 'public';
    const notebookIdentity = session.workspace.notebookIdentity(notebookPath, member.id === session.record.ownerId);
    if (body.expectedNotebookIdentity !== undefined && body.expectedNotebookIdentity !== notebookIdentity) throw new SessionError(409, 'Notebook was replaced before execution.');
    if (body.expectedGeneration !== undefined && body.expectedGeneration !== session.policy.view().generation) throw new SessionError(409, 'Compute changed before execution.');
    const scopedAdmission = body.expectedNotebookIdentity === notebookIdentity && typeof body.expectedCellId === 'string' && typeof body.expectedSourceHash === 'string';
    if (body.operation === 'execute' && file.revision !== this.revision(body) && !scopedAdmission) throw new SessionError(409, 'Notebook snapshot changed. Refresh before execution.');
    const notebook = this.notebook(file.content); const index = body.operation === 'kernel' ? 0 : body.cellIndex;
    let source = ''; let cellIdentity = 'kernel-control';
    if (body.operation === 'execute') {
      if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= notebook.cells.length) throw new SessionError(400, 'Invalid notebook cell.');
      const cell = notebook.cells[index as number]!;
      if (cell.cell_type !== 'code') throw new SessionError(400, 'Only a code cell can execute.');
      source = this.source(cell); cellIdentity = cell.id ?? `index:${index}`;
      if (body.expectedCellId !== undefined && body.expectedCellId !== cellIdentity) throw new SessionError(409, 'The displayed cell identity changed.');
      if (body.expectedSourceHash !== undefined && (typeof body.expectedSourceHash !== 'string'
        || !/^[a-f0-9]{64}$/.test(body.expectedSourceHash) || body.expectedSourceHash !== sha(source))) {
        throw new SessionError(409, 'The saved cell differs from the editor. Reload or save before execution.');
      }
    }
    const selected = session.policy.view();
    const target = privateExecution && selected.devices.find((device) => device.id === selected.target.deviceId)?.ownerId !== member.id ? { deviceId: 'vps' } : selected.target;
    session.policy.assertExecutionTarget(member.id, target);
    const generation = selected.generation; const id = randomUUID(); const commandId = randomUUID();
    const raw: Record<string, unknown> = { command: 'execute', requestId: commandId, codeBase64: Buffer.from(source).toString('base64') };
    if (body.operation === 'kernel') {
      if (!['restart', 'release'].includes(String(body.command))) throw new SessionError(400, 'Invalid queued kernel control.');
      raw.command = body.command;
    }
    const execution: PersistentExecution = { id, notebook: notebookPath, cellIndex: index as number, requesterId: member.id, deviceId: target.deviceId,
      ...(target.gpuUuid ? { gpuUuid: target.gpuUuid } : {}), generation, state: 'queued', events: [], scope, cellId: cellIdentity, sourceHash: sha(source), admittedRevision: file.revision };
    const files = await session.workspace.computeSnapshot(path.join(this.directory(session.record.id), 'command-files', commandId), privateExecution);
    const command: PersistentCommand = { id: commandId, executionId: id, sessionId: session.record.id, kernelId: `${session.record.id}:${scope}:${generation}:${notebookIdentity}`, scope,
      generation, deviceId: target.deviceId, ...(target.gpuUuid ? { gpuUuid: target.gpuUuid } : {}),
      files: files.map((item) => ({ ...item, version: snapshot.entries.find((entry) => entry.path === item.path)?.version ?? 0 })), command: raw };
    if (Buffer.byteLength(JSON.stringify(command)) > MAX_COMMAND_BYTES) throw new SessionError(413, 'Compute command exceeds limits.');
    await this.writeMetadata(path.join(this.directory(session.record.id), 'commands', `${commandId}.json`), JSON.stringify(command));
    const run: ExecutionRecord = { execution, requestId, commandId, sourceHash: sha(source), cellIdentity, notebookIdentity, notebookVersion: snapshot.entries.find((entry) => entry.path === notebookPath)!.version, offset: 0, reports: [], aclEpoch: session.record.aclEpoch, controls: [],
      ...(body.operation === 'kernel' ? { kernelCommand: body.command as 'restart' | 'release' } : {}) };
    await session.history.reserve(run); session.record.executions.push(run);
    await this.persist(session); this.publishExecution(session, run); return execution;
  }

  private publishExecution(session: Session, run: ExecutionRecord): void {
    if (run.kernelCommand) return;
    const inline = Buffer.byteLength(JSON.stringify(run.execution)) <= 64 * 1024;
    session.live.broadcast({ kind: 'execution', path: run.execution.notebook, id: run.execution.id, ...(inline ? { execution: run.execution } : {}) },
      (memberId) => memberId === session.record.ownerId || (run.execution.scope !== 'private' && run.aclEpoch === session.record.aclEpoch));
  }

  private async kernelControl(session: Session, member: MemberRecord, body: PersistentRpcRequest): Promise<PersistentExecution> {
    const run = [...session.record.executions].reverse().find((candidate) => ['queued', 'running'].includes(candidate.execution.state) && (candidate.execution.id === body.executionId || candidate.execution.notebook === body.notebook));
    if (!run || (run.execution.scope === 'private' && member.id !== session.record.ownerId)) throw new SessionError(409, 'No running kernel execution matches this control.');
    if (run.aclEpoch !== session.record.aclEpoch && member.id !== session.record.ownerId) throw new SessionError(403, 'Kernel execution predates a privacy change.');
    await session.workspace.read(run.execution.notebook, member.id === session.record.ownerId);
    if (run.execution.requesterId !== member.id && member.role === 'member') throw new SessionError(403, 'Only the execution requester or an administrator can control it.');
    const input = body.operation === 'kernelControl' ? body.command as Record<string, unknown> : { command: body.command, value: body.value };
    if (!input || (input.command !== 'interrupt' && input.command !== 'inputReply')) throw new SessionError(400, 'Invalid active kernel control.');
    if (run.execution.state === 'queued') {
      if (input.command !== 'interrupt') throw new SessionError(409, 'Kernel has not started.');
      run.execution.state = 'interrupted'; run.execution.error = 'Cancelled before kernel execution.';
      await this.persist(session); this.publishExecution(session, run); return run.execution;
    }
    if (input.command === 'inputReply' && (typeof input.value !== 'string' || input.value.length > 65536)) throw new SessionError(400, 'Invalid kernel input.');
    if (run.controls.length >= 128) throw new SessionError(409, 'Kernel control limit reached.');
    const id = randomUUID();
    const control = { id, command: { command: input.command, requestId: id,
      ...(input.command === 'inputReply' ? { value: input.value } : {}) } };
    if (Buffer.byteLength(JSON.stringify([...run.controls, control])) > MAX_CONTROL_BYTES) throw new SessionError(409, 'Kernel control byte limit reached.');
    run.controls.push(control); await this.persist(session); return { ...run.execution, events: [] };
  }

  private async claim(session: Session, deviceId: string): Promise<{ command: PersistentCommand | null; controls?: { id: string; command: Record<string, unknown> }[]; recoverOnly?: boolean }> {
    session.policy.setMembers(this.members(session));
    session.policy.heartbeatDevice(deviceId);
    const running = session.record.executions.find((run) => run.execution.deviceId === deviceId && run.execution.state === 'running');
    if (running) {
      const command = JSON.parse(await this.readMetadata(path.join(this.directory(session.record.id), 'commands', `${running.commandId}.json`), MAX_COMMAND_BYTES)) as PersistentCommand;
      return { command: { ...command, files: [], command: {} }, controls: running.controls, recoverOnly: true };
    }
    this.active(session);
    if (deviceId === 'vps' && [...this.sessions.values()].some((candidate) => candidate !== session
      && candidate.record.executions.some((run) => run.execution.deviceId === 'vps' && run.execution.state === 'running'))) return { command: null };
    for (const run of session.record.executions) {
      if (run.execution.deviceId !== deviceId || run.execution.state !== 'queued') continue;
      try {
        const latest = session.policy.view();
        const requester = session.record.members.find((member) => member.id === run.execution.requesterId);
        if (!requester || !this.validMember(session, requester) || (requester.id !== session.record.ownerId && !this.permissions(requester).execute)) throw new SessionError(403, 'Execution permission revoked before launch.');
        if (latest.generation !== run.execution.generation || (run.execution.scope !== 'private' && (latest.target.deviceId !== deviceId || latest.target.gpuUuid !== run.execution.gpuUuid)) || run.aclEpoch !== session.record.aclEpoch) throw new SessionError(409, 'Queued execution selection changed.');
        if (run.execution.scope === 'private' && deviceId !== 'vps' && latest.devices.find((device) => device.id === deviceId)?.ownerId !== session.record.ownerId) throw new SessionError(403, 'Private execution requires the owner machine or VPS.');
        session.policy.assertExecutionTarget(run.execution.requesterId, { deviceId, ...(run.execution.gpuUuid ? { gpuUuid: run.execution.gpuUuid } : {}) }); const file = await session.workspace.read(run.execution.notebook, run.execution.scope === 'private');
        void file;
      }
      catch { run.execution.state = 'failed'; run.execution.error = 'Execution authority or public notebook access was revoked before launch.'; await this.persist(session); continue; }
      run.execution.state = 'running'; await this.persist(session); this.publishExecution(session, run);
      return { command: JSON.parse(await this.readMetadata(path.join(this.directory(session.record.id), 'commands', `${run.commandId}.json`), MAX_COMMAND_BYTES)) as PersistentCommand };
    }
    return { command: null };
  }

  private async report(session: Session, body: PersistentRpcRequest, deviceId: string): Promise<{ offset: number }> {
    const run = session.record.executions.find((candidate) => candidate.execution.id === body.executionId)
      ?? (typeof body.executionId === 'string' ? await session.history.lookupExecution(body.executionId) : undefined);
    if (!run || run.commandId !== body.commandId || run.execution.deviceId !== deviceId || run.execution.generation !== body.generation) throw new SessionError(403, 'Report does not match the claimed command.');
    if (!Number.isSafeInteger(body.offset) || (body.offset as number) < 0 || !Array.isArray(body.events) || body.events.length > 1024
      || body.events.some((event) => !event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string')
      || (body.error !== undefined && (typeof body.error !== 'string' || body.error.length > 2000))
      || !['running', 'completed', 'failed', 'interrupted'].includes(String(body.state))) throw new SessionError(400, 'Invalid execution report.');
    if (Buffer.byteLength(JSON.stringify({ files: body.files, removedFiles: body.removedFiles })) > 8 * 1024 * 1024) throw new SessionError(413, 'Returned artifacts exceed limits.');
    const digest = sha(JSON.stringify({ events: body.events, state: body.state, error: body.error, files: body.files, removedFiles: body.removedFiles }));
    const previous = run.reports.find((report) => report.offset === body.offset && report.digest === digest);
    if (previous) { if (run.mergePending) await this.finishResultMerge(session, run); return { offset: previous.end }; }
    if (run.execution.state !== 'running' || run.offset !== body.offset) throw new SessionError(409, 'Execution report offset or state is stale.');
    const events = body.events as Record<string, unknown>[];
    const combined = [...run.execution.events, ...events];
    const outputLimited = Buffer.byteLength(JSON.stringify(combined)) > MAX_EVENTS_BYTES;
    let retained = combined;
    if (outputLimited) {
      // Bound retained output without rejecting the terminal receipt forever.
      retained = []; let size = 2;
      for (const event of combined) { const bytes = Buffer.byteLength(JSON.stringify(event)) + 1; if (size + bytes > MAX_EVENTS_BYTES - 32 * 1024) break; retained.push(event); size += bytes; }
      retained.push({ type: 'channelError', channel: 'output', message: 'Kernel output exceeded the server retention limit; some output was omitted.' });
    }
    await this.trimHistory(session, false, Buffer.byteLength(JSON.stringify(events)), run.execution.id);
    if (events.some((event) => event.requestId !== undefined && event.requestId !== run.commandId && !run.controls.some((control) => control.id === event.requestId))) throw new SessionError(403, 'Event belongs to another command.');
    const terminalMerge = body.state === 'completed' || body.state === 'failed';
    if (terminalMerge || body.files !== undefined || body.removedFiles !== undefined) await this.writeMetadata(path.join(this.directory(session.record.id), 'results', `${run.execution.id}.json`), JSON.stringify({ files: body.files ?? [], removedFiles: body.removedFiles ?? [] }));
    const before = { ...run, mergePending: run.mergePending };
    run.execution = { ...run.execution, events: retained, state: body.state as PersistentExecution['state'],
      ...(body.error !== undefined ? { error: body.error as string } : outputLimited ? { error: 'Kernel output exceeded the server retention limit; some output was omitted.' } : {}) };
    run.offset += events.length;
    run.mergePending = terminalMerge;
    if (body.state !== 'running') run.controls = [];
    run.reports = [...run.reports.slice(-4095), { offset: body.offset as number, digest, end: run.offset }];
    try { await this.persist(session); }
    catch (error) { Object.assign(run, before); throw error; }
    if (run.mergePending) await this.finishResultMerge(session, run);
    await this.trimHistory(session); await this.persist(session); this.publishExecution(session, run); return { offset: run.offset };
  }

  private async transferChunk(session: Session, run: ExecutionRecord | undefined, body: PersistentRpcRequest, memberDirectory?: string): Promise<unknown> {
    const name = this.string(body, 'path'); if (!safeJobPath(name)) throw new SessionError(400, 'Invalid transfer path.');
    const offset = body.offset; if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new SessionError(400, 'Invalid chunk offset.');
    if (body.operation === 'readChunk') {
      if (!run) throw new SessionError(403, 'An active execution is required.');
      const command = JSON.parse(await this.readMetadata(path.join(this.directory(session.record.id), 'commands', run.commandId + '.json'), MAX_COMMAND_BYTES)) as PersistentCommand;
      const file = command.files.find((item) => item.path === name); if (!file || file.content !== undefined || !file.sha256 || file.size === undefined || (offset as number) > file.size) throw new SessionError(404, 'Pinned input unavailable.');
      const filename = path.join(this.directory(session.record.id), 'command-files', run.commandId, sha(name)); await this.safeDirectories(path.dirname(filename));
      const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat(); if (!info.isFile() || info.nlink !== 1 || info.size !== file.size) throw new SessionError(409, 'Pinned input changed.');
        const buffer = Buffer.alloc(Math.min(256 * 1024, file.size - (offset as number)));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset as number);
        return { content: buffer.subarray(0, bytesRead).toString('base64'), offset: (offset as number) + bytesRead, size: file.size, sha256: file.sha256 };
      } finally { await handle.close(); }
    }
    const uploadId = this.string(body, 'uploadId'); const hash = this.string(body, 'sha256'); const size = body.size;
    if (!/^[a-f0-9]{64}$/.test(uploadId) || !/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(size) || (size as number) < 0 || (size as number) > 128 * 1024 * 1024 || (!memberDirectory && name.endsWith('.ipynb'))) throw new SessionError(400, 'Invalid artifact identity.');
    const content = this.string(body, 'content'); if (content.length > 350_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw new SessionError(413, 'Artifact chunk exceeds limits.');
    const bytes = Buffer.from(content, 'base64'); if ((offset as number) + bytes.length > (size as number)) throw new SessionError(400, 'Artifact chunk exceeds size.');
    const directory = memberDirectory ?? path.join(this.directory(session.record.id), 'uploads', run!.execution.id); await mkdir(directory, { recursive: true, mode: 0o700 }); await this.safeDirectories(directory);
    if (memberDirectory) {
      // Interrupted editor processes cannot leave the upload quota occupied indefinitely.
      for (const entry of await readdir(directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(entry) || entry === uploadId + '.json') continue;
        const filename = path.join(directory, entry); const info = await lstat(filename);
        if (info.isFile() && info.nlink === 1 && Date.now() - info.mtimeMs > 10 * 60_000) {
          await rm(filename); await rm(path.join(directory, entry.slice(0, -5) + '.bin'), { force: true });
        }
      }
    }
    const metadata = path.join(directory, uploadId + '.json');
    const identity = { path: name, sha256: hash, size, version: body.version };
    try { if (await this.readMetadata(metadata, 4096) !== JSON.stringify(identity)) throw new SessionError(409, 'Artifact upload identity changed.'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const entries = (await readdir(directory)).filter((entry) => entry.endsWith('.json'));
      let total = size as number;
      for (const entry of entries) total += (JSON.parse(await this.readMetadata(path.join(directory, entry), 4096)) as { size: number }).size;
      if (entries.length >= 256 || total > 128 * 1024 * 1024) throw new SessionError(413, 'Artifact transfer quota exceeded.');
      await this.writeMetadata(metadata, JSON.stringify(identity));
    }
    const target = path.join(directory, uploadId + '.bin'); const handle = await open(target, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const info = await handle.stat(); if (!info.isFile() || info.nlink !== 1 || info.size < (offset as number)) throw new SessionError(409, 'Artifact chunk is out of order.');
      let written = Math.min(bytes.length, info.size - (offset as number));
      if (written) {
        const existing = Buffer.alloc(written); const read = await handle.read(existing, 0, existing.length, offset as number);
        if (read.bytesRead !== written || !existing.equals(bytes.subarray(0, written))) throw new SessionError(409, 'Artifact retry changed bytes.');
      }
      while (written < bytes.length) {
        const result = await handle.write(bytes, written, bytes.length - written, (offset as number) + written);
        if (!result.bytesWritten) throw new Error('Artifact chunk write made no progress.');
        written += result.bytesWritten;
      }
      await handle.sync();
      if (memberDirectory) { const now = new Date(); await utimes(metadata, now, now); }
      return { offset: (offset as number) + bytes.length };
    } finally { await handle.close(); }
  }

  private async finishResultMerge(session: Session, run: ExecutionRecord): Promise<void> {
    // Terminal receipt and artifacts precede project publication. A crash in
    // between is reconciled on startup or by the same report acknowledgement.
    if (run.aclEpoch === session.record.aclEpoch) {
      const result = JSON.parse(await this.readMetadata(path.join(this.directory(session.record.id), 'results', `${run.execution.id}.json`), 8 * 1024 * 1024)) as { files?: unknown; removedFiles?: unknown };
      await this.saveOutputs(session, run);
      await this.saveResults(session, run, result.files, result.removedFiles);
      if (run.execution.error && run.execution.state === 'completed') run.execution.state = 'failed';
    }
    run.mergePending = false;
    try { await this.persist(session); }
    catch (error) { run.mergePending = true; throw error; }
    await this.retainResultPublications(session);
  }

  private outputPublicationId(run: ExecutionRecord): string {
    // Returned artifact writes occupy indexes 0..255; reserve 256 for outputs.
    return `${run.execution.id}:write:256`;
  }
  private sameNotebookScope(first: ExecutionRecord, second: ExecutionRecord): boolean {
    return first.execution.notebook === second.execution.notebook && first.execution.scope === second.execution.scope
      && first.execution.generation === second.execution.generation && first.aclEpoch === second.aclEpoch;
  }
  private hasOutputDependents(session: Session, publisher: ExecutionRecord): boolean {
    return !!publisher.outputPublication && session.record.executions.some((run) => run !== publisher && this.sameNotebookScope(run, publisher)
      && (run.mergePending || run.execution.state === 'queued' || run.execution.state === 'running')
      && run.notebookVersion <= publisher.outputPublication!.fromVersion);
  }
  private async retainResultPublications(session: Session): Promise<void> {
    await session.workspace.retainPublications(session.record.executions.filter((run) => run.mergePending).map((run) => run.execution.id),
      session.record.executions.filter((run) => this.hasOutputDependents(session, run)).map((run) => this.outputPublicationId(run)));
  }
  private hasOutputLineage(session: Session, run: ExecutionRecord, currentVersion: number | undefined): boolean {
    let version = run.notebookVersion;
    const publishers = session.record.executions.filter((candidate) => candidate.outputPublication && this.sameNotebookScope(candidate, run))
      .sort((first, second) => first.outputPublication!.fromVersion - second.outputPublication!.fromVersion);
    for (const publisher of publishers) {
      const publication = publisher.outputPublication!;
      if (publication.fromVersion === version && session.workspace.hasPublication(this.outputPublicationId(publisher))) version = publication.toVersion;
    }
    return version === currentVersion;
  }

  private async saveOutputs(session: Session, run: ExecutionRecord): Promise<void> {
    if (run.kernelCommand) return;
    try {
      if (run.outputPublication && session.workspace.hasPublication(this.outputPublicationId(run))) return;
      const privateExecution = run.execution.scope === 'private';
      const file = await session.workspace.read(run.execution.notebook, privateExecution); const notebook = this.notebook(file.content);
      const version = session.workspace.snapshot(privateExecution).entries.find((entry) => entry.path === run.execution.notebook)?.version;
      if (version === undefined || (run.notebookIdentity ? session.workspace.notebookIdentity(run.execution.notebook, privateExecution) !== run.notebookIdentity : !this.hasOutputLineage(session, run, version))) return;
      const cell = notebook.cells[run.execution.cellIndex]; if (!cell || cell.cell_type !== 'code' || (cell.id ?? `index:${run.execution.cellIndex}`) !== run.cellIdentity || sha(this.source(cell)) !== run.sourceHash) return;
      const rendered = persistentNotebookOutputs(run.execution.events);
      cell.outputs = rendered.outputs; cell.execution_count = rendered.executionCount;
      const previous = run.outputPublication;
      run.outputPublication = { fromVersion: version, toVersion: file.revision + 1 };
      try { await this.persist(session); }
      catch (error) { if (previous) run.outputPublication = previous; else delete run.outputPublication; throw error; }
      await session.workspace.write(run.execution.notebook, Buffer.from(JSON.stringify(notebook, null, 2)).toString('base64'), file.revision, privateExecution, this.outputPublicationId(run), privateExecution, true);
    } catch (error) {
      if (!(error instanceof PersistentStorageError) || error.code === 'CORRUPT_STORAGE') throw error;
      run.execution.error = 'Notebook outputs could not be merged; the execution result remains available.';
    }
  }
  private async saveResults(session: Session, run: ExecutionRecord, value: unknown, removed: unknown): Promise<void> {
    const privateExecution = run.execution.scope === 'private';
    if (value !== undefined && (!Array.isArray(value) || value.length > 256)) { run.execution.error = 'Returned files exceed result limits.'; return; }
    for (const [index, item] of ((value ?? []) as { path?: unknown; content?: unknown; version?: unknown; uploadId?: unknown; size?: unknown; sha256?: unknown }[]).entries()) {
      if (!item || !safeJobPath(item.path) || (typeof item.content !== 'string' && typeof item.uploadId !== 'string') || !Number.isSafeInteger(item.version) || item.path.endsWith('.ipynb')) continue;
      const snapshot = session.workspace.snapshot(privateExecution); const current = snapshot.entries.find((entry) => entry.path === item.path);
      if (privateExecution && current && current.visibility !== 'private') continue;
      const publicationId = `${run.execution.id}:write:${index}`;
      const matches = async (): Promise<boolean> => {
        if (current?.type !== 'file') return false;
        const content = (await session.workspace.read(item.path as string, privateExecution)).content;
        return typeof item.content === 'string' ? content === item.content : typeof item.sha256 === 'string' && createHash('sha256').update(Buffer.from(content, 'base64')).digest('hex') === item.sha256;
      };
      if (session.workspace.hasPublication(publicationId)) {
        if (!await matches()) {
          run.execution.error = 'Returned file conflicts with a newer server version; execution events remain available.';
        }
        continue;
      }
      if ((current?.version ?? 0) !== item.version) {
        // A previous merge may have published this exact content before a
        // crash. Acknowledge it without overwriting a subsequent different edit.
        if (await matches()) continue;
        run.execution.error = 'Returned file conflicts with a newer server version; execution events remain available.'; continue;
      }
      try {
        if (typeof item.uploadId === 'string' && /^[a-f0-9]{64}$/.test(item.uploadId) && typeof item.sha256 === 'string' && Number.isSafeInteger(item.size)) {
          const directory = path.join(this.directory(session.record.id), 'uploads', run.execution.id); await this.safeDirectories(directory);
          const identity = JSON.parse(await this.readMetadata(path.join(directory, item.uploadId + '.json'), 4096)) as { path: string; sha256: string; size: number; version: number };
          if (identity.path !== item.path || identity.sha256 !== item.sha256 || identity.size !== item.size || identity.version !== item.version) throw new SessionError(400, 'Artifact receipt differs from upload.');
          await session.workspace.writeStaged(item.path, path.join(directory, item.uploadId + '.bin'), item.size as number, item.sha256, snapshot.revision, privateExecution, publicationId, privateExecution);
        } else if (typeof item.content === 'string') await session.workspace.write(item.path, item.content, snapshot.revision, privateExecution, publicationId, privateExecution);
        else throw new SessionError(400, 'Invalid artifact receipt.');
      }
      catch (error) {
        if (error instanceof PersistentStorageError ? error.code === 'CORRUPT_STORAGE'
          : !(error instanceof SessionError && [400, 404, 409, 413].includes(error.status)) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        run.execution.error = 'A returned file could not be merged safely; execution events remain available.';
      }
    }
    if (removed !== undefined && (!Array.isArray(removed) || removed.length > 256)) { run.execution.error = 'Returned deletions exceed result limits.'; return; }
    for (const [index, item] of ((removed ?? []) as { path?: unknown; version?: unknown }[]).entries()) {
      if (!item || !safeJobPath(item.path) || !Number.isSafeInteger(item.version) || item.path.endsWith('.ipynb')) continue;
      const snapshot = session.workspace.snapshot(privateExecution); const current = snapshot.entries.find((entry) => entry.path === item.path);
      if (privateExecution && current && current.visibility !== 'private') continue;
      const publicationId = `${run.execution.id}:remove:${index}`;
      if (session.workspace.hasPublication(publicationId)) continue;
      if (!current) continue;
      if (current.type !== 'file' || current.version !== item.version) { run.execution.error = 'Returned deletion conflicts with a newer server version.'; continue; }
      try { await session.workspace.remove(item.path, snapshot.revision, privateExecution, undefined, publicationId); }
      catch (error) {
        if (!(error instanceof PersistentStorageError) || error.code === 'CORRUPT_STORAGE') throw error;
        run.execution.error = 'Returned deletion could not be merged safely.';
      }
    }
  }
}
