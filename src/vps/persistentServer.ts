import { createHash, randomBytes, randomUUID, scrypt as deriveKey, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { atomicWriteFile } from '../core/atomicFile';
import { portableRelativePath } from '../core/projectPath';
import { PersistentWorkspace, PersistentStorageError } from './persistentStorage';
import { PersistentComputePolicy, type PersistentComputeState, type PersistentDeviceInput } from './persistentCompute';
import { PersistentHistory } from './persistentHistory';
import { persistentNotebookOutputs } from './persistentNotebookOutputs';
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
  public constructor(public readonly status: number, message: string) { super(message); }
}
interface MemberRecord { id: string; name: string; role: PersistentMember['role']; tokenHash: string; revoked: boolean }
interface ExecutionRecord {
  execution: PersistentExecution; requestId: string; commandId: string; cellIdentity: string;
  sourceHash: string; notebookVersion: number; offset: number; reports: { offset: number; digest: string; end: number }[];
  aclEpoch: number; controls: { id: string; command: Record<string, unknown> }[];
  kernelCommand?: 'restart' | 'release';
  mergePending?: boolean;
}
interface SessionRecord {
  version: 1; id: string; name: string; state: 'running' | 'stopped'; ownerId: string;
  password: { salt: string; hash: string }; members: MemberRecord[]; policy: PersistentComputeState;
  executions: ExecutionRecord[];
  aclEpoch: number;
}
interface Session { record: SessionRecord; workspace: PersistentWorkspace; policy: PersistentComputePolicy; seen: Map<string, number>; history: PersistentHistory }
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
      const session: Session = { record, workspace, policy, seen: new Map(), history: new PersistentHistory(this.directory(record.id)) };
      policy.setMembers(this.members(session));
      for (const run of record.executions) {
        if (run.execution.state === 'queued') {
          run.execution.state = 'interrupted'; run.execution.error = 'The server restarted. Run the cell explicitly to create a new execution.';
        }
      }
      this.retireRevokedReporting(session);
      this.sessions.set(record.id, session);
      for (const run of record.executions) if (run.mergePending) await this.finishResultMerge(session, run);
      await workspace.retainPublications(record.executions.filter((run) => run.mergePending).map((run) => run.execution.id));
      await this.persist(session);
    }
    this.sweep = setInterval(() => {
      void this.enqueue(async () => {
        for (const session of this.sessions.values()) {
          const before = JSON.stringify(session.policy.serialize());
          session.policy.setMembers(this.members(session));
          if (JSON.stringify(session.policy.serialize()) !== before) await this.persist(session);
        }
        const now = Date.now();
        for (const [key, failure] of this.failures) if (failure.until < now) this.failures.delete(key);
      }).catch(() => undefined);
    }, 5000);
    this.sweep.unref();
  }

  public async stop(): Promise<void> {
    this.closing = true;
    if (this.sweep) clearInterval(this.sweep);
    await this.serial;
    for (const session of this.sessions.values()) await this.persist(session);
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
      const value = await this.enqueue(() => this.dispatch(body, credential, request.socket.remoteAddress ?? 'unknown'));
      response.end(JSON.stringify(value));
    } catch (error) {
      let status = error instanceof SessionError ? error.status : 500;
      if (error instanceof PersistentStorageError) status = ({ CONFLICT: 409, NOT_FOUND: 404, INVALID_PATH: 400, FORBIDDEN: 403, QUOTA_EXCEEDED: 413, INVALID_CONTENT: 400 } as Record<string, number>)[error.code] ?? 500;
      const policyStatus = (error as { status?: unknown }).status;
      if (typeof policyStatus === 'number' && policyStatus >= 400 && policyStatus < 500) status = policyStatus;
      response.statusCode = status;
      response.end(JSON.stringify({ error: status < 500 ? (error as Error).message : 'Persistent session operation failed.' }));
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
    while ((capacity && session.record.executions.length >= MAX_EXECUTIONS) || bytes() + reserveBytes > 4 * 1024 * 1024) {
      const index = session.record.executions.findIndex((run) => !run.mergePending && run.execution.id !== excludedId && run.execution.state !== 'queued' && run.execution.state !== 'running');
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
      || !Number.isSafeInteger(record.aclEpoch) || record.aclEpoch < 1
      || !Array.isArray(record.executions) || record.executions.length > MAX_EXECUTIONS) throw new Error('Invalid saved session authority.');
    for (const run of record.executions) {
      if (!run || !run.execution || !VPS_ID.test(run.execution.id) || !VPS_ID.test(run.commandId) || !VPS_ID.test(run.requestId)
        || !safeJobPath(run.execution.notebook) || !Number.isSafeInteger(run.execution.generation) || run.execution.generation < 1
        || !Number.isSafeInteger(run.offset) || run.offset < 0 || !Array.isArray(run.execution.events)
        || Buffer.byteLength(JSON.stringify(run.execution.events)) > MAX_EVENTS_BYTES || !Array.isArray(run.reports) || run.reports.length > 4096
        || !Number.isSafeInteger(run.aclEpoch) || run.aclEpoch < 1 || !Array.isArray(run.controls) || run.controls.length > 128
        || (run.kernelCommand !== undefined && run.kernelCommand !== 'restart' && run.kernelCommand !== 'release')
        || (run.mergePending !== undefined && (typeof run.mergePending !== 'boolean' || (run.mergePending && !['completed', 'failed'].includes(run.execution.state))))
        || !['queued', 'running', 'completed', 'failed', 'interrupted'].includes(run.execution.state)) throw new Error('Invalid saved execution.');
    }
  }
  private matches(actual: string, expectedHash: string): boolean { return !!actual && timingSafeEqual(Buffer.from(sha(actual), 'hex'), Buffer.from(expectedHash, 'hex')); }
  private administrative(credential: string): boolean { return this.options.administrativeTokens.some((value) => this.matches(credential, sha(value))); }
  private agent(credential: string): boolean { return !!this.options.vpsAgentToken && this.matches(credential, sha(this.options.vpsAgentToken)); }
  private membership(session: Session, credential: string): MemberRecord {
    const member = session.record.members.find((candidate) => !candidate.revoked && this.matches(credential, candidate.tokenHash));
    if (!member) throw new SessionError(401, 'Session membership is invalid or revoked.'); return member;
  }
  private members(session: Session): PersistentMember[] {
    return session.record.members.filter((member) => !member.revoked).map((member) => ({ id: member.id, name: member.name, role: member.role,
      online: (session.seen.get(member.id) ?? 0) > Date.now() - PRESENCE_MS }));
  }
  private retireRevokedReporting(session: Session): void {
    const members = new Set(session.record.members.filter((member) => !member.revoked).map((member) => member.id));
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
      .filter((run) => run.execution.state === 'running' && run.execution.deviceId === device.id).map((run) => run.execution.requesterId))] }));
    return { id: session.record.id, name: session.record.name, state: session.record.state, ownerId: session.record.ownerId,
      memberId: member.id, members: this.members(session), revision: session.workspace.snapshot(member.id === session.record.ownerId).revision,
      allowMemberSwitch: policy.allowMemberSwitch, devices, target: policy.target, generation: policy.generation,
      consents: policy.consents.filter((consent) => member.id === session.record.ownerId || consent.requesterId === member.id || policy.devices.some((device) => device.id === consent.deviceId && device.ownerId === member.id)) };
  }

  private async dispatch(body: PersistentRpcRequest, credential: string, address: string): Promise<unknown> {
    if (this.closing) throw new SessionError(503, 'Session service is stopping.');
    if (body.operation === 'create') {
      if (!this.administrative(credential)) throw new SessionError(401, 'An administrative credential is required to create sessions.');
      if (this.sessions.size >= MAX_SESSIONS) throw new SessionError(409, 'Session limit reached.');
      const name = this.string(body, 'name'); if (!visibleVpsText(name, 120)) throw new SessionError(400, 'Invalid session name.');
      const password = await this.password(body.password); const id = randomUUID(); const memberId = randomUUID(); const secret = token();
      const policy = new PersistentComputePolicy(id, memberId); const workspace = new PersistentWorkspace(path.join(this.directory(id), 'workspace')); await workspace.init();
      const session: Session = { record: { version: 1, id, name, state: 'running', ownerId: memberId, password,
        members: [{ id: memberId, name: typeof body.memberName === 'string' && visibleVpsText(body.memberName, 120) ? body.memberName : 'Owner', role: 'owner', tokenHash: sha(secret), revoked: false }], policy: policy.serialize(), executions: [], aclEpoch: 1 }, workspace, policy, seen: new Map([[memberId, Date.now()]]), history: new PersistentHistory(this.directory(id)) };
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
    if (body.operation === 'view' || body.operation === 'heartbeat') { await this.persist(session); return this.view(session, member); }
    if (body.operation === 'leave') { session.seen.delete(member.id); session.policy.setMembers(this.members(session)); await this.persist(session); return { left: true }; }
    if (body.operation === 'lifecycle') return this.lifecycle(session, member, this.string(body, 'action'));
    if (body.operation === 'password') {
      this.owner(session, member); session.record.password = await this.password(body.password);
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
    if (body.operation === 'snapshot') return session.workspace.snapshot(owner);
    if (body.operation === 'read') return session.workspace.read(this.string(body, 'path'), owner);
    if (body.operation === 'write') return session.workspace.write(this.string(body, 'path'), this.string(body, 'content'), this.revision(body), owner);
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
      const movesNotebook = entries.some((entry) => entry.visibility === 'public' && entry.type === 'file' && entry.path.endsWith('.ipynb')
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
      if (!run) throw new SessionError(404, 'Execution does not exist.');
      if (run.aclEpoch !== session.record.aclEpoch && !owner) throw new SessionError(403, 'Execution results predate a workspace privacy change.');
      if (!owner) await session.workspace.read(run.execution.notebook, false); return run.execution;
    }
    else if (body.operation === 'artifacts') {
      const run = session.record.executions.find((candidate) => candidate.execution.id === body.executionId) ?? (typeof body.executionId === 'string' ? await session.history.lookupExecution(body.executionId) : undefined);
      if (!run || (run.aclEpoch !== session.record.aclEpoch && !owner)) throw new SessionError(404, 'Execution artifacts are unavailable.');
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
    const name = this.string(body, 'name'); if (!visibleVpsText(name, 120)) throw new SessionError(400, 'Invalid participant name.');
    session.record.members = session.record.members.filter((member) => !member.revoked);
    session.policy.setMembers(this.members(session)); session.policy.pruneRetiredDevices(session.record.executions.filter((run) => run.execution.state === 'queued' || run.execution.state === 'running').map((run) => run.execution.deviceId));
    if (session.record.members.length >= 128) throw new SessionError(409, 'Active membership limit reached.');
    const memberId = randomUUID(); const secret = token(); session.record.members.push({ id: memberId, name, role: 'member', tokenHash: sha(secret), revoked: false });
    session.seen.set(memberId, Date.now()); session.policy.setMembers(this.members(session)); await this.persist(session);
    return { sessionId: session.record.id, memberId, token: secret, name: session.record.name };
  }

  private async lifecycle(session: Session, member: MemberRecord, action: string): Promise<unknown> {
    this.administrator(member);
    if (!['start', 'stop', 'restart', 'delete'].includes(action)) throw new SessionError(400, 'Invalid lifecycle action.');
    if (action === 'delete') { session.record.state = 'stopped'; await this.persist(session); await rm(this.directory(session.record.id), { recursive: true }); this.sessions.delete(session.record.id); return { deleted: true }; }
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
      if (existing.aclEpoch !== session.record.aclEpoch && member.id !== session.record.ownerId) throw new SessionError(403, 'Execution predates a privacy change.');
      await session.workspace.read(existing.execution.notebook, member.id === session.record.ownerId);
      return existing.execution;
    }
    await this.trimHistory(session, true);
    if (session.record.executions.filter((run) => run.execution.state === 'queued' || run.execution.state === 'running').length >= 4) throw new SessionError(409, 'Four executions are already pending in this session. Wait for one to finish.');
    const notebookPath = this.string(body, 'notebook'); if (!notebookPath.endsWith('.ipynb')) throw new SessionError(400, 'Select a notebook.');
    const file = await session.workspace.read(notebookPath, false); const snapshot = session.workspace.snapshot(false);
    if (body.operation === 'execute' && file.revision !== this.revision(body)) throw new SessionError(409, 'Notebook snapshot changed. Refresh before execution.');
    const notebook = this.notebook(file.content); const index = body.operation === 'kernel' ? 0 : body.cellIndex;
    let source = ''; let cellIdentity = 'kernel-control';
    if (body.operation === 'execute') {
      if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= notebook.cells.length) throw new SessionError(400, 'Invalid notebook cell.');
      const cell = notebook.cells[index as number]!;
      if (cell.cell_type !== 'code') throw new SessionError(400, 'Only a code cell can execute.');
      source = this.source(cell); cellIdentity = cell.id ?? `index:${index}`;
      if (body.expectedSourceHash !== undefined && (typeof body.expectedSourceHash !== 'string'
        || !/^[a-f0-9]{64}$/.test(body.expectedSourceHash) || body.expectedSourceHash !== sha(source))) {
        throw new SessionError(409, 'The saved cell differs from the editor. Reload or save before execution.');
      }
    }
    const { target, generation } = session.policy.executionTarget(member.id); const id = randomUUID(); const commandId = randomUUID();
    const raw: Record<string, unknown> = { command: 'execute', requestId: commandId, codeBase64: Buffer.from(source).toString('base64') };
    if (body.operation === 'kernel') {
      if (!['restart', 'release'].includes(String(body.command))) throw new SessionError(400, 'Invalid queued kernel control.');
      raw.command = body.command;
    }
    const execution: PersistentExecution = { id, notebook: notebookPath, cellIndex: index as number, requesterId: member.id, deviceId: target.deviceId,
      ...(target.gpuUuid ? { gpuUuid: target.gpuUuid } : {}), generation, state: 'queued', events: [] };
    const files = await session.workspace.publicSnapshot();
    const command: PersistentCommand = { id: commandId, executionId: id, sessionId: session.record.id, kernelId: `${session.record.id}:${generation}:${notebookPath}`,
      generation, deviceId: target.deviceId, ...(target.gpuUuid ? { gpuUuid: target.gpuUuid } : {}),
      files: files.map((item) => ({ ...item, version: snapshot.entries.find((entry) => entry.path === item.path)?.version ?? 0 })), command: raw };
    if (Buffer.byteLength(JSON.stringify(command)) > 16 * 1024 * 1024) throw new SessionError(413, 'Public compute snapshot exceeds the 16 MiB transport limit.');
    await this.writeMetadata(path.join(this.directory(session.record.id), 'commands', `${commandId}.json`), JSON.stringify(command));
    const run: ExecutionRecord = { execution, requestId, commandId, sourceHash: sha(source), cellIdentity, notebookVersion: snapshot.entries.find((entry) => entry.path === notebookPath)!.version, offset: 0, reports: [], aclEpoch: session.record.aclEpoch, controls: [],
      ...(body.operation === 'kernel' ? { kernelCommand: body.command as 'restart' | 'release' } : {}) };
    await session.history.reserve(run); session.record.executions.push(run);
    await this.persist(session); return execution;
  }

  private async kernelControl(session: Session, member: MemberRecord, body: PersistentRpcRequest): Promise<PersistentExecution> {
    const run = [...session.record.executions].reverse().find((candidate) => candidate.execution.state === 'running' && (candidate.execution.id === body.executionId || candidate.execution.notebook === body.notebook));
    if (!run) throw new SessionError(409, 'No running kernel execution matches this control.');
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
        if (latest.generation !== run.execution.generation || latest.target.deviceId !== deviceId || latest.target.gpuUuid !== run.execution.gpuUuid || run.aclEpoch !== session.record.aclEpoch) throw new SessionError(409, 'Queued execution selection changed.');
        session.policy.assertExecutionTarget(run.execution.requesterId, { deviceId, ...(run.execution.gpuUuid ? { gpuUuid: run.execution.gpuUuid } : {}) }); await session.workspace.read(run.execution.notebook, false);
      }
      catch { run.execution.state = 'failed'; run.execution.error = 'Execution authority or public notebook access was revoked before launch.'; await this.persist(session); continue; }
      run.execution.state = 'running'; await this.persist(session);
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
    await this.trimHistory(session); await this.persist(session); return { offset: run.offset };
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
    await session.workspace.retainPublications(session.record.executions.filter((item) => item.mergePending).map((item) => item.execution.id));
  }

  private async saveOutputs(session: Session, run: ExecutionRecord): Promise<void> {
    if (run.kernelCommand) return;
    try {
      const file = await session.workspace.read(run.execution.notebook, false); const notebook = this.notebook(file.content);
      const version = session.workspace.snapshot(false).entries.find((entry) => entry.path === run.execution.notebook)?.version;
      if (version !== run.notebookVersion) return;
      const cell = notebook.cells[run.execution.cellIndex]; if (!cell || cell.cell_type !== 'code' || (cell.id ?? `index:${run.execution.cellIndex}`) !== run.cellIdentity || sha(this.source(cell)) !== run.sourceHash) return;
      const rendered = persistentNotebookOutputs(run.execution.events);
      cell.outputs = rendered.outputs; cell.execution_count = rendered.executionCount;
      await session.workspace.write(run.execution.notebook, Buffer.from(JSON.stringify(notebook, null, 2)).toString('base64'), file.revision, false);
    } catch (error) {
      if (!(error instanceof PersistentStorageError) || error.code === 'CORRUPT_STORAGE') throw error;
      run.execution.error = 'Notebook outputs could not be merged; the execution result remains available.';
    }
  }
  private async saveResults(session: Session, run: ExecutionRecord, value: unknown, removed: unknown): Promise<void> {
    if (value !== undefined && (!Array.isArray(value) || value.length > 256)) { run.execution.error = 'Returned files exceed result limits.'; return; }
    for (const [index, item] of ((value ?? []) as { path?: unknown; content?: unknown; version?: unknown }[]).entries()) {
      if (!item || !safeJobPath(item.path) || typeof item.content !== 'string' || !Number.isSafeInteger(item.version) || item.path.endsWith('.ipynb')) continue;
      const snapshot = session.workspace.snapshot(false); const current = snapshot.entries.find((entry) => entry.path === item.path);
      const publicationId = `${run.execution.id}:write:${index}`;
      if (session.workspace.hasPublication(publicationId)) {
        if (current?.type !== 'file' || (await session.workspace.read(item.path, false)).content !== item.content) {
          run.execution.error = 'Returned file conflicts with a newer server version; execution events remain available.';
        }
        continue;
      }
      if ((current?.version ?? 0) !== item.version) {
        // A previous merge may have published this exact content before a
        // crash. Acknowledge it without overwriting a subsequent different edit.
        if (current?.type === 'file' && (await session.workspace.read(item.path, false)).content === item.content) continue;
        run.execution.error = 'Returned file conflicts with a newer server version; execution events remain available.'; continue;
      }
      try { await session.workspace.write(item.path, item.content, snapshot.revision, false, publicationId); }
      catch (error) {
        if (!(error instanceof PersistentStorageError) || error.code === 'CORRUPT_STORAGE') throw error;
        run.execution.error = 'A returned file could not be merged safely; execution events remain available.';
      }
    }
    if (removed !== undefined && (!Array.isArray(removed) || removed.length > 256)) { run.execution.error = 'Returned deletions exceed result limits.'; return; }
    for (const [index, item] of ((removed ?? []) as { path?: unknown; version?: unknown }[]).entries()) {
      if (!item || !safeJobPath(item.path) || !Number.isSafeInteger(item.version) || item.path.endsWith('.ipynb')) continue;
      const snapshot = session.workspace.snapshot(false); const current = snapshot.entries.find((entry) => entry.path === item.path);
      const publicationId = `${run.execution.id}:remove:${index}`;
      if (session.workspace.hasPublication(publicationId)) continue;
      if (!current) continue;
      if (current.type !== 'file' || current.version !== item.version) { run.execution.error = 'Returned deletion conflicts with a newer server version.'; continue; }
      try { await session.workspace.remove(item.path, snapshot.revision, false, undefined, publicationId); }
      catch (error) {
        if (!(error instanceof PersistentStorageError) || error.code === 'CORRUPT_STORAGE') throw error;
        run.execution.error = 'Returned deletion could not be merged safely.';
      }
    }
  }
}
