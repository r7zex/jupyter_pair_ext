import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { VpsServer, type VpsServerOptions } from '../src/vps/server';
import type { PersistentMembership } from '../src/vps/persistentProtocol';

const admin = 'A'.repeat(40); const agent = 'B'.repeat(40); const password = 'correct session password';
const encoded = (text: string): string => Buffer.from(text).toString('base64');
const notebook = (source = 'x = 41'): string => encoded(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ id: 'stable-cell', cell_type: 'code', source, metadata: {}, execution_count: null, outputs: [] }] }));
describe('Persistent VPS Session Host', () => {
  let directory: string; let server: VpsServer; let endpoint: string; let options: VpsServerOptions; let owner: PersistentMembership;
  async function rpc(body: Record<string, unknown>, credential?: string): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const bytes = Buffer.from(JSON.stringify(body));
      const request = http.request(endpoint + '/v1/sessions/rpc', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': bytes.length, ...(credential ? { authorization: `Bearer ${credential}` } : {}) } }, (response) => {
        const chunks: Buffer[] = []; response.on('data', (chunk: Buffer) => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString()) }));
      }); request.on('error', reject); request.end(bytes);
    });
  }
  const call = (operation: string, fields: Record<string, unknown> = {}, credential = owner.token): Promise<{ status: number; data: any }> => rpc({ operation, sessionId: owner.sessionId, ...fields }, credential);
  async function guest(name = 'Guest'): Promise<PersistentMembership> { const joined = await rpc({ operation: 'join', sessionId: owner.sessionId, password, name }); assert.equal(joined.status, 200); return joined.data as PersistentMembership; }
  async function registerVps(): Promise<void> { assert.equal((await rpc({ operation: 'registerDevice', deviceId: 'vps', device: { id: 'vps', name: 'VPS CPU', python: 'python3', cpu: '1 CPU', gpus: [], isolation: 'isolated test device', ready: true } }, agent)).status, 200); }
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'persistent-session-')); options = { dataDirectory: directory, clientToken: admin, agentTokens: { vps: agent } };
    server = new VpsServer(options); endpoint = `http://127.0.0.1:${await server.start()}`;
    const created = await rpc({ operation: 'create', name: 'Durable project', password }, admin); assert.equal(created.status, 200); owner = created.data as PersistentMembership;
  });
  afterEach(async () => { await server.stop(); await rm(directory, { recursive: true, force: true }); });

  it('persists independent owner credentials, files and lifecycle after all participants leave and server restarts', async () => {
    const snapshot = (await call('mkdir', { path: 'project', expectedRevision: 0 })).data;
    assert.equal((await call('write', { path: 'project/shared.txt', content: encoded('saved'), expectedRevision: snapshot.revision })).status, 200);
    await call('leave'); await server.stop(); server = new VpsServer(options); endpoint = `http://127.0.0.1:${await server.start()}`;
    const joined = await guest(); const shared = await call('read', { path: 'project/shared.txt' }, joined.token);
    assert.equal(Buffer.from(shared.data.content, 'base64').toString(), 'saved'); assert.equal((await call('view')).data.state, 'running');
    assert.equal((await call('lifecycle', { action: 'stop' })).data.state, 'stopped');
    assert.equal((await call('snapshot', {}, joined.token)).status, 409); assert.equal((await call('lifecycle', { action: 'start' })).data.state, 'running');
    const manifest = await readFile(path.join(directory, 'sessions', owner.sessionId, 'session.json'), 'utf8');
    assert.equal(manifest.includes(password), false); assert.equal(manifest.includes(owner.token), false);
  });

  it('separates session credentials from broker/administration and rejects password guessing', async () => {
    const joined = await guest(); assert.notEqual(joined.memberId, owner.memberId);
    assert.equal((await rpc({ operation: 'create', name: 'Unauthorized', password }, joined.token)).status, 401);
    assert.equal((await call('lifecycle', { action: 'stop' }, joined.token)).status, 403);
    for (let i = 0; i < 5; i++) assert.equal((await rpc({ operation: 'join', sessionId: owner.sessionId, password: 'wrong', name: 'Attacker' })).status, 401);
    assert.equal((await rpc({ operation: 'join', sessionId: owner.sessionId, password, name: 'Attacker' })).status, 429);
    const status = await new Promise<number>((resolve) => { http.get(endpoint + '/v1/jobs', { headers: { authorization: `Bearer ${joined.token}` } }, (response) => { response.resume(); resolve(response.statusCode!); }); }); assert.equal(status, 401);
  });

  it('checks private nested files, path traversal and conflicting writes on the server', async () => {
    let snapshot = (await call('mkdir', { path: 'secret', visibility: 'private', expectedRevision: 0 })).data;
    snapshot = (await call('write', { path: 'secret/model.py', content: encoded('private'), expectedRevision: snapshot.revision })).data;
    const joined = await guest(); const visible = await call('snapshot', {}, joined.token); assert.deepEqual(visible.data.entries, []);
    assert.equal((await call('read', { path: 'secret/model.py' }, joined.token)).status, 404);
    assert.equal((await call('write', { path: '../escape', content: encoded('x'), expectedRevision: snapshot.revision })).status, 400);
    assert.equal((await call('write', { path: 'public.py', content: encoded('x'), expectedRevision: 0 })).status, 409);
    const requests = await Promise.all([call('write', { path: 'first.py', content: encoded('1'), expectedRevision: snapshot.revision }), call('write', { path: 'second.py', content: encoded('2'), expectedRevision: snapshot.revision })]);
    assert.deepEqual(requests.map((result) => result.status).sort(), [200, 409]);
  });

  it('revokes guests on password rotation while preserving owner authority', async () => {
    const joined = await guest(); assert.equal((await call('password', { password: 'new protected password' })).status, 200);
    assert.equal((await call('view', {}, joined.token)).status, 401); assert.equal((await call('view')).status, 200);
    assert.equal((await rpc({ operation: 'join', sessionId: owner.sessionId, password, name: 'Old password' })).status, 401);
  });

  it('rejects a changed editor source before accepting work, even with the latest project revision', async () => {
    await registerVps();
    const snapshot = (await call('write', { path: 'work.ipynb', content: notebook('print("collaborator")'), expectedRevision: 0 })).data;
    const input = { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: snapshot.revision, requestId: 'displayed-source',
      expectedSourceHash: createHash('sha256').update('print("my cell")').digest('hex') };
    assert.equal((await call('execute', input)).status, 409);
    assert.equal((await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command, null);
    const accepted = { ...input, expectedSourceHash: createHash('sha256').update('print("collaborator")').digest('hex') };
    assert.equal((await call('execute', accepted)).status, 200);
    assert.equal((await call('execute', input)).status, 409, 'A request ID cannot substitute another displayed source.');
  });

  it('keeps the VPS worker on accepted work across sessions and stopped-session recovery', async () => {
    await registerVps();
    const other = (await rpc({ operation: 'create', name: 'Second session', password }, admin)).data as PersistentMembership;
    const inOther = (operation: string, fields: Record<string, unknown> = {}) => rpc({ operation, sessionId: other.sessionId, ...fields }, other.token);
    const snapshot = (await inOther('write', { path: 'work.ipynb', content: notebook(), expectedRevision: 0 })).data;
    await inOther('execute', { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: snapshot.revision, requestId: 'second-session-first-run' });
    const accepted = (await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command;
    assert.equal(accepted.sessionId, other.sessionId);
    const firstSnapshot = (await call('write', { path: 'work.ipynb', content: notebook(), expectedRevision: 0 })).data;
    const queued = (await call('execute', { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: firstSnapshot.revision, requestId: 'first-session-queued-run' })).data;
    // A scoped API request must not bypass the cross-session admission fence.
    assert.equal((await call('claim', { deviceId: 'vps' }, agent)).data.command, null);
    for (const stopped of [false, true]) {
      if (stopped) assert.equal((await inOther('lifecycle', { action: 'stop' })).status, 200);
      const recovery = (await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data;
      assert.equal(recovery.command.executionId, accepted.executionId); assert.equal(recovery.recoverOnly, true);
      assert.deepEqual(recovery.command.files, []); assert.deepEqual(recovery.command.command, {});
      assert.equal((await call('execution', { executionId: queued.id })).data.state, 'queued');
    }
    assert.equal((await rpc({ operation: 'report', sessionId: other.sessionId, deviceId: 'vps', commandId: accepted.id,
      executionId: accepted.executionId, generation: accepted.generation, offset: 0, state: 'completed', events: [] }, agent)).status, 200);
    assert.equal((await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command.executionId, queued.id);
  });

  it('rolls back an unpersisted terminal report so the same offset can retry safely', async () => {
    await registerVps();
    const snapshot = (await call('write', { path: 'work.ipynb', content: notebook(), expectedRevision: 0 })).data;
    await call('execute', { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: snapshot.revision, requestId: 'report-storage-retry' });
    const command = (await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command;
    const host = (server as unknown as { persistent: { persist: (...args: unknown[]) => Promise<void> } }).persistent;
    const original = host.persist;
    host.persist = async () => { throw new Error('Simulated terminal receipt write failure'); };
    const report = { operation: 'report', sessionId: owner.sessionId, deviceId: 'vps', executionId: command.executionId, commandId: command.id,
      generation: command.generation, offset: 0, state: 'completed', events: [], files: [{ path: 'result.txt', content: encoded('retry result'), version: 0 }] };
    assert.equal((await rpc(report, agent)).status, 500); host.persist = original;
    const record = JSON.parse(await readFile(path.join(directory, 'sessions', owner.sessionId, 'session.json'), 'utf8'));
    assert.equal(record.executions[0].execution.state, 'running');
    assert.equal((await rpc(report, agent)).status, 200);
    assert.equal((await call('read', { path: 'result.txt' })).data.content, encoded('retry result'));
  });

  it('retries the final merge receipt instead of acknowledging an unpersisted completion', async () => {
    await registerVps();
    const snapshot = (await call('write', { path: 'work.ipynb', content: notebook(), expectedRevision: 0 })).data;
    await call('execute', { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: snapshot.revision, requestId: 'merge-receipt-retry' });
    const command = (await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command;
    const host = (server as unknown as { persistent: { persist: (session: { record: { executions: { mergePending?: boolean }[] } }) => Promise<void> } }).persistent;
    const original = host.persist;
    let failed = false;
    host.persist = async function (session) {
      if (!failed && session.record.executions[0]?.mergePending === false) { failed = true; throw new Error('Final receipt write failed'); }
      await original.call(this, session);
    };
    const report = { operation: 'report', sessionId: owner.sessionId, deviceId: 'vps', executionId: command.executionId, commandId: command.id,
      generation: command.generation, offset: 0, state: 'completed', events: [], files: [{ path: 'result.txt', content: encoded('published'), version: 0 }] };
    assert.equal((await rpc(report, agent)).status, 500);
    assert.equal((await rpc(report, agent)).status, 200); host.persist = original;
    const record = JSON.parse(await readFile(path.join(directory, 'sessions', owner.sessionId, 'session.json'), 'utf8'));
    assert.equal(record.executions[0].mergePending, false);
    assert.equal((await call('execution', { executionId: command.executionId })).data.error, undefined);
    assert.equal((await call('read', { path: 'result.txt' })).data.content, encoded('published'));
  });

  it('preserves queued kernels when a deletion or visibility change is rejected', async () => {
    await registerVps();
    let snapshot = (await call('write', { path: 'work.ipynb', content: notebook(), expectedRevision: 0 })).data;
    snapshot = (await call('mkdir', { path: 'private', visibility: 'private', expectedRevision: snapshot.revision })).data;
    const joined = await guest();
    const launched = await call('execute', { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: snapshot.revision, requestId: 'survives-rejection' });
    const before = (await call('view')).data.generation;
    for (const [operation, input, credential, status] of [
      ['remove', { path: 'private', expectedRevision: snapshot.revision }, joined.token, 404],
      ['remove', { path: '../escape', expectedRevision: snapshot.revision }, joined.token, 400],
      ['remove', { path: 'work.ipynb', expectedRevision: 0 }, joined.token, 409],
      ['visibility', { path: 'missing', visibility: 'private', expectedRevision: snapshot.revision }, owner.token, 404],
      ['rename', { path: 'work.ipynb', newPath: 'private/work.ipynb', expectedRevision: 0 }, owner.token, 409],
    ] as const) {
      assert.equal((await call(operation, input, credential)).status, status);
      assert.equal((await call('view')).data.generation, before);
    }
    assert.equal((await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command.executionId, launched.data.id);
  });

  for (const recovery of ['report retry', 'server restart']) it(`finishes durable project publication after interruption during ${recovery}`, async () => {
    await registerVps();
    const snapshot = (await call('write', { path: 'work.ipynb', content: notebook(), expectedRevision: 0 })).data;
    await call('execute', { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: snapshot.revision, requestId: 'merge-recovery' });
    const command = (await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command;
    const host = (server as unknown as { persistent: { saveResults: (...args: unknown[]) => Promise<void> } }).persistent;
    const original = host.saveResults;
    // Interrupt between durable terminal receipt/notebook outputs and returned
    // file publication. Recovery must finish without launching the cell again.
    host.saveResults = async () => { throw new Error('Simulated interruption before returned-file publication'); };
    const report = { operation: 'report', sessionId: owner.sessionId, deviceId: 'vps', executionId: command.executionId, commandId: command.id,
      generation: command.generation, offset: 0, state: 'completed',
      events: [{ type: 'iopub', requestId: command.id, messageType: 'stream', content: { name: 'stdout', text: 'recovered output' } }],
      files: [{ path: 'result.txt', content: encoded('durable artifact'), version: 0 }] };
    assert.equal((await rpc(report, agent)).status, 500);
    host.saveResults = original;
    if (recovery === 'server restart') { await server.stop(); server = new VpsServer(options); endpoint = `http://127.0.0.1:${await server.start()}`; }
    assert.equal((await rpc(report, agent)).status, 200);
    const result = await call('read', { path: 'result.txt' });
    assert.equal(result.status, 200); assert.equal(result.data.content, encoded('durable artifact'));
    const saved = JSON.parse(Buffer.from((await call('read', { path: 'work.ipynb' })).data.content, 'base64').toString());
    assert.equal(saved.cells[0].outputs[0].text, 'recovered output');
    assert.equal((await call('execution', { executionId: command.executionId })).data.error, undefined);
    const record = JSON.parse(await readFile(path.join(directory, 'sessions', owner.sessionId, 'session.json'), 'utf8'));
    assert.equal(record.executions[0].mergePending, false);
    assert.equal((await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command, null);
  });

  it('retries artifact merging idempotently without overwriting a concurrent different file', async () => {
    await registerVps();
    const snapshot = (await call('write', { path: 'work.ipynb', content: notebook(), expectedRevision: 0 })).data;
    await call('execute', { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: snapshot.revision, requestId: 'partial-artifact-merge' });
    const command = (await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command;
    const host = (server as unknown as { persistent: { saveResults: (...args: unknown[]) => Promise<void> } }).persistent;
    const original = host.saveResults;
    host.saveResults = async function (...args: unknown[]) { await original.apply(this, args); throw new Error('Simulated crash after file publication'); };
    const report = { operation: 'report', sessionId: owner.sessionId, deviceId: 'vps', executionId: command.executionId, commandId: command.id,
      generation: command.generation, offset: 0, state: 'completed', events: [],
      files: [{ path: 'same.txt', content: encoded('accepted'), version: 0 }, { path: 'changed.txt', content: encoded('accepted'), version: 0 }] };
    assert.equal((await rpc(report, agent)).status, 500); host.saveResults = original;
    const latest = (await call('snapshot')).data;
    assert.equal((await call('write', { path: 'changed.txt', content: encoded('newer edit'), expectedRevision: latest.revision })).status, 200);
    assert.equal((await rpc(report, agent)).status, 200);
    assert.equal((await call('read', { path: 'same.txt' })).data.content, encoded('accepted'));
    assert.equal((await call('read', { path: 'changed.txt' })).data.content, encoded('newer edit'));
    assert.match((await call('execution', { executionId: command.executionId })).data.error, /conflicts/);
  });

  it('runs canonical public notebook cells with idempotent reports and conflict-safe saved output', async () => {
    await registerVps(); let snap = (await call('write', { path: 'work.ipynb', content: notebook(), expectedRevision: 0 })).data;
    snap = (await call('mkdir', { path: 'secret', visibility: 'private', expectedRevision: snap.revision })).data;
    snap = (await call('write', { path: 'secret/password.txt', content: encoded('hidden'), expectedRevision: snap.revision })).data;
    const body = { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: snap.revision, requestId: 'execute-once' };
    const launched = await call('execute', body); assert.equal(launched.status, 200); assert.equal((await call('execute', body)).data.id, launched.data.id);
    const claim = await rpc({ operation: 'claim', deviceId: 'vps' }, agent); const command = claim.data.command; assert.ok(command); assert.equal(command.files.some((file: {path:string}) => file.path.startsWith('secret')), false);
    assert.equal(Buffer.from(command.command.codeBase64, 'base64').toString(), 'x = 41');
    const report = { operation: 'report', sessionId: owner.sessionId, deviceId: 'vps', executionId: command.executionId, commandId: command.id, generation: command.generation, offset: 0,
      events: [{ type: 'iopub', requestId: command.id, messageType: 'stream', content: { name: 'stdout', text: '42\n' } }, { type: 'complete', requestId: command.id, executionCount: 1, success: true }], state: 'completed' };
    assert.equal((await rpc(report, agent)).status, 200); assert.equal((await rpc(report, agent)).data.offset, 2);
    const saved = JSON.parse(Buffer.from((await call('read', { path: 'work.ipynb' })).data.content, 'base64').toString()); assert.equal(saved.cells[0].outputs[0].text, '42\n');
    assert.equal((await rpc({ ...report, generation: command.generation + 1 }, agent)).status, 403);
  });

  it('reports the current device requester only while execution is running and ignores forged inventory usage', async () => {
    await registerVps(); const snapshot = (await call('write', { path: 'work.ipynb', content: notebook(), expectedRevision: 0 })).data; const joined = await guest();
    assert.equal((await call('registerDevice', { device: { id: 'guest-device', name: 'Guest PC', python: 'python3', cpu: 'CPU', gpus: [], ready: true,
      isolation: 'test isolation', usingMemberIds: ['forged-user'] } }, joined.token)).status, 200);
    const users = async (deviceId: string): Promise<string[]> => (await call('view')).data.devices.find((device: { id: string }) => device.id === deviceId).usingMemberIds;
    assert.deepEqual(await users('guest-device'), []);
    assert.equal((await readFile(path.join(directory, 'sessions', owner.sessionId, 'session.json'), 'utf8')).includes('forged-user'), false);
    assert.equal((await call('execute', { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: snapshot.revision, requestId: 'device-usage' }, joined.token)).status, 200);
    assert.deepEqual(await users('vps'), []);
    const command = (await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command;
    assert.deepEqual(await users('vps'), [joined.memberId]); assert.deepEqual(await users('guest-device'), []);
    assert.equal((await call('report', { deviceId: 'vps', executionId: command.executionId, commandId: command.id, generation: command.generation, offset: 0, events: [], state: 'completed' }, agent)).status, 200);
    assert.deepEqual(await users('vps'), []);
  });

  it('saves updated rich display output and preserves deferred clear output at completion', async () => {
    await registerVps(); const snapshot = (await call('write', { path: 'work.ipynb', content: notebook(), expectedRevision: 0 })).data;
    assert.equal((await call('execute', { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: snapshot.revision, requestId: 'rich-output' })).status, 200);
    const command = (await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command;
    const event = (messageType: string, content: Record<string, unknown>): Record<string, unknown> => ({ type: 'iopub', requestId: command.id, messageType, content });
    assert.equal((await call('report', { deviceId: 'vps', executionId: command.executionId, commandId: command.id, generation: command.generation, offset: 0, state: 'completed', events: [
      event('stream', { name: 'stdout', text: 'removed output' }), event('clear_output', { wait: false }),
      event('display_data', { data: { 'text/html': '<b>before</b>' }, metadata: {}, transient: { display_id: 'figure' } }),
      event('update_display_data', { data: { 'text/html': '<b>after</b>' }, metadata: { expanded: true }, transient: { display_id: 'figure' } }),
      event('clear_output', { wait: true }), { type: 'complete', requestId: command.id, executionCount: 3 },
    ] }, agent)).status, 200);
    const saved = JSON.parse(Buffer.from((await call('read', { path: 'work.ipynb' })).data.content, 'base64').toString('utf8'));
    assert.equal(saved.cells[0].execution_count, 3);
    assert.deepEqual(saved.cells[0].outputs, [{ output_type: 'display_data', data: { 'text/html': '<b>after</b>' }, metadata: { expanded: true } }]);
  });

  it('retains accepted running results across server restart without replaying queued work', async () => {
    await registerVps(); const snap = (await call('write', { path: 'work.ipynb', content: notebook(), expectedRevision: 0 })).data;
    await call('execute', { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: snap.revision, requestId: 'accepted-run' });
    const command = (await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command;
    await server.stop(); server = new VpsServer(options); endpoint = `http://127.0.0.1:${await server.start()}`; await registerVps();
    const recovery = await rpc({ operation: 'claim', deviceId: 'vps' }, agent); assert.equal(recovery.data.command.id, command.id); assert.equal(recovery.data.recoverOnly, true);
    assert.equal((await rpc({ operation: 'report', sessionId: owner.sessionId, deviceId: 'vps', executionId: command.executionId, commandId: command.id, generation: command.generation, offset: 0, events: [], state: 'completed' }, agent)).status, 200);
  });

  it('queues explicit kernel release and preserves saved cell output', async () => {
    await registerVps();
    const saved = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ id: 'stable-cell', cell_type: 'code', source: '', metadata: {}, execution_count: 7, outputs: [{ output_type: 'stream', name: 'stdout', text: 'preserved output' }] }] });
    assert.equal((await call('write', { path: 'work.ipynb', content: encoded(saved), expectedRevision: 0 })).status, 200);
    const released = await call('kernel', { notebook: 'work.ipynb', command: 'release', requestId: 'release-once' });
    assert.equal(released.status, 200);
    const command = (await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command;
    assert.equal(command.command.command, 'release');
    assert.equal((await call('report', { deviceId: 'vps', executionId: command.executionId, commandId: command.id, generation: command.generation, offset: 0, events: [], state: 'completed' }, agent)).status, 200);
    assert.equal(Buffer.from((await call('read', { path: 'work.ipynb' })).data.content, 'base64').toString(), saved);
  });

  it('releases and restarts a kernel after its notebook has no remaining cells', async () => {
    await registerVps();
    const saved = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] });
    const snapshot = (await call('write', { path: 'work.ipynb', content: encoded(saved), expectedRevision: 0 })).data;
    assert.equal((await call('execute', { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: snapshot.revision, requestId: 'empty-cell' })).status, 400);
    for (const control of ['release', 'restart']) {
      assert.equal((await call('kernel', { notebook: 'work.ipynb', command: control, requestId: `empty-${control}` })).status, 200);
      const command = (await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command;
      assert.equal(command.command.command, control);
      assert.equal((await call('report', { deviceId: 'vps', executionId: command.executionId, commandId: command.id, generation: command.generation, offset: 0, events: [], state: 'completed' }, agent)).status, 200);
    }
    assert.equal(Buffer.from((await call('read', { path: 'work.ipynb' })).data.content, 'base64').toString(), saved);
  });

  it('archives more than 32 executions and never replays an archived request after restart or a privacy change', async () => {
    await registerVps();
    let snapshot = (await call('write', { path: 'work.ipynb', content: notebook(), expectedRevision: 0 })).data;
    snapshot = (await call('write', { path: 'data.txt', content: encoded('shared dependency'), expectedRevision: snapshot.revision })).data;
    const joined = await guest();
    const firstRequest = { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: snapshot.revision, requestId: 'archive-request-0' };
    let firstId = '';
    let firstReport: Record<string, unknown> = {};
    for (let index = 0; index < 36; index++) {
      const request = index === 0 ? firstRequest : { ...firstRequest, expectedRevision: snapshot.revision, requestId: `archive-request-${index}` };
      const launched = await call('execute', request, joined.token); assert.equal(launched.status, 200);
      if (index === 0) firstId = launched.data.id;
      const command = (await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command;
      const report = { deviceId: 'vps', executionId: command.executionId, commandId: command.id, generation: command.generation, offset: 0,
        events: [{ type: 'iopub', requestId: command.id, messageType: 'stream', content: { name: 'stdout', text: `result ${index}` } }], state: 'completed' };
      if (index === 0) firstReport = report;
      assert.equal((await call('report', report, agent)).status, 200);
      snapshot = (await call('snapshot')).data;
    }
    const authority = JSON.parse(await readFile(path.join(directory, 'sessions', owner.sessionId, 'session.json'), 'utf8'));
    assert.ok(authority.executions.length <= 32);
    assert.equal(authority.executions.some((run: { execution: { id: string } }) => run.execution.id === firstId), false);
    assert.equal((await call('execute', firstRequest, joined.token)).data.id, firstId);
    assert.equal((await call('execution', { executionId: firstId }, joined.token)).data.events[0].content.text, 'result 0');
    assert.equal((await call('report', firstReport, agent)).data.offset, 1);
    assert.equal((await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command, null);
    await server.stop(); server = new VpsServer(options); endpoint = `http://127.0.0.1:${await server.start()}`; await registerVps();
    assert.equal((await call('execute', firstRequest, joined.token)).data.id, firstId);
    assert.equal((await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command, null);
    assert.equal((await call('visibility', { path: 'data.txt', visibility: 'private', expectedRevision: snapshot.revision })).status, 200);
    assert.equal((await call('execution', { executionId: firstId }, joined.token)).status, 403);
    assert.equal((await call('execute', firstRequest, joined.token)).status, 403);
    assert.equal((await call('execution', { executionId: firstId })).data.events[0].content.text, 'result 0');
    assert.equal((await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command, null);
  });

  it('keeps old accepted output owner-only when a dependency becomes private', async () => {
    await registerVps(); let snap = (await call('write', { path: 'work.ipynb', content: notebook(), expectedRevision: 0 })).data;
    snap = (await call('write', { path: 'data.txt', content: encoded('once public'), expectedRevision: snap.revision })).data; const joined = await guest();
    const launched = await call('execute', { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: snap.revision, requestId: 'privacy-run' }, joined.token);
    const command = (await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command;
    assert.equal((await call('visibility', { path: 'data.txt', visibility: 'private', expectedRevision: snap.revision })).status, 200);
    assert.equal((await rpc({ operation: 'report', sessionId: owner.sessionId, deviceId: 'vps', executionId: command.executionId, commandId: command.id, generation: command.generation, offset: 0, events: [{ type: 'iopub', requestId: command.id, messageType: 'stream', content: {name:'stdout',text:'once public'} }], state: 'completed' }, agent)).status, 200);
    assert.equal((await call('execution', { executionId: launched.data.id }, joined.token)).status, 403); assert.equal((await call('execution', { executionId: launched.data.id })).status, 200);
    const saved = JSON.parse(Buffer.from((await call('read', {path:'work.ipynb'})).data.content, 'base64').toString()); assert.deepEqual(saved.cells[0].outputs, []);
  });

  for (const revocation of ['revoke', 'password']) it(`frees reporting slots after device-owner membership ${revocation} without relaunching accepted work`, async () => {
    await registerVps(); const snapshot = (await call('write', { path: 'work.ipynb', content: notebook(), expectedRevision: 0 })).data;
    const joined = await guest(); const device = { id: 'revoked-device', name: 'Guest PC', python: 'python3', cpu: 'CPU', gpus: [], isolation: 'test isolation', ready: true };
    assert.equal((await call('registerDevice', { device }, joined.token)).status, 200);
    assert.equal((await call('share', { deviceId: device.id, enabled: true }, joined.token)).status, 200);
    const selected = await call('select', { target: { deviceId: device.id } });
    assert.equal((await call('consent', { consentId: selected.data.consent.id, approved: true }, joined.token)).status, 200);
    const runs: Record<string, any>[] = [];
    for (let index = 0; index < 4; index++) {
      const launched = await call('execute', { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: snapshot.revision, requestId: `revoked-${index}` });
      assert.equal(launched.status, 200); runs.push(launched.data);
    }
    const command = (await call('claim', { deviceId: device.id }, joined.token)).data.command;
    assert.equal((await call('report', { deviceId: device.id, executionId: command.executionId, commandId: command.id, generation: command.generation, offset: 0,
      events: [{ type: 'iopub', requestId: command.id, messageType: 'stream', content: { name: 'stdout', text: 'accepted output' } }], state: 'running' }, joined.token)).status, 200);
    const revoked = revocation === 'revoke' ? await call('revoke', { memberId: joined.memberId }) : await call('password', { password: 'replacement session password' });
    assert.equal(revoked.status, 200);
    for (const run of runs) {
      const retained = await call('execution', { executionId: run.id }); assert.equal(retained.status, 200);
      assert.equal(retained.data.state, 'interrupted');
      assert.equal(retained.data.error, 'Execution reporting access revoked; accepted code may still be running and results are retained locally');
    }
    assert.equal((await call('execution', { executionId: command.executionId })).data.events[0].content.text, 'accepted output');
    assert.equal((await call('report', { deviceId: device.id, executionId: command.executionId, commandId: command.id, generation: command.generation, offset: 1, events: [], state: 'completed' }, joined.token)).status, 401);
    assert.equal((await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command, null);
    assert.equal((await call('execute', { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: snapshot.revision, requestId: 'revoked-0' })).data.id, runs[0]!.id);
    for (let index = 0; index < 4; index++) assert.equal((await call('execute', { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: snapshot.revision, requestId: `replacement-${index}` })).status, 200);
    assert.equal((await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command.executionId === command.executionId, false);
  });

  it('retires revoked queued requesters while allowing their accepted VPS execution to finish reporting', async () => {
    await registerVps(); const snapshot = (await call('write', { path: 'work.ipynb', content: notebook(), expectedRevision: 0 })).data; const joined = await guest();
    const running = await call('execute', { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: snapshot.revision, requestId: 'revoked-vps-running' }, joined.token);
    assert.equal(running.status, 200);
    const command = (await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command;
    const queued = await call('execute', { notebook: 'work.ipynb', cellIndex: 0, expectedRevision: snapshot.revision, requestId: 'revoked-vps-queued' }, joined.token);
    assert.equal(queued.status, 200); assert.equal((await call('revoke', { memberId: joined.memberId })).status, 200);
    assert.equal((await call('execution', { executionId: running.data.id })).data.state, 'running');
    assert.equal((await call('execution', { executionId: queued.data.id })).data.state, 'interrupted');
    assert.equal((await call('report', { deviceId: 'vps', executionId: command.executionId, commandId: command.id, generation: command.generation, offset: 0, events: [], state: 'completed' }, agent)).status, 200);
    assert.equal((await rpc({ operation: 'claim', deviceId: 'vps' }, agent)).data.command, null);
  });

  it('requires device owner consent and invalidates a queued solo exception when another human joins', async () => {
    await registerVps(); const snap = (await call('write', { path: 'work.ipynb', content: notebook(), expectedRevision: 0 })).data; const joined = await guest();
    const device = { id: 'guest-pc', name: 'Guest PC', python: 'python3', cpu: '8 CPUs', gpus: [], isolation: 'test isolation', ready: true };
    assert.equal((await call('registerDevice', { device }, joined.token)).status, 200); assert.equal((await call('share', {deviceId:device.id,enabled:true},joined.token)).status, 200);
    assert.equal((await call('select', {target:{deviceId:device.id}},joined.token)).status, 403);
    await call('leave'); assert.equal((await call('select', {target:{deviceId:device.id}},joined.token)).status, 200);
    const run = await call('execute',{notebook:'work.ipynb',cellIndex:0,expectedRevision:snap.revision,requestId:'solo-queued'},joined.token); assert.equal(run.status, 200);
    await call('heartbeat'); const deniedClaim = await call('claim',{deviceId:device.id},joined.token); assert.equal(deniedClaim.data.command,null);
    assert.equal((await call('execution',{executionId:run.data.id},joined.token)).data.state,'failed');
    assert.equal((await call('settings',{allowMemberSwitch:true})).status,200);
    const pending = await call('select',{target:{deviceId:device.id}}); assert.equal(pending.status,200); assert.equal(pending.data.target.deviceId,'vps'); assert.equal(pending.data.consent.status,'pending');
    const consent = pending.data.consent.id; assert.equal((await call('consent',{consentId:consent,approved:false},joined.token)).status,200); assert.equal((await call('view')).data.target.deviceId,'vps');
    const retry = await call('select',{target:{deviceId:device.id}}); assert.equal((await call('consent',{consentId:retry.data.consent.id,approved:true},joined.token)).status,200);
    const accepted = await call('execute',{notebook:'work.ipynb',cellIndex:0,expectedRevision:snap.revision,requestId:'consented-run'}); assert.equal(accepted.status,200);
    const command = (await call('claim',{deviceId:device.id},joined.token)).data.command; assert.ok(command); assert.equal(command.deviceId,device.id);
    assert.equal((await call('revokeConsent', { consentId: retry.data.consent.id }, joined.token)).status, 200);
    assert.equal((await call('share', { deviceId: device.id, enabled: false }, joined.token)).status, 200);
    assert.equal((await call('execution', { executionId: command.executionId })).data.state, 'running');
    assert.equal((await call('report',{deviceId:device.id,commandId:command.id,executionId:command.executionId,generation:command.generation,offset:0,events:[],state:'completed'})).status,403);
    assert.equal((await call('report',{deviceId:device.id,commandId:command.id,executionId:command.executionId,generation:command.generation,offset:0,events:[],state:'completed'},joined.token)).status,200);
  });
});
