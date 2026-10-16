import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VpsServer } from '../src/vps/server';
import { PersistentClient, PersistentHttpError } from '../src/vps/persistentClient';
import { isPermanentConnectionError } from '../src/vps/compatibility';
import type { PersistentMembership } from '../src/vps/persistentProtocol';

describe('Server compatibility before editable project restoration', () => {
  let root: string; let server: VpsServer; let endpoint: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pair-compatibility-'));
    server = new VpsServer({ clientToken: 'A'.repeat(40), agentTokens: {}, dataDirectory: root });
    endpoint = `http://127.0.0.1:${await server.start()}`;
  });
  afterEach(async () => { await server.stop(); await rm(root, { recursive: true, force: true }); });
  it('discovers notebook bootstrap support without leaking credentials or mutating projects', async () => {
    const anonymous = new PersistentClient(endpoint, { kind: 'anonymous' });
    await anonymous.checkCompatibility();
    const result = await anonymous.call<Record<string, unknown>>('compatibility');
    assert.equal(result.version, '0.6.7'); assert.equal(result.protocol, 1);
    assert.equal(result.relayPath, '/v1/temporary-relay');
    assert(!JSON.stringify(result).includes('A'.repeat(40)));
    const admin = new PersistentClient(endpoint, { kind: 'admin', token: 'A'.repeat(40) });
    const list = await admin.call<{ sessions: unknown[] }>('list'); assert.deepEqual(list.sessions, []);
  });
  it('rejects unsupported negotiation as one actionable permanent error', async () => {
    const client = new PersistentClient(endpoint, { kind: 'anonymous' });
    client.call = async () => { throw new PersistentHttpError(400); };
    await assert.rejects(client.checkCompatibility(), error => error instanceof PersistentHttpError && error.status === 426 && /Update the server/.test(error.message) && /Unsaved/.test(error.message));
    for (const status of [401, 403, 404, 426]) assert(isPermanentConnectionError(new PersistentHttpError(status)));
    for (const status of [409, 429, 500, 503]) assert(!isPermanentConnectionError(new PersistentHttpError(status)));
  });
  it('preserves an old empty notebook through 426 and accepts the capable client bootstrap', async () => {
    const owner = await new PersistentClient(endpoint, { kind: 'admin', token: 'A'.repeat(40) }).call<PersistentMembership>('create', { name: 'Migration', password: 'migration acceptance password' });
    const client = new PersistentClient(endpoint, { kind: 'membership', token: owner.token });
    const content = Buffer.from(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] })).toString('base64');
    await client.call('write', { sessionId: owner.sessionId, path: 'test.ipynb', expectedRevision: 0, content });
    await assert.rejects(client.call('notebookSync', { sessionId: owner.sessionId, path: 'test.ipynb' }), error => error instanceof PersistentHttpError && error.status === 426);
    const read = await client.call<{ content: string }>('read', { sessionId: owner.sessionId, path: 'test.ipynb' });
    assert.deepEqual(JSON.parse(Buffer.from(read.content, 'base64').toString()).cells, []);
    await client.checkCompatibility();
    const result = await client.call<{ bootstrapEmpty?: boolean; cells: unknown[] }>('notebookSync', { sessionId: owner.sessionId, path: 'test.ipynb', bootstrapEmpty: true });
    assert.equal(result.bootstrapEmpty, true); assert.deepEqual(result.cells, []);
  });
});
