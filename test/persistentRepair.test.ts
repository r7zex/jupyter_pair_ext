import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { VpsServer } from '../src/vps/server';
import { PersistentClient, PersistentHttpError } from '../src/vps/persistentClient';
import { PersistentFolderSync } from '../src/vps/persistentFolderSync';
import { type NotebookSyncReply } from '../src/vps/persistentNotebookCrdt';
import type { PersistentCommand, PersistentExecution, PersistentMembership, PersistentSessionView, PersistentSnapshot } from '../src/vps/persistentProtocol';

const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const encode = (value: unknown): string => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');
const notebook = (source = 'a=1\na=1\n'): object => ({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ id: 'cell', cell_type: 'code', source, metadata: {}, outputs: [], execution_count: null }] });

describe('Persistent audit repairs through real RPC and storage', function () {
  this.timeout(20_000);
  let root: string; let server: VpsServer; let member: PersistentClient; let agent: PersistentClient; let membership: PersistentMembership;
  const rpc = <T>(operation: string, fields: Record<string, unknown> = {}): Promise<T> => member.call(operation, { sessionId: membership.sessionId, ...fields });
  const worker = <T>(operation: string, fields: Record<string, unknown> = {}): Promise<T> => agent.call(operation, { sessionId: membership.sessionId, deviceId: 'vps', ...fields });
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pair-repair-'));
    server = new VpsServer({ dataDirectory: path.join(root, 'server'), clientToken: 'A'.repeat(40), agentTokens: { vps: 'B'.repeat(40) } });
    const endpoint = `http://127.0.0.1:${await server.start()}`;
    membership = await new PersistentClient(endpoint, { kind: 'admin', token: 'A'.repeat(40) }).call('create', { name: 'Repairs', password: 'repair-test-password' });
    member = new PersistentClient(endpoint, { kind: 'membership', token: membership.token }); agent = new PersistentClient(endpoint, { kind: 'membership', token: 'B'.repeat(40) });
  });
  afterEach(async () => { member?.dispose(); agent?.dispose(); await server.stop(); await rm(root, { recursive: true, force: true }); });
  async function open(source?: string): Promise<NotebookSyncReply> {
    await rpc('write', { path: 'work.ipynb', content: encode(notebook(source)), expectedRevision: 0 });
    return rpc('notebookSync', { path: 'work.ipynb' });
  }
  function edit(initial: NotebookSyncReply, changes: { offset: number; deleteCount: number; insertText: string }[], clientID: number): string {
    const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(initial.update, 'base64')); doc.clientID = clientID;
    const vector = Y.encodeStateVector(doc); const text = doc.getMap<Y.Map<unknown>>('cells').get('cell')!.get('source') as Y.Text;
    for (const change of [...changes].sort((a, b) => b.offset - a.offset)) { if (change.deleteCount) text.delete(change.offset, change.deleteCount); if (change.insertText) text.insert(change.offset, change.insertText); }
    const result = Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString('base64'); doc.destroy(); return result;
  }
  for (const reverse of [false, true]) it(`retains repeated-line character identities in either arrival order (reverse=${reverse})`, async () => {
    const start = await open();
    const changes = [[{ offset: 0, deleteCount: 4, insertText: '' }], [{ offset: 6, deleteCount: 1, insertText: '2' }]];
    const intents = changes.map((value, index) => ({ actor: randomUUID(), sequence: 1, cellId: 'cell', baseline: 'a=1\na=1\n', changes: value, update: edit(start, value, 100 + index) }));
    for (const intent of reverse ? [...intents].reverse() : intents) await rpc('notebookSync', { path: 'work.ipynb', epoch: start.epoch, intent });
    const replay = await rpc<NotebookSyncReply>('notebookSync', { path: 'work.ipynb', epoch: start.epoch, intent: intents[1] });
    assert.equal(replay.cells[0]!.source, 'a=2\n');
  });
  it('rejects stale legacy offsets instead of silently corrupting duplicate lines', async () => {
    const start = await open();
    await rpc('notebookSync', { path: 'work.ipynb', epoch: start.epoch, intent: { actor: randomUUID(), sequence: 1, cellId: 'cell', baseline: 'a=1\na=1\n', changes: [{ offset: 0, deleteCount: 4, insertText: '' }] } });
    await assert.rejects(rpc('notebookSync', { path: 'work.ipynb', epoch: start.epoch, intent: { actor: randomUUID(), sequence: 1, cellId: 'cell', baseline: 'a=1\na=1\n', changes: [{ offset: 6, deleteCount: 1, insertText: '2' }] } }), (error: unknown) => error instanceof PersistentHttpError && error.status === 409);
    assert.equal((await rpc<NotebookSyncReply>('notebookSync', { path: 'work.ipynb' })).cells[0]!.source, 'a=1\n');
  });
  it('merges a structural update with an unseen source edit', async () => {
    const start = await open(); const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(start.update, 'base64'));
    const vector = Y.encodeStateVector(doc); const cell = new Y.Map(); cell.set('source', new Y.Text('print(7)')); cell.set('cell_type', 'code'); cell.set('metadata', {});
    doc.transact(() => { doc.getMap('cells').set('new', cell); doc.getArray('order').push(['new']); });
    const structural = Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString('base64'); doc.destroy();
    await rpc('notebookSync', { path: 'work.ipynb', epoch: start.epoch, update: edit(start, [{ offset: 0, deleteCount: 0, insertText: '# peer\n' }], 101) });
    const result = await rpc<NotebookSyncReply>('notebookSync', { path: 'work.ipynb', epoch: start.epoch, update: structural });
    assert.equal(result.cells.length, 2); assert.equal(result.cells[0]!.source, '# peer\na=1\na=1\n'); assert.equal(result.cells[1]!.source, 'print(7)');
  });
  it('preserves Markdown attachments and unknown cell fields without an edit', async () => {
    const original = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ id: 'md', cell_type: 'markdown', metadata: {}, source: '![plot](attachment:plot.png)', attachments: { 'plot.png': { 'image/png': 'aW1hZ2U=' } }, vendorField: { retained: true } }] };
    await rpc('write', { path: 'work.ipynb', content: encode(original), expectedRevision: 0 }); await rpc('notebookSync', { path: 'work.ipynb' });
    const saved = JSON.parse(Buffer.from((await rpc<{ content: string }>('read', { path: 'work.ipynb' })).content, 'base64').toString());
    assert.deepEqual(saved.cells, original.cells);
  });
  it('preserves attachments when assigning IDs to a legacy notebook and clears incompatible fields on conversion', async () => {
    const cell = { cell_type: 'markdown', source: '![plot](attachment:plot.png)', metadata: {}, attachments: { 'plot.png': { 'image/png': 'aW1hZ2U=' } }, vendor: 7 };
    await rpc('write', { path: 'work.ipynb', content: encode({ nbformat: 4, nbformat_minor: 2, metadata: {}, cells: [cell] }), expectedRevision: 0 });
    const initial = await rpc<NotebookSyncReply>('notebookSync', { path: 'work.ipynb' });
    const read = async (): Promise<any> => JSON.parse(Buffer.from((await rpc<{ content: string }>('read', { path: 'work.ipynb' })).content, 'base64').toString());
    const first = (await read()).cells[0]; assert.equal(typeof first.id, 'string'); assert.deepEqual(first.attachments, cell.attachments); assert.equal(first.vendor, 7);
    const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(initial.update, 'base64')); const vector = Y.encodeStateVector(doc);
    doc.getMap<Y.Map<unknown>>('cells').get(initial.cells[0]!.id)!.set('cell_type', 'code');
    await rpc('notebookSync', { path: 'work.ipynb', epoch: initial.epoch, update: Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString('base64') }); doc.destroy();
    const code = (await read()).cells[0]; assert.equal(code.attachments, undefined); assert.deepEqual(code.outputs, []); assert.equal(code.execution_count, null); assert.equal(code.vendor, 7);
  });
  it('synchronizes ordinary Python text by identity and fences raw file replacements', async () => {
    await rpc('write', { path: 'helper.py', content: encode('a=1\na=1\n'), expectedRevision: 0 });
    const initial = await rpc<{ epoch: string; update: string }>('textSync', { path: 'helper.py' });
    const docs = [new Y.Doc(), new Y.Doc()]; const updates: string[] = [];
    for (const [index, doc] of docs.entries()) {
      Y.applyUpdate(doc, Buffer.from(initial.update, 'base64')); const vector = Y.encodeStateVector(doc); const text = doc.getText('content');
      if (!index) text.delete(0, 4); else { text.delete(6, 1); text.insert(6, '2'); }
      updates.push(Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString('base64'));
    }
    for (const update of updates) await rpc('textSync', { path: 'helper.py', epoch: initial.epoch, update });
    const latest = await rpc<{ content: string; revision: number }>('read', { path: 'helper.py' }); assert.equal(Buffer.from(latest.content, 'base64').toString(), 'a=2\n');
    await rpc('write', { path: 'helper.py', content: encode('VALUE=10'), expectedRevision: latest.revision });
    await assert.rejects(rpc('textSync', { path: 'helper.py', epoch: initial.epoch, update: updates[1] }), (error: unknown) => error instanceof PersistentHttpError && error.status === 409);
    docs.forEach((doc) => doc.destroy());
  });
  it('keeps notebook generation and identity during unrelated deletion and rename', async () => {
    const start = await open(); const before = await rpc<PersistentSessionView>('view');
    const file = await rpc<PersistentSnapshot>('write', { path: 'unused.txt', content: encode('unused'), expectedRevision: start.revision });
    const removed = await rpc<PersistentSnapshot>('remove', { path: 'unused.txt', expectedRevision: file.revision });
    await rpc('rename', { path: 'work.ipynb', newPath: 'renamed.ipynb', expectedRevision: removed.revision });
    const after = await rpc<PersistentSessionView>('view'); assert.equal(after.generation, before.generation);
    assert.equal((await rpc<NotebookSyncReply>('notebookSync', { path: 'renamed.ipynb' })).identity, start.identity);
  });
  it('rotates ordinary-file history across privacy boundaries and recovers a corrupt sidecar', async () => {
    await rpc('write', { path: 'helper.py', content: encode('VALUE=1'), expectedRevision: 0 });
    const first = await rpc<{ epoch: string }>('textSync', { path: 'helper.py' });
    const snapshot = await rpc<PersistentSnapshot>('snapshot');
    const hidden = await rpc<PersistentSnapshot>('visibility', { path: 'helper.py', visibility: 'private', expectedRevision: snapshot.revision });
    await rpc('visibility', { path: 'helper.py', visibility: 'public', expectedRevision: hidden.revision });
    const second = await rpc<{ epoch: string }>('textSync', { path: 'helper.py' }); assert.notEqual(first.epoch, second.epoch);
    const directory = path.join(root, 'server', 'sessions', membership.sessionId, 'text-replicas');
    const filename = (await readdir(directory)).find((name) => name.endsWith('.json'))!; await writeFile(path.join(directory, filename), '{corrupt');
    const third = await rpc<{ epoch: string }>('textSync', { path: 'helper.py' }); assert.notEqual(second.epoch, third.epoch);
    assert.ok((await readdir(directory)).some((name) => name.includes('.invalid-')));
  });
  it('reclaims abandoned editor uploads so an old process cannot occupy the transfer quota forever', async () => {
    const directory = path.join(root, 'server', 'sessions', membership.sessionId, 'uploads', 'member-' + membership.memberId); await mkdir(directory, { recursive: true });
    const id = hash('abandoned'); const filename = path.join(directory, id + '.json');
    await writeFile(filename, JSON.stringify({ path: 'old.bin', sha256: hash('old'), size: 128 * 1024 * 1024, version: 0 })); await writeFile(path.join(directory, id + '.bin'), 'partial');
    const stale = new Date(Date.now() - 11 * 60_000); await utimes(filename, stale, stale);
    const bytes = Buffer.alloc(400_000, 7); await rpc('write', { path: 'new.bin', content: bytes.toString('base64'), expectedRevision: 0 });
    assert.equal((await rpc<PersistentSnapshot>('snapshot')).entries.find((entry) => entry.path === 'new.bin')?.size, bytes.length);
    assert.ok(!(await readdir(directory)).includes(id + '.json'));
  });
  it('cancels a queued execution before the worker can launch it', async () => {
    await open('raise Exception("must not execute")'); await worker('registerDevice', { device: { id: 'vps', name: 'CPU', python: 'python', cpu: 'CPU', gpus: [], ready: true, isolation: 'test protocol adapter' } });
    const run = await rpc<PersistentExecution>('execute', { notebook: 'work.ipynb', cellIndex: 0, requestId: 'queued-cancel', expectedRevision: (await rpc<PersistentSnapshot>('snapshot')).revision });
    const stopped = await rpc<PersistentExecution>('kernelControl', { notebook: 'work.ipynb', executionId: run.id, command: { command: 'interrupt' } });
    assert.equal(stopped.state, 'interrupted'); assert.equal((await worker<{ command: unknown }>('claim')).command, null);
  });
  it('accepts a terminal receipt after excess output and allows the next cell', async () => {
    await open('print(1)'); await worker('registerDevice', { device: { id: 'vps', name: 'CPU', python: 'python', cpu: 'CPU', gpus: [], ready: true, isolation: 'test protocol adapter' } });
    const run = await rpc<PersistentExecution>('execute', { notebook: 'work.ipynb', cellIndex: 0, requestId: 'output-quota', expectedRevision: (await rpc<PersistentSnapshot>('snapshot')).revision });
    const { command } = await worker<{ command: PersistentCommand }>('claim');
    for (let offset = 0; offset < 3; offset++) await worker('report', { executionId: run.id, commandId: command.id, generation: run.generation, offset, events: [{ type: 'iopub', messageType: 'stream', content: { name: 'stdout', text: 'x'.repeat(3 * 1024 * 1024) } }], state: 'running' });
    const terminal = { executionId: run.id, commandId: command.id, generation: run.generation, offset: 3, events: [], state: 'completed' }; await worker('report', terminal); await worker('report', terminal);
    const completed = await rpc<PersistentExecution>('execution', { executionId: run.id }); assert.equal(completed.state, 'failed'); assert.match(completed.error!, /retention limit/);
    assert.ok(Buffer.byteLength(JSON.stringify(completed.events)) < 8 * 1024 * 1024);
    const next = await rpc<PersistentExecution>('execute', { notebook: 'work.ipynb', cellIndex: 0, requestId: 'after-output-quota', expectedRevision: (await rpc<PersistentSnapshot>('snapshot')).revision }); assert.equal(next.state, 'queued');
  });
  it('streams large uploads and pins accepted inputs across a later file replacement', async () => {
    await open('print(7)'); const bytes = Buffer.alloc(9 * 1024 * 1024, 43);
    const snapshot = await rpc<PersistentSnapshot>('snapshot'); await rpc('write', { path: 'data.bin', content: bytes.toString('base64'), expectedRevision: snapshot.revision });
    await worker('registerDevice', { device: { id: 'vps', name: 'CPU', python: 'python', cpu: 'CPU', gpus: [], ready: true, isolation: 'test protocol adapter' } });
    const run = await rpc<PersistentExecution>('execute', { notebook: 'work.ipynb', cellIndex: 0, requestId: 'pinned', expectedRevision: (await rpc<PersistentSnapshot>('snapshot')).revision });
    const current = await rpc<PersistentSnapshot>('snapshot'); await rpc('write', { path: 'data.bin', content: encode('new'), expectedRevision: current.revision });
    const claimed = await worker<{ command: PersistentCommand }>('claim'); const input = claimed.command.files.find((item) => item.path === 'data.bin')!;
    assert.equal(input.content, undefined); assert.equal(input.sha256, hash(bytes)); const reconstructed: Buffer[] = [];
    for (let offset = 0; offset < bytes.length;) {
      const chunk = await worker<{ content: string; offset: number }>('readChunk', { path: 'data.bin', offset, executionId: run.id, commandId: claimed.command.id, generation: run.generation });
      reconstructed.push(Buffer.from(chunk.content, 'base64')); assert.ok(chunk.offset > offset); offset = chunk.offset;
    }
    assert.deepEqual(Buffer.concat(reconstructed), bytes);
    await worker('report', { executionId: run.id, commandId: claimed.command.id, generation: run.generation, offset: 0, events: [], state: 'completed' });
  });
  it('publishes a chunked model atomically and deduplicates chunk and final report retries', async () => {
    await open('print(7)'); await worker('registerDevice', { device: { id: 'vps', name: 'CPU', python: 'python', cpu: 'CPU', gpus: [], ready: true, isolation: 'test protocol adapter' } });
    const run = await rpc<PersistentExecution>('execute', { notebook: 'work.ipynb', cellIndex: 0, requestId: 'model', expectedRevision: (await rpc<PersistentSnapshot>('snapshot')).revision });
    const { command } = await worker<{ command: PersistentCommand }>('claim'); const bytes = Buffer.alloc(5 * 1024 * 1024, 77); const uploadId = hash('model'); const sha256 = hash(bytes);
    const partial = path.join(root, 'server', 'sessions', membership.sessionId, 'uploads', run.id); await mkdir(partial, { recursive: true });
    await writeFile(path.join(partial, uploadId + '.bin'), bytes.subarray(0, 17));
    for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
      const input = { executionId: run.id, commandId: command.id, generation: run.generation, uploadId, path: 'model.bin', size: bytes.length, sha256, version: 0, offset, content: bytes.subarray(offset, offset + 256 * 1024).toString('base64') };
      const accepted = await worker<{ offset: number }>('artifactChunk', input); assert.deepEqual(await worker('artifactChunk', input), accepted);
    }
    const report = { executionId: run.id, commandId: command.id, generation: run.generation, offset: 0, events: [], state: 'completed', files: [{ path: 'model.bin', uploadId, size: bytes.length, sha256, version: 0 }] };
    await worker('report', report); const first = await rpc<PersistentSnapshot>('snapshot'); await worker('report', report);
    assert.equal((await rpc<PersistentSnapshot>('snapshot')).revision, first.revision);
    assert.equal(hash(Buffer.from((await rpc<{ content: string }>('read', { path: 'model.bin' })).content, 'base64')), sha256);
    await server.stop();
    const metadata = path.join(root, 'server', 'sessions', membership.sessionId, 'session.json'); const record = JSON.parse(await readFile(metadata, 'utf8'));
    record.executions.find((item: any) => item.execution.id === run.id).mergePending = true; await writeFile(metadata, JSON.stringify(record));
    server = new VpsServer({ dataDirectory: path.join(root, 'server'), clientToken: 'A'.repeat(40), agentTokens: { vps: 'B'.repeat(40) } });
    const endpoint = `http://127.0.0.1:${await server.start()}`; member.dispose(); agent.dispose();
    member = new PersistentClient(endpoint, { kind: 'membership', token: membership.token }); agent = new PersistentClient(endpoint, { kind: 'membership', token: 'B'.repeat(40) });
    const recovered = await rpc<PersistentExecution>('execution', { executionId: run.id }); assert.equal(recovered.state, 'completed'); assert.equal(recovered.error, undefined);
    assert.equal((await rpc<PersistentSnapshot>('snapshot')).entries.find((entry) => entry.path === 'model.bin')?.version, first.entries.find((entry) => entry.path === 'model.bin')?.version);
  });
  it('performs no repeated content reads during an idle folder cycle', async () => {
    const local = path.join(root, 'local'); await mkdir(local); let snapshot = await rpc<PersistentSnapshot>('mkdir', { path: 'shared', expectedRevision: 0 });
    for (let index = 0; index < 12; index++) { await writeFile(path.join(local, `${index}.txt`), 'x'); snapshot = await rpc('write', { path: `shared/${index}.txt`, content: encode('x'), expectedRevision: snapshot.revision }); }
    let reads = 0; let snapshots = 0; const client = { call: <T>(operation: string, fields: Record<string, unknown>): Promise<T> => { if (operation === 'read') reads++; if (operation === 'snapshot') snapshots++; return member.call(operation, fields); } } as PersistentClient;
    const sync = new PersistentFolderSync({ localRoot: local, remoteRoot: 'shared', journal: path.join(root, 'journal'), sessionId: membership.sessionId, client, current: () => true, conflict: async () => 'later' });
    await sync.cycle(); reads = 0; snapshots = 0; await sync.cycle(); assert.equal(reads, 0); assert.equal(snapshots, 1);
  });
});
