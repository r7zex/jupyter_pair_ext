import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VpsServer } from '../src/vps/server';
import type { PersistentMembership, PersistentSessionView } from '../src/vps/persistentProtocol';

describe('VPS session administration and project isolation', () => {
  const admin = randomBytes(32).toString('base64url');
  const agent = randomBytes(32).toString('base64url');
  const password = 'separate research password';
  let directory: string;
  let server: VpsServer;
  let endpoint: string;
  async function rpc(body: Record<string, unknown>, token = ''): Promise<{ status: number; data: any }> {
    const response = await fetch(`${endpoint}/v1/sessions/rpc`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  const create = (fields: Record<string, unknown> = {}) => rpc({ operation: 'create', name: 'Research', password, ...fields }, admin);
  const call = (owner: PersistentMembership, operation: string, fields: Record<string, unknown> = {}, token = owner.token) => rpc({ operation, sessionId: owner.sessionId, ...fields }, token);
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'pair-vps-admin-'));
    server = new VpsServer({ dataDirectory: directory, clientToken: admin, agentTokens: { vps: agent } });
    endpoint = `http://127.0.0.1:${await server.start()}`;
  });
  afterEach(async () => { await server.stop(); await rm(directory, { recursive: true, force: true }); });

  it('rejects equal, ancestor, descendant and case-folded folder claims while admitting separate siblings', async () => {
    assert.equal((await create({ projectRoot: 'projects/research' })).status, 200);
    for (const projectRoot of ['projects/research', 'projects', 'projects/research/child', 'PROJECTS/Research']) {
      const result = await create({ projectRoot });
      assert.equal(result.status, 409, projectRoot);
      assert.match(result.data.error, /overlap/);
    }
    for (const projectRoot of ['../escape', '/absolute', 'projects\\research', 'projects//research']) assert.equal((await create({ projectRoot })).status, 400, projectRoot);
    assert.equal((await create({ projectRoot: 'projects/research-two' })).status, 200);
    const concurrent = await Promise.all([create({ projectRoot: 'shared' }), create({ projectRoot: 'shared/child' })]);
    assert.deepEqual(concurrent.map((result) => result.status).sort(), [200, 409]);
  });

  it('keeps files, passwords and folder claims independent across restart', async () => {
    const first = (await create({ projectRoot: 'one', password: 'first independent password' })).data as PersistentMembership;
    const second = (await create({ projectRoot: 'two', password: 'second independent password' })).data as PersistentMembership;
    assert.equal((await call(first, 'write', { path: 'same.txt', content: Buffer.from('first').toString('base64'), expectedRevision: 0 })).status, 200);
    assert.deepEqual((await call(second, 'snapshot')).data.entries, []);
    assert.equal((await rpc({ operation: 'join', sessionId: second.sessionId, password: 'first independent password', name: 'Guest' })).status, 401);
    await server.stop();
    server = new VpsServer({ dataDirectory: directory, clientToken: admin, agentTokens: { vps: agent } });
    endpoint = `http://127.0.0.1:${await server.start()}`;
    assert.equal(Buffer.from((await call(first, 'read', { path: 'same.txt' })).data.content, 'base64').toString(), 'first');
    assert.equal((await create({ projectRoot: 'one/child' })).status, 409);
    assert.equal((await call(second, 'view')).data.ownerId, second.memberId);
  });

  it('enforces authenticated administration, durable blocks, unblocking and temporary kicks', async () => {
    const owner = (await create({ memberName: 'Alice' })).data as PersistentMembership;
    const join = (name: string) => rpc({ operation: 'join', sessionId: owner.sessionId, password, name });
    assert.equal((await join('alice')).status, 409, 'password holders cannot impersonate the owner');
    const guest = (await join('Guest')).data as PersistentMembership;
    assert.equal((await call(owner, 'adminSession', { action: 'view' }, guest.token)).status, 401);
    assert.equal((await call(owner, 'ban', { memberId: owner.memberId }, guest.token)).status, 403);
    assert.equal((await call(owner, 'adminSession', { action: 'ban', memberId: guest.memberId }, admin)).status, 200);
    assert.equal((await call(owner, 'view', {}, guest.token)).status, 401);
    assert.equal((await join('GUEST')).status, 403);
    assert.equal((await call(owner, 'unban', { name: 'guest' })).status, 200);
    const rejoined = (await join('Guest')).data as PersistentMembership;
    assert.equal((await call(owner, 'kick', { memberId: rejoined.memberId })).status, 200);
    assert.equal((await join('Guest')).status, 200);
    const view = (await call(owner, 'view')).data as PersistentSessionView;
    assert.equal(view.ownerId, owner.memberId);
    assert.equal(view.members.find((member) => member.id === owner.memberId)?.role, 'owner');
    assert.ok(view.host && view.host.memoryTotalBytes > 0 && view.host.diskTotalBytes > 0);
  });

  it('enforces storage and execution allocations on the server, including guest requests', async () => {
    const owner = (await create({ resources: { storageMb: 1, activeExecutions: 1 } })).data as PersistentMembership;
    const guest = (await rpc({ operation: 'join', sessionId: owner.sessionId, password, name: 'Guest' })).data as PersistentMembership;
    assert.equal((await call(owner, 'manageResources', { resources: { storageMb: 128, activeExecutions: 32 } }, guest.token)).status, 403);
    assert.equal((await call(owner, 'write', { path: 'large.bin', content: Buffer.alloc(1024 ** 2 + 1).toString('base64'), expectedRevision: 0 }, guest.token)).status, 413);
    await rpc({ operation: 'registerDevice', deviceId: 'vps', device: { id: 'vps', name: 'VPS', python: 'python3', cpu: 'CPU', gpus: [], isolation: 'test sandbox', ready: true } }, agent);
    const content = Buffer.from(JSON.stringify({ cells: [{ cell_type: 'code', id: 'cell-a', source: 'print(1)', metadata: {}, outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 })).toString('base64');
    const snapshot = (await call(owner, 'write', { path: 'work.ipynb', content, expectedRevision: 0 })).data;
    const request = { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: snapshot.revision, requestId: 'first' };
    assert.equal((await call(owner, 'execute', request)).status, 200);
    assert.equal((await call(owner, 'execute', request)).status, 200, 'idempotent retry does not consume another slot');
    assert.equal((await call(owner, 'execute', { ...request, requestId: 'second' }, guest.token)).status, 409);
  });

  it('ends a temporary session with its owner while persistent sessions remain available', async () => {
    const temporary = (await create({ mode: 'temporary' })).data as PersistentMembership;
    const persistent = (await create()).data as PersistentMembership;
    assert.equal((await call(temporary, 'view')).data.mode, 'temporary');
    await call(temporary, 'leave');
    assert.equal((await call(temporary, 'snapshot')).status, 409);
    await call(persistent, 'leave');
    assert.equal((await call(persistent, 'snapshot')).status, 200);
  });
});
