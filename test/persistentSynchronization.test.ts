import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { encodeRelativeOffset } from '../src/core/cursorPosition';
import type { PersistentLiveEvent } from '../src/vps/persistentLive';
const encoded = (value: string): string => Buffer.from(value).toString('base64');

describe('Persistent continuous synchronization over actual HTTP', () => {
  let root: string; let server: VpsServer; let client: PersistentClient; let member: PersistentClient; let owner: PersistentMembership; let endpoint: string;
  const rpc = <T = any>(operation: string, fields: Record<string, unknown> = {}): Promise<T> => client.call(operation, { sessionId: owner.sessionId, ...fields });
  it('stops cleanly while an authenticated live stream remains open', async () => {
    let ready!: () => void; const connected = new Promise<void>((resolve) => { ready = resolve; });
    const stream = client.subscribe(owner.sessionId, (event) => { if (event.kind === 'ready') ready(); }, () => undefined);
    try {
      await connected;
      let timer!: NodeJS.Timeout;
      try { await Promise.race([server.stop(), new Promise<void>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Live stream prevented graceful shutdown')), 1000); })]); }
      finally { clearTimeout(timer); }
    } finally { stream.dispose(); }
  });
  beforeEach(async () => {
    installProxyAwareWebSocket({ env: {} }); root = await mkdtemp(path.join(os.tmpdir(), 'pair-sync-')); server = new VpsServer({ dataDirectory: path.join(root, 'server'), clientToken: 'A'.repeat(40), agentTokens: { vps: 'Z'.repeat(40) } });
    endpoint = `http://127.0.0.1:${await server.start()}`;
    owner = await new PersistentClient(endpoint, { kind: 'admin', token: 'A'.repeat(40) }).call('create', { name: 'Sync test', password: 'sync test password' });
    client = new PersistentClient(endpoint, { kind: 'membership', token: owner.token });
    const joined = await new PersistentClient(endpoint, { kind: 'anonymous' }).call<PersistentMembership>('join', { sessionId: owner.sessionId, name: 'Collaborator', password: 'sync test password' });
    member = new PersistentClient(endpoint, { kind: 'membership', token: joined.token });
  });
  afterEach(async () => { await server.stop(); await rm(root, { recursive: true, force: true }); installProxyAwareWebSocket({ env: {} }); });
  const liveNotebook = async (source = 'owner\nmember'): Promise<NotebookSyncReply> => {
    await rpc('write', { path: 'book.ipynb', expectedRevision: 0, content: encoded(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ id: 'stable', cell_type: 'code', source, metadata: {}, outputs: [] }] })) });
    return rpc<NotebookSyncReply>('notebookSync', { path: 'book.ipynb' });
  };
  const linePresence = async (start: NotebookSyncReply, offset: number): Promise<void> => {
    const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(start.update, 'base64')); const text = doc.getMap<Y.Map<unknown>>('cells').get('stable')!.get('source') as Y.Text;
    await rpc('presence', { path: 'book.ipynb', epoch: start.epoch, cellId: 'stable', activeLineAnchor: encodeRelativeOffset(text, offset) }); doc.destroy();
  };
  it('pushes committed edits to another authenticated client without a polling request', async () => {
    const start = await liveNotebook(); const events: PersistentLiveEvent[] = [];
    const stream = member.subscribe(owner.sessionId, (event) => events.push(event), () => undefined);
    try {
      for (let n = 0; n < 100 && !events.some((event) => event.kind === 'ready'); n++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(events.some((event) => event.kind === 'ready'));
      const actor = 'A'.repeat(36); await rpc('notebookSync', { path: 'book.ipynb', epoch: start.epoch, intent: { actor, sequence: 1, cellId: 'stable', baseline: 'owner\nmember', changes: [{ offset: 5, deleteCount: 0, insertText: '!' }] } });
      for (let n = 0; n < 100 && !events.some((event) => event.kind === 'notebook'); n++) await new Promise((resolve) => setTimeout(resolve, 10));
      const pushed = events.find((event) => event.kind === 'notebook'); assert.ok(pushed && pushed.kind === 'notebook');
      const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(start.update, 'base64')); Y.applyUpdate(doc, Buffer.from(pushed.update, 'base64')); assert.equal(sharedNotebook(doc).cells[0]!.source, 'owner!\nmember'); doc.destroy();
    } finally { stream.dispose(); }
  });
  it('pushes execution discovery and live output availability, then fences it after a privacy change', async () => {
    const start = await liveNotebook('print(7)'); const agent = new PersistentClient(endpoint, { kind: 'membership', token: 'Z'.repeat(40) });
    await agent.call('registerDevice', { sessionId: owner.sessionId, deviceId: 'vps', device: { id: 'vps', name: 'VPS CPU', python: 'python3', cpu: 'CPU', gpus: [], isolation: 'protocol test adapter', ready: true } });
    const run = await rpc<any>('execute', { notebook: 'book.ipynb', cellIndex: 0, expectedRevision: start.revision, requestId: 'live-output-test' });
    const events: PersistentLiveEvent[] = []; const stream = member.subscribe(owner.sessionId, (event) => events.push(event), () => undefined);
    try {
      for (let n = 0; n < 100 && !events.some((event) => event.kind === 'execution'); n++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.ok(events.some((event) => event.kind === 'execution' && event.id === run.id));
      const active = await member.call<{ executions: any[] }>('executions', { sessionId: owner.sessionId }); assert.equal(active.executions[0]!.id, run.id); assert.deepEqual(active.executions[0]!.events, []);
      const claimed = await agent.call<any>('claim', { sessionId: owner.sessionId, deviceId: 'vps' }); const command = claimed.command;
      await agent.call('report', { sessionId: owner.sessionId, deviceId: 'vps', executionId: run.id, commandId: command.id, generation: command.generation, offset: 0, state: 'running', events: [{ type: 'iopub', requestId: command.id, messageType: 'stream', content: { name: 'stdout', text: 'shared 7\n' } }] });
      const running = await member.call<any>('execution', { sessionId: owner.sessionId, executionId: run.id }); assert.equal(running.events[0].content.text, 'shared 7\n');
      for (let n = 0; n < 100 && !events.some((event) => event.kind === 'execution' && event.execution?.events.length === 1); n++) await new Promise((resolve) => setTimeout(resolve, 10));
      const inline = events.find((event) => event.kind === 'execution' && event.execution?.events.length === 1);
      assert.ok(inline?.kind === 'execution'); assert.equal((inline.execution!.events[0]!.content as any).text, 'shared 7\n');
      await agent.call('report', { sessionId: owner.sessionId, deviceId: 'vps', executionId: run.id, commandId: command.id, generation: command.generation, offset: 1, state: 'running', events: [{ type: 'iopub', requestId: command.id, messageType: 'stream', content: { name: 'stdout', text: 'X'.repeat(70 * 1024) } }] });
      for (let n = 0; n < 100 && events.filter((event) => event.kind === 'execution').at(-1)?.execution !== undefined; n++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(events.filter((event) => event.kind === 'execution').at(-1)?.execution, undefined, 'Large cumulative output falls back to bounded notification');
      await rpc('visibility', { path: 'book.ipynb', visibility: 'private', expectedRevision: (await rpc<any>('snapshot')).revision });
      await new Promise((resolve) => setTimeout(resolve, 30)); const previous = events.filter((event) => event.kind === 'execution').length;
      await agent.call('report', { sessionId: owner.sessionId, deviceId: 'vps', executionId: run.id, commandId: command.id, generation: command.generation, offset: 2, state: 'completed', events: [{ type: 'iopub', requestId: command.id, messageType: 'stream', content: { name: 'stdout', text: 'PRIVATE_AFTER_PRIVACY\n' } }] });
      await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(events.filter((event) => event.kind === 'execution').length, previous);
      assert.equal(JSON.stringify(events).includes('PRIVATE_AFTER_PRIVACY'), false); await assert.rejects(member.call('execution', { sessionId: owner.sessionId, executionId: run.id }));
      assert.deepEqual((await member.call<{ executions: any[] }>('executions', { sessionId: owner.sessionId })).executions, []);
    } finally { stream.dispose(); }
  });
  it('allows concurrent edits on the same selected row and returns durable actor receipts', async () => {
    const start = await liveNotebook(); await linePresence(start, 0);
    const ownerActor = 'B'.repeat(36); const memberActor = 'C'.repeat(36);
    const update = (value: string, clientId: number): string => {
      const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(start.update, 'base64')); doc.clientID = clientId;
      const vector = Y.encodeStateVector(doc); (doc.getMap<Y.Map<unknown>>('cells').get('stable')!.get('source') as Y.Text).insert(1, value);
      const bytes = Buffer.from(Y.encodeStateAsUpdate(doc, vector)).toString('base64'); doc.destroy(); return bytes;
    };
    await rpc('notebookSync', { path: 'book.ipynb', epoch: start.epoch, intent: { actor: ownerActor, sequence: 1, cellId: 'stable', baseline: 'owner\nmember', changes: [{ offset: 1, deleteCount: 0, insertText: '!' }], update: update('!', 101) } });
    const result = await member.call<NotebookSyncReply>('notebookSync', { sessionId: owner.sessionId, path: 'book.ipynb', epoch: start.epoch, intent: { actor: memberActor, sequence: 1, cellId: 'stable', baseline: 'owner\nmember', changes: [{ offset: 1, deleteCount: 0, insertText: '?' }], update: update('?', 102) } });
    assert.equal(result.cells[0]!.source, 'o!?wner\nmember'); assert.equal(result.acknowledgedSequence, 1);
    assert.equal((await rpc<NotebookSyncReply>('notebookSync', { path: 'book.ipynb', actor: ownerActor })).acknowledgedSequence, 1);
    assert.equal((await rpc<NotebookSyncReply>('notebookSync', { path: 'book.ipynb', actor: memberActor })).acknowledgedSequence, 0);
  });
  it('admits an unchanged cell while another cell is edited, and fences a full file replacement', async () => {
    const initial = await liveNotebook('print(7)'); const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(initial.update, 'base64'));
    const before = sharedNotebook(doc); before.cells.push({ id: 'other', cell_type: 'code', source: 'b = 1', metadata: {} }); editSharedNotebook(doc, before);
    const acknowledged = await rpc<NotebookSyncReply>('notebookSync', { path: 'book.ipynb', epoch: initial.epoch, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') });
    const after = sharedNotebook(doc); after.cells[1]!.source = 'b = 2'; editSharedNotebook(doc, after);
    await member.call('notebookSync', { sessionId: owner.sessionId, path: 'book.ipynb', epoch: initial.epoch, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') });
    const agent = new PersistentClient(endpoint, { kind: 'membership', token: 'Z'.repeat(40) });
    await agent.call('registerDevice', { sessionId: owner.sessionId, deviceId: 'vps', device: { id: 'vps', name: 'CPU', python: 'python3', cpu: 'CPU', gpus: [], isolation: 'protocol test adapter', ready: true } });
    const fields = { notebook: 'book.ipynb', cellIndex: 0, expectedRevision: acknowledged.revision, expectedNotebookIdentity: acknowledged.identity, expectedCellId: 'stable', expectedSourceHash: createHash('sha256').update('print(7)').digest('hex') };
    assert.equal((await rpc<any>('execute', { ...fields, requestId: 'unchanged-cell' })).state, 'queued');
    const replacement = await rpc<any>('read', { path: 'book.ipynb' });
    const raw = JSON.parse(Buffer.from(replacement.content, 'base64').toString('utf8')); raw.metadata.userReplacement = true;
    await rpc('write', { path: 'book.ipynb', content: encoded(JSON.stringify(raw)), expectedRevision: replacement.revision });
    await assert.rejects(rpc('execute', { ...fields, requestId: 'after-replacement', expectedRevision: (await rpc<any>('snapshot')).revision }), /changed/);
    const renewed = await rpc<NotebookSyncReply>('notebookSync', { path: 'book.ipynb' }); assert.notEqual(renewed.identity, acknowledged.identity); assert.notEqual(renewed.epoch, initial.epoch); assert.equal(renewed.cells[1]!.source, 'b = 2'); doc.destroy();
  });
  it('releases the row after a disconnected stream and after its real presence timeout', async () => {
    const start = await liveNotebook(); const events: PersistentLiveEvent[] = [];
    const stream = client.subscribe(owner.sessionId, (event) => events.push(event), () => undefined);
    for (let n = 0; n < 100 && !events.some((event) => event.kind === 'ready'); n++) await new Promise((resolve) => setTimeout(resolve, 10));
    await linePresence(start, 0); stream.dispose(); await new Promise((resolve) => setTimeout(resolve, 50));
    const intent = { actor: 'F'.repeat(36), sequence: 1, cellId: 'stable', baseline: 'owner\nmember', changes: [{ offset: 1, deleteCount: 0, insertText: 'free' }] };
    const result = await member.call<NotebookSyncReply>('notebookSync', { sessionId: owner.sessionId, path: 'book.ipynb', epoch: start.epoch, intent }); assert.equal(result.cells[0]!.source, 'ofreewner\nmember');
    await linePresence(result, 0); await new Promise((resolve) => setTimeout(resolve, 5100));
    intent.sequence = 2; intent.baseline = result.cells[0]!.source; intent.changes = [{ offset: 0, deleteCount: 0, insertText: 'after-timeout ' }];
    assert.equal((await member.call<NotebookSyncReply>('notebookSync', { sessionId: owner.sessionId, path: 'book.ipynb', epoch: start.epoch, intent })).cells[0]!.source, 'after-timeout ofreewner\nmember');
  });
  it('persists host text intent identity through lost acknowledgement and server restart', async () => {
    const start = await liveNotebook(); const request = { path: 'book.ipynb', epoch: start.epoch, intent: { actor: 'D'.repeat(36), sequence: 1, cellId: 'stable', baseline: 'owner\nmember', changes: [{ offset: 5, deleteCount: 0, insertText: '!' }] } };
    const accepted = await rpc<NotebookSyncReply>('notebookSync', request);
    assert.equal((await rpc<NotebookSyncReply>('notebookSync', request)).revision, accepted.revision);
    await server.stop(); server = new VpsServer({ dataDirectory: path.join(root, 'server'), clientToken: 'A'.repeat(40), agentTokens: {} }); endpoint = `http://127.0.0.1:${await server.start()}`; client = new PersistentClient(endpoint, { kind: 'membership', token: owner.token });
    const recovered = await rpc<NotebookSyncReply>('notebookSync', request); assert.equal(recovered.revision, accepted.revision); assert.equal(recovered.cells[0]!.source, 'owner!\nmember');
  });
  it('filters Private cursor and notebook events from the member stream', async () => {
    await rpc('write', { path: 'secret.ipynb', expectedRevision: 0, visibility: 'private', content: encoded(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ id: 'stable', cell_type: 'code', source: 'private', metadata: {}, outputs: [] }] })) });
    const events: PersistentLiveEvent[] = []; const stream = member.subscribe(owner.sessionId, (event) => events.push(event), () => undefined);
    try {
      const start = await rpc<NotebookSyncReply>('notebookSync', { path: 'secret.ipynb' }); const doc = new Y.Doc(); Y.applyUpdate(doc, Buffer.from(start.update, 'base64')); const text = doc.getMap<Y.Map<unknown>>('cells').get('stable')!.get('source') as Y.Text;
      await rpc('presence', { path: 'secret.ipynb', epoch: start.epoch, cellId: 'stable', activeLineAnchor: encodeRelativeOffset(text, 0) }); doc.destroy();
      await rpc('notebookSync', { path: 'secret.ipynb', epoch: start.epoch, intent: { actor: 'E'.repeat(36), sequence: 1, cellId: 'stable', baseline: 'private', changes: [{ offset: 7, deleteCount: 0, insertText: '!' }] } });
      await new Promise((resolve) => setTimeout(resolve, 50)); assert.equal(JSON.stringify(events).includes('secret.ipynb'), false); assert.equal(JSON.stringify(events).includes('private!'), false);
    } finally { stream.dispose(); }
  });
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
  it('retains saved output and execution count when live source is edited before another execution', async () => {
    const output = { output_type: 'stream', name: 'stdout', text: 'saved 7\n' };
    await rpc('write', { path: 'book.ipynb', expectedRevision: 0, content: encoded(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ id: 'stable', cell_type: 'code', source: 'print(7)', metadata: {}, outputs: [output], execution_count: 7 }] })) });
    const start = await rpc<NotebookSyncReply>('notebookSync', { path: 'book.ipynb' });
    await member.call('notebookSync', { sessionId: owner.sessionId, path: 'book.ipynb', epoch: start.epoch, intent: { actor: 'K'.repeat(36), sequence: 1, cellId: 'stable', baseline: 'print(7)', changes: [{ offset: 6, deleteCount: 1, insertText: '8' }] } });
    const saved = await rpc<{ content: string }>('read', { path: 'book.ipynb' });
    const cell = JSON.parse(Buffer.from(saved.content, 'base64').toString()).cells[0];
    assert.equal(cell.source, 'print(8)'); assert.equal(cell.execution_count, 7); assert.deepEqual(cell.outputs, [output]);
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
  it('keeps ambiguous offline Private rename plus edits Private across lost ACK and journal reload', async () => {
    const localRoot = path.join(root, 'lineage'); await mkdir(localRoot);
    const snapshot = await rpc<PersistentSnapshot>('mkdir', { path: 'public-root', expectedRevision: 0 });
    await rpc<PersistentSnapshot>('write', { path: 'public-root/private.txt', visibility: 'private', content: encoded('private original'), expectedRevision: snapshot.revision });
    const options = { localRoot, remoteRoot: 'public-root', journal: path.join(root, 'lineage.json'), sessionId: owner.sessionId, client, current: () => true, conflict: async () => 'later' as const };
    let sync = new PersistentFolderSync(options); await sync.cycle();
    await rename(path.join(localRoot, 'private.txt'), path.join(localRoot, 'moved.txt')); await writeFile(path.join(localRoot, 'moved.txt'), 'private modified');
    const original = client.call.bind(client); let lost = false;
    client.call = async (operation, input) => { const result = await original(operation, input); if (operation === 'remove' && !lost) { lost = true; throw new Error('Deletion acknowledgement lost'); } return result as any; };
    await assert.rejects(sync.cycle(), /acknowledgement/); client.call = original; sync = new PersistentFolderSync(options); await sync.cycle();
    const result = await rpc<PersistentSnapshot>('snapshot'); assert.equal(result.entries.find((entry) => entry.path === 'public-root/moved.txt')?.visibility, 'private');
    await assert.rejects(member.call('read', { sessionId: owner.sessionId, path: 'public-root/moved.txt' }), /unavailable/);
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
