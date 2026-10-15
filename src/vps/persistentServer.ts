import { createHash, randomBytes, randomUUID, scrypt as deriveKey, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { statfs } from 'node:fs/promises';
import { participantNameKey, projectRootsOverlap, sessionProjectRoot, sessionResources, type SessionResources } from './sessionSettings';
import { atomicWriteFile } from '../core/atomicFile';
import { portableRelativePath } from '../core/projectPath';
import { PersistentWorkspace, PersistentStorageError } from './persistentStorage';
import { PersistentComputePolicy, type PersistentComputeState, type PersistentDeviceInput } from './persistentCompute';
import { PersistentHistory } from './persistentHistory';
import * as Y from 'yjs';
import { loadNotebookCrdt, saveNotebookCrdt, sharedNotebook } from './persistentNotebookCrdt';
import { persistentNotebookOutputs } from './persistentNotebookOutputs';
import { PersistentLive, type PersistentPresence } from './persistentLive';
import { createSharedCursorPosition, encodeRelativeOffset, resolveRelativeOffset, resolveSharedCursorPosition, type SharedCursorPosition } from '../core/cursorPosition';
import { rebaseTextChanges } from '../core/textChanges';
import type { TextChange } from '../core/crdt';
import { editSharedNotebook, type NotebookSyncReply } from './persistentNotebookCrdt';
import type { PersistentCommand, PersistentDevice, PersistentExecution, PersistentMember, PersistentMembership, PersistentRpcRequest, PersistentSessionView } from './persistentProtocol';
import { safeJobPath, VPS_ID, visibleVpsText } from './protocol';

const scrypt = (value: string, salt: string): Promise<Buffer> => new Promise((resolve, reject) => {
  deriveKey(value, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
});
const PRESENCE_MS = 20_000;
const MAX_RPC_BYTES = 12 * 1024 * 1024;
const MAX_EVENTS_BYTES = 1024 * 1024;
const MAX_CONTROL_BYTES = 256 * 1024;
const MAX_EXECUTIONS = 32;
const MAX_SESSIONS = 16;
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const token = (): string => randomBytes(32).toString('base64url');

class SessionError extends Error {
  public constructor(public readonly status: number, message: string, public readonly code?: string) { super(message); }
}
interface MemberRecord { id: string; name: string; role: PersistentMember['role']; tokenHash: string; revoked: boolean; invitationId?: string; expiresAt?: number; readOnly?: boolean }
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
  mode?: 'persistent' | 'temporary';
  projectRoot?: string;
  resources?: SessionResources;
  bannedNames?: string[];
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
  private hostResources: PersistentSessionView['host'];
  private hostResourceTime = 0;
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
      this.checkProjectRoot(record.projectRoot ?? record.id);
      const resources = sessionResources(record.resources);
      const workspace = new PersistentWorkspace(this.workspaceDirectory(record), { maxProjectBytes: resources.storageMb * 1024 ** 2 });
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
          if (session.record.mode === 'temporary' && session.record.state === 'running' && (session.seen.get(session.record.ownerId) ?? 0) < Date.now() - 60_000) await this.lifecycle(session, session.record.members.find((member) => member.id === session.record.ownerId)!, 'stop');
          if (session.record.mode === 'temporary' && session.record.state === 'stopped' && !session.record.executions.some((run) => run.execution.state === 'queued' || run.execution.state === 'running')) { await this.lifecycle(session, session.record.members.find((member) => member.id === session.record.ownerId)!, 'delete'); continue; }
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
      if (['view', 'heartbeat', 'adminSession'].includes(body.operation)) await this.refreshHostResources();
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
      response.end(JSON.stringify({ error: status < 500 ? (error as Error).message : 'Persistent session operation failed.', ...(error instanceof SessionError && error.code ? { code: error.code } : {}) }));
    } finally { clearTimeout(deadline); }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation); this.serial = result.catch(() => undefined); return result;
  }
  private async refreshHostResources(): Promise<void> {
    if (Date.now() - this.hostResourceTime < 5000) return;
    const disk = await statfs(this.options.directory);
    this.hostResources = { cpu: os.cpus()[0]?.model ?? 'VPS CPU', memoryTotalBytes: os.totalmem(), memoryFreeBytes: os.freemem(),
      diskTotalBytes: disk.blocks * disk.bsize, diskFreeBytes: disk.bavail * disk.bsize };
    this.hostResourceTime = Date.now();
  }
  private workspaceDirectory(record: Pick<SessionRecord, 'id' | 'projectRoot'>): string {
    return record.projectRoot === undefined ? path.join(this.directory(record.id), 'workspace') : path.join(this.options.directory, '.projects', record.projectRoot);
  }
  private checkProjectRoot(root: string): void {
    try { sessionProjectRoot(root); } catch (error) { throw new SessionError(400, (error as Error).message); }
    if ([...this.sessions.values()].some(({ record }) => projectRootsOverlap(record.projectRoot ?? record.id, root))) {
      throw new SessionError(409, 'The project folder overlaps another session. Choose a separate folder, not its parent or child.', 'PROJECT_ROOT_OVERLAP');
    }
  }
  private directory(id: string): string { return path.join(this.options.directory, id); }
  private async persist(session: Session): Promise<void> {
    session.record.policy = session.policy.serialize();
    await this.writeMetadata(path.join(this.directory(session.record.id), 'session.json'), JSON.stringify(session.record));
  }
  private async trimHistory(session: Session, capacity = false, reserveBytes = 0, excludedId = ''): Promise<void> {
    const bytes = (): number => session.record.executions.reduce((total, run) => total + Buffer.byteLength(JSON.stringify(run.execution.events)), 0);
    while ((capacity && session.record.executions.length >= MAX_EXECUTIONS) || bytes() + reserveBytes > 4 * 1024 * 1024) {
      const index = session.record.executions.findIndex((run) => !run.mergePending && !this.hasOutputDependents(session, run) && run.execution.id !== excludedId && run.execution.state !== 'queued' && run.execution.state !== 'running');
      if (index < 0) break;
      const run = session.record.executions[index]!;
      const artifact = path.join(this.directory(session.record.id), 'results', `${run.execution.id}.json`);
      try { await lstat(artifact); run.execution.error = `${run.execution.error ? run.execution.error + ' ' : ''}Returned artifact transport retention expired; merged project files remain on VPS.`; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await session.history.archive(run); session.record.executions.splice(index, 1); await this.persist(session);
      await rm(path.join(this.directory(session.record.id), 'commands', `${run.commandId}.json`), { force: true }); await rm(artifact, { force: true });
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
    if (record.mode !== undefined && !['persistent', 'temporary'].includes(record.mode)) throw new Error('Invalid saved session mode.');
    if (record.projectRoot !== undefined) sessionProjectRoot(record.projectRoot);
    sessionResources(record.resources);
    if (record.bannedNames !== undefined && (!Array.isArray(record.bannedNames) || record.bannedNames.length > 128 || record.bannedNames.some((name) => typeof name !== 'string' || !visibleVpsText(name, 120)))) throw new Error('Invalid blocked participants.');
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
      online: (session.seen.get(member.id) ?? 0) > Date.now() - PRESENCE_MS }));
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
      mode: session.record.mode ?? 'persistent', projectRoot: session.record.projectRoot ?? session.record.id, resources: sessionResources(session.record.resources),
      ...(member.id === session.record.ownerId ? { bannedNames: session.record.bannedNames ?? [] } : {}), ...(this.hostResources ? { host: this.hostResources } : {}),
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
      const mode = body.mode ?? 'persistent'; if (mode !== 'persistent' && mode !== 'temporary') throw new SessionError(400, 'Invalid session mode.');
      const projectRoot = body.projectRoot ?? id; this.checkProjectRoot(projectRoot as string);
      let resources: SessionResources; try { resources = sessionResources(body.resources); } catch (error) { throw new SessionError(400, (error as Error).message); }
      const policy = new PersistentComputePolicy(id, memberId); const workspace = new PersistentWorkspace(this.workspaceDirectory({ id, projectRoot: projectRoot as string }), { maxProjectBytes: resources.storageMb * 1024 ** 2 }); await workspace.init();
      const session: Session = { record: { version: 1, id, name, state: 'running', ownerId: memberId, password, mode, projectRoot: projectRoot as string, resources,
        members: [{ id: memberId, name: typeof body.memberName === 'string' && visibleVpsText(body.memberName, 120) ? body.memberName : 'Owner', role: 'owner', tokenHash: sha(secret), revoked: false }], policy: policy.serialize(), executions: [], aclEpoch: 1 }, workspace, policy, seen: new Map([[memberId, Date.now()]]), history: new PersistentHistory(this.directory(id)), live: new PersistentLive() };
      policy.setMembers(this.members(session)); if (this.vpsInventory) policy.registerVps(this.vpsInventory);
      await this.persist(session); this.sessions.set(id, session);
      return { sessionId: id, memberId, token: secret, name } satisfies PersistentMembership;
    }
    if (body.operation === 'list') {
      if (!this.administrative(credential)) throw new SessionError(401, 'An administrative credential is required.');
      return { capabilities: { sessionAdministration: 1 }, sessions: [...this.sessions.values()].map(({ record }) => ({ id: record.id, name: record.name, state: record.state, mode: record.mode ?? 'persistent', projectRoot: record.projectRoot ?? record.id })) };
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
    if (body.operation === 'adminSession') {
      if (!this.administrative(credential)) throw new SessionError(401, 'A VPS administrative credential is required.');
      return this.adminSession(session, body);
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
    if (member.readOnly && !['view', 'heartbeat', 'leave', 'snapshot', 'read', 'execution', 'executions', 'artifacts', 'notebookSync', 'presence'].includes(body.operation)) throw new SessionError(403, 'This invitation grants read access only.');
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
    if (body.operation === 'leave') {
      if (owner && session.record.mode === 'temporary') await this.lifecycle(session, member, 'stop');
      session.live.remove(member.id); session.seen.delete(member.id); session.policy.setMembers(this.members(session)); await this.persist(session); return { left: true }; }
    if (body.operation === 'lifecycle') return this.lifecycle(session, member, this.string(body, 'action'));
    if (body.operation === 'password') {
      this.owner(session, member); session.record.password = await this.password(body.password);
      session.record.invitations = [];
      for (const guest of session.record.members) if (guest.id !== member.id) { guest.revoked = true; session.seen.delete(guest.id); }
      session.policy.setMembers(this.members(session)); this.retireRevokedReporting(session); await this.persist(session); return this.view(session, member);
    }
    if (body.operation === 'manageResources' || body.operation === 'ban' || body.operation === 'unban' || body.operation === 'kick') {
      this.owner(session, member); return this.adminSession(session, { ...body, action: body.operation });
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
            activeLineAnchor: anchor, activeLine: text.toString().slice(0, offset).split('\n').length - 1, shareCursor: true, cursorColor: '#4FC3F7', ...(cursor ? { cursor: createSharedCursorPosition(text, cursor.anchor, cursor.active) } : {}) });
        } finally { doc.destroy(); }
      }
      return { states: session.live.states((filename) => session.workspace.snapshot(owner).entries.some((entry) => entry.path === filename && entry.type === 'file')) };
    }
    if (body.operation === 'notebookSync') {
      const filename = this.string(body, 'path');
      if (!filename.endsWith('.ipynb')) throw new SessionError(400, 'Select a notebook.');
      const file = await session.workspace.read(filename, owner);
      const { doc, epoch, template } = loadNotebookCrdt(file.content);
      try {
        if (body.epoch !== undefined && body.epoch !== epoch) throw new SessionError(409, 'Notebook was replaced. Preserve offline edits and reopen it.');
        const before = Buffer.from(Y.encodeStateAsUpdate(doc));
        const previous = sharedNotebook(doc);
        let intentApplied = false;
        let implicitPresence: PersistentPresence | undefined;
        if (body.intent !== undefined) {
          if (member.readOnly) throw new SessionError(403, 'This invitation grants read access only.');
          const intent = body.intent as { actor: string; sequence: number; cellId: string; baseline: string; changes: TextChange[] };
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
            if (intent.sequence !== (last?.sequence ?? 0) + 1 || (!last && Object.keys(ledger).length >= 64)) throw new SessionError(409, 'Text intent sequence is unavailable.');
            const cell = previous.cells.find((item) => item.id === intent.cellId); if (!cell) throw new SessionError(409, 'Cell was removed.');
            const changes = rebaseTextChanges(intent.baseline, cell.source, intent.changes);
            const text = doc.getMap<Y.Map<unknown>>('cells').get(cell.id)!.get('source') as Y.Text;
            doc.transact(() => { for (const change of [...changes].sort((a, b) => b.offset - a.offset)) { if (change.deleteCount) text.delete(change.offset, change.deleteCount); if (change.insertText) text.insert(change.offset, change.insertText); } });
            const offset = Math.min(text.length, (changes[0]?.offset ?? 0) + (changes[0]?.insertText.length ?? 0));
            const start = offset <= 0 ? 0 : text.toString().lastIndexOf('\n', offset - 1) + 1;
            implicitPresence = { peer: { peerId: member.id, displayName: member.name, joinOrder: session.record.members.indexOf(member) }, epoch, readOnly: false,
              kernelStatus: 'Idle', activeFile: filename, activeNotebookCellId: cell.id, activeLineAnchor: encodeRelativeOffset(text, start),
              activeLine: text.toString().slice(0, start).split('\n').length - 1, cursor: createSharedCursorPosition(text, offset, offset), shareCursor: true, cursorColor: '#4FC3F7' };
            template.metadata ??= {};
            template.metadata.pair_crdt = { ...template.metadata.pair_crdt, intents: { ...ledger, [intent.actor]: { member: member.id, sequence: intent.sequence, digest } } }; intentApplied = true;
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
        if (member.readOnly && !Buffer.from(Y.encodeStateAsUpdate(doc)).equals(before)) throw new SessionError(403, 'This invitation grants read access only.');
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
        return { epoch, revision, update, acknowledgedSequence, identity: session.workspace.notebookIdentity(filename, owner), ...(body.compact === true ? { cells: [], metadata: {} } : sharedNotebook(doc)) } satisfies NotebookSyncReply;
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
      const movesNotebook = entries.some((entry) => entry.type === 'file' && entry.path.endsWith('.ipynb')
        && (entry.path === source || entry.path.startsWith(`${source}/`)));
      return session.workspace.rename(source, target, this.revision(body), owner, hidesPublicFiles ? () => this.privacyBarrier(session)
        : movesNotebook ? async () => { session.policy.invalidateKernels(); await this.persist(session); } : undefined);
    }
    if (body.operation === 'remove') {
      // Deletion retires kernels holding the old public snapshot.
      return session.workspace.remove(this.string(body, 'path'), this.revision(body), owner, () => this.privacyBarrier(session));
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
    if (session.record.bannedNames?.some((blocked) => participantNameKey(blocked) === participantNameKey(name))) throw new SessionError(403, 'This participant is blocked from the session.');
    if (session.record.members.some((member) => this.validMember(session, member) && member.id === session.record.ownerId && participantNameKey(member.name) === participantNameKey(name))) throw new SessionError(409, 'The owner name is reserved. Reconnect using your saved owner credential.');
    session.record.members = session.record.members.filter((member) => this.validMember(session, member));
    session.policy.setMembers(this.members(session)); session.policy.pruneRetiredDevices(session.record.executions.filter((run) => run.execution.state === 'queued' || run.execution.state === 'running').map((run) => run.execution.deviceId));
    if (session.record.members.length >= 128) throw new SessionError(409, 'Active membership limit reached.');
    const memberId = randomUUID(); const secret = token(); session.record.members.push({ id: memberId, name, role: 'member', tokenHash: sha(secret), revoked: false, ...(invite ? { invitationId: invite.id, expiresAt: invite.expiresAt, readOnly: invite.readOnly } : {}) });
    session.seen.set(memberId, Date.now()); session.policy.setMembers(this.members(session)); await this.persist(session);
    return { sessionId: session.record.id, memberId, token: secret, name: session.record.name };
  }

  private async adminSession(session: Session, body: PersistentRpcRequest): Promise<unknown> {
    const owner = session.record.members.find((member) => member.id === session.record.ownerId)!;
    if (body.action === 'view') return this.view(session, owner);
    if (body.action === 'lifecycle') return this.lifecycle(session, owner, this.string(body, 'lifecycle'));
    if (body.action === 'manageResources') {
      let resources: SessionResources;
      try { resources = sessionResources(body.resources); } catch (error) { throw new SessionError(400, (error as Error).message); }
      session.workspace.configureLimits({ maxProjectBytes: resources.storageMb * 1024 ** 2 });
      session.record.resources = resources;
    } else if (body.action === 'unban') {
      const name = this.string(body, 'name');
      session.record.bannedNames = (session.record.bannedNames ?? []).filter((blocked) => participantNameKey(blocked) !== participantNameKey(name));
    } else if (body.action === 'kick' || body.action === 'ban') {
      const member = session.record.members.find((entry) => entry.id === body.memberId && entry.id !== owner.id && !entry.revoked);
      if (!member) throw new SessionError(400, 'Choose a participant other than the owner.');
      if (body.action === 'ban') {
        const blocked = session.record.bannedNames ?? [];
        if (blocked.length >= 128) throw new SessionError(409, 'Blocked participant limit reached.');
        if (!blocked.some((name) => participantNameKey(name) === participantNameKey(member.name))) blocked.push(member.name);
        session.record.bannedNames = blocked;
      }
      for (const candidate of session.record.members) if (candidate.id === member.id || (body.action === 'ban' && candidate.id !== owner.id && participantNameKey(candidate.name) === participantNameKey(member.name))) {
        candidate.revoked = true; session.seen.delete(candidate.id); session.live.remove(candidate.id);
      }
      session.policy.setMembers(this.members(session)); this.retireRevokedReporting(session);
    } else throw new SessionError(400, 'Unknown administration action.');
    await this.persist(session); session.live.invalidate(); return this.view(session, owner);
  }

  private async lifecycle(session: Session, member: MemberRecord, action: string): Promise<unknown> {
    this.administrator(member);
    if (!['start', 'stop', 'restart', 'delete'].includes(action)) throw new SessionError(400, 'Invalid lifecycle action.');
    if (action === 'delete') { session.record.state = 'stopped'; await this.persist(session); await rm(this.directory(session.record.id), { recursive: true }); if (session.record.projectRoot !== undefined) await rm(this.workspaceDirectory(session.record), { recursive: true, force: true }); session.live.close(); this.sessions.delete(session.record.id); return { deleted: true }; }
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
    if (body.operation !== 'kernel' && session.record.executions.filter((run) => run.execution.state === 'queued' || run.execution.state === 'running').length >= sessionResources(session.record.resources).activeExecutions) throw new SessionError(409, 'Session execution allocation is full. Wait for accepted work or increase its allocation.', 'EXECUTION_ALLOCATION_FULL');
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
    const files = await session.workspace.publicSnapshot(undefined, privateExecution);
    const command: PersistentCommand = { id: commandId, executionId: id, sessionId: session.record.id, kernelId: `${session.record.id}:${scope}:${generation}:${notebookPath}`, scope,
      generation, deviceId: target.deviceId, ...(target.gpuUuid ? { gpuUuid: target.gpuUuid } : {}),
      files: files.map((item) => ({ ...item, version: snapshot.entries.find((entry) => entry.path === item.path)?.version ?? 0 })), command: raw };
    if (Buffer.byteLength(JSON.stringify(command)) > 16 * 1024 * 1024) throw new SessionError(413, 'Public compute snapshot exceeds the 16 MiB transport limit.');
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
    const run = [...session.record.executions].reverse().find((candidate) => candidate.execution.state === 'running' && (candidate.execution.id === body.executionId || candidate.execution.notebook === body.notebook));
    if (!run || (run.execution.scope === 'private' && member.id !== session.record.ownerId)) throw new SessionError(409, 'No running kernel execution matches this control.');
    if (run.aclEpoch !== session.record.aclEpoch && member.id !== session.record.ownerId) throw new SessionError(403, 'Kernel execution predates a privacy change.');
    await session.workspace.read(run.execution.notebook, member.id === session.record.ownerId);
    if (run.execution.requesterId !== member.id && member.role === 'member') throw new SessionError(403, 'Only the execution requester or an administrator can control it.');
    const input = body.operation === 'kernelControl' ? body.command as Record<string, unknown> : { command: body.command, value: body.value };
    if (!input || (input.command !== 'interrupt' && input.command !== 'inputReply')) throw new SessionError(400, 'Invalid active kernel control.');
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
      const command = JSON.parse(await this.readMetadata(path.join(this.directory(session.record.id), 'commands', `${running.commandId}.json`), 16 * 1024 * 1024)) as PersistentCommand;
      return { command: { ...command, files: [], command: {} }, controls: running.controls, recoverOnly: true };
    }
    this.active(session);
    if (deviceId === 'vps' && [...this.sessions.values()].some((candidate) => candidate !== session
      && candidate.record.executions.some((run) => run.execution.deviceId === 'vps' && run.execution.state === 'running'))) return { command: null };
    for (const run of session.record.executions) {
      if (run.execution.deviceId !== deviceId || run.execution.state !== 'queued') continue;
      try {
        const latest = session.policy.view();
        if (latest.generation !== run.execution.generation || (run.execution.scope !== 'private' && (latest.target.deviceId !== deviceId || latest.target.gpuUuid !== run.execution.gpuUuid)) || run.aclEpoch !== session.record.aclEpoch) throw new SessionError(409, 'Queued execution selection changed.');
        if (run.execution.scope === 'private' && deviceId !== 'vps' && latest.devices.find((device) => device.id === deviceId)?.ownerId !== session.record.ownerId) throw new SessionError(403, 'Private execution requires the owner machine or VPS.');
        session.policy.assertExecutionTarget(run.execution.requesterId, { deviceId, ...(run.execution.gpuUuid ? { gpuUuid: run.execution.gpuUuid } : {}) }); const file = await session.workspace.read(run.execution.notebook, run.execution.scope === 'private');
        void file;
      }
      catch { run.execution.state = 'failed'; run.execution.error = 'Execution authority or public notebook access was revoked before launch.'; await this.persist(session); continue; }
      run.execution.state = 'running'; await this.persist(session); this.publishExecution(session, run);
      return { command: JSON.parse(await this.readMetadata(path.join(this.directory(session.record.id), 'commands', `${run.commandId}.json`), 16 * 1024 * 1024)) as PersistentCommand };
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
    if (run.reports.length >= 4096 || Buffer.byteLength(JSON.stringify([...run.execution.events, ...body.events])) > MAX_EVENTS_BYTES) throw new SessionError(413, 'Execution output limit reached.');
    const events = body.events as Record<string, unknown>[];
    await this.trimHistory(session, false, Buffer.byteLength(JSON.stringify(events)), run.execution.id);
    if (events.some((event) => event.requestId !== undefined && event.requestId !== run.commandId && !run.controls.some((control) => control.id === event.requestId))) throw new SessionError(403, 'Event belongs to another command.');
    const terminalMerge = body.state === 'completed' || body.state === 'failed';
    if (terminalMerge || body.files !== undefined || body.removedFiles !== undefined) await this.writeMetadata(path.join(this.directory(session.record.id), 'results', `${run.execution.id}.json`), JSON.stringify({ files: body.files ?? [], removedFiles: body.removedFiles ?? [] }));
    const before = { ...run, mergePending: run.mergePending };
    run.execution = { ...run.execution, events: [...run.execution.events, ...events], state: body.state as PersistentExecution['state'],
      ...(body.error !== undefined ? { error: body.error as string } : {}) };
    run.offset += events.length;
    run.mergePending = terminalMerge;
    if (body.state !== 'running') run.controls = [];
    run.reports = [...run.reports, { offset: body.offset as number, digest, end: run.offset }];
    try { await this.persist(session); }
    catch (error) { Object.assign(run, before); throw error; }
    if (run.mergePending) await this.finishResultMerge(session, run);
    await this.trimHistory(session); await this.persist(session); this.publishExecution(session, run); return { offset: run.offset };
  }

  private async finishResultMerge(session: Session, run: ExecutionRecord): Promise<void> {
    // Terminal receipt and artifacts precede project publication. A crash in
    // between is reconciled on startup or by the same report acknowledgement.
    if (run.aclEpoch === session.record.aclEpoch) {
      const result = JSON.parse(await this.readMetadata(path.join(this.directory(session.record.id), 'results', `${run.execution.id}.json`), 8 * 1024 * 1024)) as { files?: unknown; removedFiles?: unknown };
      await this.saveOutputs(session, run);
      await this.saveResults(session, run, result.files, result.removedFiles);
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
    for (const [index, item] of ((value ?? []) as { path?: unknown; content?: unknown; version?: unknown }[]).entries()) {
      if (!item || !safeJobPath(item.path) || typeof item.content !== 'string' || !Number.isSafeInteger(item.version) || item.path.endsWith('.ipynb')) continue;
      const snapshot = session.workspace.snapshot(privateExecution); const current = snapshot.entries.find((entry) => entry.path === item.path);
      if (privateExecution && current && current.visibility !== 'private') continue;
      const publicationId = `${run.execution.id}:write:${index}`;
      if (session.workspace.hasPublication(publicationId)) {
        if (current?.type !== 'file' || (await session.workspace.read(item.path, privateExecution)).content !== item.content) {
          run.execution.error = 'Returned file conflicts with a newer server version; execution events remain available.';
        }
        continue;
      }
      if ((current?.version ?? 0) !== item.version) {
        // A previous merge may have published this exact content before a
        // crash. Acknowledge it without overwriting a subsequent different edit.
        if (current?.type === 'file' && (await session.workspace.read(item.path, privateExecution)).content === item.content) continue;
        run.execution.error = 'Returned file conflicts with a newer server version; execution events remain available.'; continue;
      }
      try { await session.workspace.write(item.path, item.content, snapshot.revision, privateExecution, publicationId, privateExecution); }
      catch (error) {
        if (!(error instanceof PersistentStorageError) || error.code === 'CORRUPT_STORAGE') throw error;
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
