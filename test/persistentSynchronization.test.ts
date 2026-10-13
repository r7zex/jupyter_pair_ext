import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { VpsServer } from '../src/vps/server';
import { PersistentClient } from '../src/vps/persistentClient';
import { PersistentFolderSync } from '../src/vps/persistentFolderSync';
import { editSharedNotebook, sharedNotebook, type NotebookSyncReply } from '../src/vps/persistentNotebookCrdt';
import { installProxyAwareWebSocket } from '../src/runtime/proxyWebSocket';
import type { PersistentMembership, PersistentSnapshot } from '../src/vps/persistentProtocol';
const encoded = (value: string): string => Buffer.from(value).toString('base64');

describe('Persistent continuous synchronization over actual HTTP', () => {
  let root: string; let server: VpsServer; let client: PersistentClient; let member: PersistentClient; let owner: PersistentMembership; let endpoint: string;
  const rpc = <T = any>(operation: string, fields: Record<string, unknown> = {}): Promise<T> => client.call(operation, { sessionId: owner.sessionId, ...fields });
  beforeEach(async () => {
    installProxyAwareWebSocket({ env: {} }); root = await mkdtemp(path.join(os.tmpdir(), 'pair-sync-')); server = new VpsServer({ dataDirectory: path.join(root, 'server'), clientToken: 'A'.repeat(40), agentTokens: {} });
    endpoint = `http://127.0.0.1:${await server.start()}`;
    owner = await new PersistentClient(endpoint, { kind: 'admin', token: 'A'.repeat(40) }).call('create', { name: 'Sync test', password: 'sync test password' });
    client = new PersistentClient(endpoint, { kind: 'membership', token: owner.token });
    const joined = await new PersistentClient(endpoint, { kind: 'anonymous' }).call<PersistentMembership>('join', { sessionId: owner.sessionId, name: 'Collaborator', password: 'sync test password' });
    member = new PersistentClient(endpoint, { kind: 'membership', token: joined.token });
  });
  afterEach(async () => { await server.stop(); await rm(root, { recursive: true, force: true }); installProxyAwareWebSocket({ env: {} }); });
  it('merges two offline replicas, persists stable IDs/order/metadata, and admits exactly the acknowledged displayed cell', async () => {
    await rpc('write', { path: 'book.ipynb', content: encoded(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: 'python3' } }, cells: [{ id: 'first', cell_type: 'code', source: 'abc', metadata: { tag: 'retained' }, outputs: [] }, { id: 'second', cell_type: 'markdown', source: 'notes', metadata: {} }] })), expectedRevision: 0 });
    const start = await rpc<NotebookSyncReply>('notebookSync', { path: 'book.ipynb' });
    const left = new Y.Doc(); const right = new Y.Doc(); Y.applyUpdate(left, Buffer.from(start.update, 'base64')); Y.applyUpdate(right, Buffer.from(start.update, 'base64'));
    const l = sharedNotebook(left); l.cells[0]!.source = 'Labc'; editSharedNotebook(left, l);
    const r = sharedNotebook(right); r.cells[0]!.source = 'abcR'; r.cells.push({ id: 'third', cell_type: 'code', source: 'print(3)', metadata: {} }); editSharedNotebook(right, r);
    const update = Buffer.from(Y.encodeStateAsUpdate(left)).toString('base64');
    await rpc('notebookSync', { path: 'book.ipynb', epoch: start.epoch, update });
    const reply = await member.call<NotebookSyncReply>('notebookSync', { sessionId: owner.sessionId, path: 'book.ipynb', epoch: start.epoch, update: Buffer.from(Y.encodeStateAsUpdate(right)).toString('base64') });
    assert.equal(reply.cells[0]!.source, 'LabcR'); assert.deepEqual(reply.cells.map((cell) => cell.id), ['first', 'second', 'third']); assert.deepEqual(reply.cells[0]!.metadata, { tag: 'retained' });
    const retry = await rpc<NotebookSyncReply>('notebookSync', { path: 'book.ipynb', epoch: start.epoch, update }); assert.equal(retry.revision, reply.revision, 'Lost ACK replay must not republish or revert source.');
    await server.stop(); server = new VpsServer({ dataDirectory: path.join(root, 'server'), clientToken: 'A'.repeat(40), agentTokens: {} }); endpoint = `http://127.0.0.1:${await server.start()}`; client = new PersistentClient(endpoint, { kind: 'membership', token: owner.token });
    const restored = await rpc<NotebookSyncReply>('notebookSync', { path: 'book.ipynb' }); assert.equal(restored.epoch, start.epoch); assert.equal(restored.cells[0]!.source, 'LabcR');
    await assert.rejects(rpc('execute', { notebook: 'book.ipynb', cellIndex: 0, requestId: 'identity-test', expectedRevision: restored.revision, expectedCellId: 'third' }), /changed|HTTP 409|Reload/);
    left.destroy(); right.destroy();
  });
  it('fences replaced/deleted notebooks and never exposes Private CRDT through direct API', async () => {
    await rpc('write', { path: 'secret.ipynb', content: encoded(JSON.stringify({ cells: [{ id: 'secret', cell_type: 'code', source: 'token = "private"', metadata: {} }], metadata: {} })), expectedRevision: 0 });
    const start = await rpc<NotebookSyncReply>('notebookSync', { path: 'secret.ipynb' });
    await rpc('visibility', { path: 'secret.ipynb', expectedRevision: start.revision, visibility: 'private' });
    await assert.rejects(member.call('notebookSync', { sessionId: owner.sessionId, path: 'secret.ipynb' }), /unavailable/);
    const snap = await rpc<PersistentSnapshot>('snapshot'); await rpc('remove', { path: 'secret.ipynb', expectedRevision: snap.revision });
    const after = await rpc<PersistentSnapshot>('snapshot'); await rpc('write', { path: 'secret.ipynb', expectedRevision: after.revision, content: encoded(JSON.stringify({ cells: [], metadata: {} })) });
    await assert.rejects(rpc('notebookSync', { path: 'secret.ipynb', epoch: start.epoch, update: start.update }), /Reload|HTTP 409|changed/);
  });
  it('reconciles folder changes, rename ACLs, lost acknowledgements, conflicts, deletes and offline recovery', async () => {
    const localRoot = path.join(root, 'local'); await mkdir(localRoot); await writeFile(path.join(localRoot, 'data.txt'), 'initial');
    await rpc('mkdir', { path: 'mirror', visibility: 'private', expectedRevision: 0 });
    let conflictChoice: 'local' | 'remote' | 'later' = 'later'; const conflicts: string[] = [];
    const options = { localRoot, remoteRoot: 'mirror', journal: path.join(root, 'journal.json'), sessionId: owner.sessionId, client, current: () => true,
      conflict: async (value: { path: string }) => { conflicts.push(value.path); return conflictChoice; } };
    let sync = new PersistentFolderSync(options); await sync.cycle();
    assert.equal(Buffer.from((await rpc('read', { path: 'mirror/data.txt' })).content, 'base64').toString(), 'initial');
    await rename(path.join(localRoot, 'data.txt'), path.join(localRoot, 'renamed.txt')); await sync.cycle();
    assert.equal((await rpc<PersistentSnapshot>('snapshot')).entries.find((entry) => entry.path === 'mirror/renamed.txt')?.visibility, 'private');
    const original = client.call.bind(client); let lost = false;
    client.call = async (operation, input) => { const result = await original(operation, input); if (operation === 'write' && !lost) { lost = true; throw new Error('Actual committed HTTP acknowledgement lost'); } return result as any; };
    await writeFile(path.join(localRoot, 'renamed.txt'), 'after acknowledgement'); await assert.rejects(sync.cycle(), /acknowledgement/);
    client.call = original; sync = new PersistentFolderSync(options); await sync.cycle();
    const snap = await rpc<PersistentSnapshot>('snapshot'); await rpc('write', { path: 'mirror/renamed.txt', expectedRevision: snap.revision, content: encoded('remote conflict') });
    await writeFile(path.join(localRoot, 'renamed.txt'), 'local conflict'); await sync.cycle(); assert.deepEqual(conflicts, ['renamed.txt']); assert.equal(await readFile(path.join(localRoot, 'renamed.txt'), 'utf8'), 'local conflict');
    conflictChoice = 'remote'; await sync.cycle(); assert.equal(await readFile(path.join(localRoot, 'renamed.txt'), 'utf8'), 'remote conflict');
    await rm(path.join(localRoot, 'renamed.txt')); await sync.cycle(); assert.equal((await rpc<PersistentSnapshot>('snapshot')).entries.length, 1);
    await writeFile(path.join(localRoot, 'offline.txt'), 'offline'); sync = new PersistentFolderSync(options); await sync.cycle(); assert.equal(Buffer.from((await rpc('read', { path: 'mirror/offline.txt' })).content, 'base64').toString(), 'offline');
    await mkdir(path.join(localRoot, 'folder')); await writeFile(path.join(localRoot, 'folder', 'nested.txt'), 'nested'); await sync.cycle();
    await rename(path.join(localRoot, 'folder'), path.join(localRoot, 'moved-folder')); await sync.cycle();
    const renamed = await rpc<PersistentSnapshot>('snapshot'); assert.equal(renamed.entries.some((entry) => entry.path.startsWith('mirror/folder')), false);
    assert.equal(renamed.entries.find((entry) => entry.path === 'mirror/moved-folder')?.visibility, 'private');
    await symlink(path.join(root, 'journal.json'), path.join(localRoot, 'linked')); await assert.rejects(sync.cycle(), /Unsafe|Linked/);
    assert.equal((await member.call<PersistentSnapshot>('snapshot', { sessionId: owner.sessionId })).entries.length, 0);
  });
});
