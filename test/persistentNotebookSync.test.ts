import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import type * as vscode from 'vscode';
import { editSharedNotebook, sharedNotebook, type NotebookSyncReply } from '../src/vps/persistentNotebookCrdt';
import { rebaseTextChanges } from '../src/core/textChanges';
import { resolveSharedCursorPosition } from '../src/core/cursorPosition';
import { createEditorVscodeBoundary } from './editorVscodeBoundary';
import type { PersistentLiveEvent } from '../src/vps/persistentLive';
import { PersistentHttpError } from '../src/vps/persistentClient';

const { vscodeBoundary: boundary, fakeCell, fakeNotebook } = createEditorVscodeBoundary();
boundary.Position = class { constructor(public readonly line: number, public readonly character: number) {} };
boundary.workspace.onDidCloseNotebookDocument = () => ({ dispose() {} });
Object.assign(boundary.window, { state: { focused: false }, onDidChangeTextEditorSelection: () => ({ dispose() {} }), onDidChangeActiveTextEditor: () => ({ dispose() {} }), onDidChangeWindowState: () => ({ dispose() {} }), onDidChangeVisibleTextEditors: () => ({ dispose() {} }) });
const loader = Module as typeof Module & { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load; const before = new Set(Object.keys(require.cache));
const cachedEditors = new Map<string, NodeModule>();
for (const relative of ['../src/vscode/sync', '../src/vscode/presence', '../src/vscode/persistentNotebookSync']) { const id = require.resolve(relative); const cached = require.cache[id]; if (cached) cachedEditors.set(id, cached); delete require.cache[id]; }
loader._load = function (request, parent, isMain): unknown { return request === 'vscode' ? boundary : originalLoad.call(this, request, parent, isMain); };
let Sync: typeof import('../src/vscode/persistentNotebookSync').PersistentNotebookSynchronizer;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Sync = require('../src/vscode/persistentNotebookSync').PersistentNotebookSynchronizer;
} finally { loader._load = originalLoad; for (const id of Object.keys(require.cache)) if (!before.has(id) && id.includes(`${path.sep}src${path.sep}`)) delete require.cache[id]; for (const [id, cached] of cachedEditors) require.cache[id] = cached; }

describe('Persistent adapter through the existing production editor', () => {
  let root: string; let doc: Y.Doc; let sync: InstanceType<typeof Sync>; let connection: any; let notebook: any; let cell: any;
  let gate: (() => Promise<void>) | undefined; let lostAck: boolean; let epoch: string; let push: ((event: PersistentLiveEvent) => void) | undefined;
  const sequences = new Map<string, number>();
  let rawOutputs: unknown[];
  let intentCalls: number;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pair-editor-replica-')); cell = fakeCell('base', 'stable'); notebook = fakeNotebook(root, [cell]);
    notebook.uri = { scheme: 'pair-vps', authority: 'session', path: '/book.ipynb', toString: () => 'pair-vps://session/book.ipynb' };
    boundary.__reset(notebook); doc = new Y.Doc(); editSharedNotebook(doc, { metadata: {}, cells: [{ id: 'stable', cell_type: 'code', source: 'base', metadata: {} }] });
    gate = undefined; lostAck = false; epoch = 'epoch'; rawOutputs = []; sequences.clear(); intentCalls = 0;
    const client = { subscribe: (_id: string, receive: (event: PersistentLiveEvent) => void) => { push = receive; return { dispose() { push = undefined; } }; }, call: async (operation: string, input: any): Promise<any> => {
      if (operation === 'presence') return { states: [] };
      if (operation === 'read') return { content: Buffer.from(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: sharedNotebook(doc).cells.map((item) => ({ ...item, outputs: rawOutputs, execution_count: null })) })).toString('base64') };
      if (input.epoch !== undefined && input.epoch !== epoch) throw new PersistentHttpError(409);
      if (input.update) Y.applyUpdate(doc, Buffer.from(input.update, 'base64'));
      if (input.snapshot) editSharedNotebook(doc, input.snapshot);
      if (input.intent) intentCalls++;
      if (input.intent && (sequences.get(input.intent.actor) ?? 0) < input.intent.sequence) {
        const intent = input.intent; const text = doc.getMap<Y.Map<unknown>>('cells').get(intent.cellId)!.get('source') as Y.Text;
        if (intent.update) Y.applyUpdate(doc, Buffer.from(intent.update, 'base64'));
        else for (const change of rebaseTextChanges(intent.baseline, text.toString(), intent.changes).sort((a, b) => b.offset - a.offset)) { if (change.deleteCount) text.delete(change.offset, change.deleteCount); if (change.insertText) text.insert(change.offset, change.insertText); }
        sequences.set(intent.actor, intent.sequence);
      }
      const reply: NotebookSyncReply = { epoch, revision: 1, textProtocol: 'yjs-intents-v1', identity: '0123456789abcdef0123456789abcdef', acknowledgedSequence: sequences.get(input.actor ?? input.intent?.actor) ?? 0, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'), ...sharedNotebook(doc) };
      const blocked = gate; gate = undefined; if (blocked) await blocked();
      if (lostAck && input.intent) { lostAck = false; throw new Error('Acknowledgement lost after server commit'); }
      return reply;
    } };
    connection = { endpoint: 'https://example.com', sessionId: 'session', memberId: 'member', client };
    sync = new Sync({ globalStorageUri: { fsPath: root } } as vscode.ExtensionContext, () => connection);
  });
  afterEach(async () => { await sync.shutdown(); doc.destroy(); await rm(root, { recursive: true, force: true }); });
  const change = (offset: number, length: number, insert: string): void => { const document = cell.document; document.text = document.text.slice(0, offset) + insert + document.text.slice(offset + length); document.isDirty = true; boundary.__fireTextChange(document, [{ rangeOffset: offset, rangeLength: length, text: insert }]); };
  const pause = (): { reached: Promise<void>; release(): void } => { let release!: () => void; let arrived!: () => void; const reached = new Promise<void>((resolve) => { arrived = resolve; }); const waiting = new Promise<void>((resolve) => { release = resolve; }); gate = async () => { arrived(); await waiting; }; return { reached, release }; };
  it('retains genuine input during the handshake and an older response', async () => {
    const initial = pause(); const first = sync.flush(notebook); await initial.reached; change(4, 0, '-local'); initial.release(); await first; await sync.flush(notebook);
    assert.equal(cell.document.text, 'base-local'); assert.equal(sharedNotebook(doc).cells[0]!.source, 'base-local');
    const late = pause(); const pending = sync.flush(notebook); await late.reached; change(cell.document.text.length, 0, '!'); late.release(); await pending; await sync.flush(notebook);
    assert.equal(cell.document.text, 'base-local!'); assert.equal(sharedNotebook(doc).cells[0]!.source, 'base-local!');
  });
  it('recovers a rejected bootstrap promise after a transient connection error', async () => {
    const original = connection.client.call; let fail = true;
    connection.client.call = async (operation: string, input: any) => {
      if (operation === 'notebookSync' && fail) { fail = false; throw new Error('temporary outage'); }
      return original(operation, input);
    };
    await assert.rejects(sync.flush(notebook), /temporary outage/);
    await sync.flush(notebook); change(4, 0, '-recovered'); await sync.flush(notebook);
    assert.equal(sharedNotebook(doc).cells[0]!.source, 'base-recovered');
  });
  it('archives a corrupt local journal and initializes a usable replica', async () => {
    await sync.flush(notebook);
    const filename = (sync as any).states.get(notebook).file;
    await sync.shutdown();
    const { writeFile } = await import('node:fs/promises'); await writeFile(filename, '{corrupt');
    sync = new Sync({ globalStorageUri: { fsPath: root } } as vscode.ExtensionContext, () => connection);
    await sync.flush(notebook); change(4, 0, '!'); await sync.flush(notebook);
    assert.equal(sharedNotebook(doc).cells[0]!.source, 'base!');
    assert.ok((await readdir(path.dirname(filename))).some((name) => name.includes('.invalid-')));
  });
  it('archives a permanently rejected update and allows subsequent valid typing', async () => {
    await sync.flush(notebook); const call = connection.client.call; let rejected = false;
    connection.client.call = async (operation: string, input: any) => { if (!rejected && input.intent) { rejected = true; throw new PersistentHttpError(413); } return call(operation, input); };
    change(4, 0, '-too-large'); await assert.rejects(sync.flush(notebook));
    for (let n = 0; n < 100 && cell.document.text !== 'base'; n++) await new Promise((resolve) => setTimeout(resolve, 5));
    await sync.flush(notebook); assert.equal(cell.document.text, 'base'); change(4, 0, '!'); await sync.flush(notebook);
    assert.equal(sharedNotebook(doc).cells[0]!.source, 'base!');
    assert.ok((await readdir(path.join(root, 'persistent-replicas'))).some((name) => name.includes('.conflict-')));
  });
  it('projects a one-cell source push without snapshotting unrelated rich cell state', async () => {
    await sync.flush(notebook); const state = (sync as any).states.get(notebook);
    (sync as any).applyCanonical(state); // Finish the bootstrap structure projection.
    const stacks: string[] = []; const snapshot = state.project.notebookSnapshot.bind(state.project);
    state.project.notebookSnapshot = (...args: unknown[]) => { stacks.push(new Error().stack ?? 'snapshot'); return snapshot(...args); };
    const shared = sharedNotebook(doc); shared.cells[0]!.source = 'peer'; editSharedNotebook(doc, shared);
    push!({ kind: 'notebook', path: 'book.ipynb', epoch, revision: 2, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') });
    for (let n = 0; n < 100 && cell.document.text !== 'peer'; n++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(cell.document.text, 'peer'); assert.equal(stacks.length, 0, stacks.join('\n'));
  });
  it('uses a push update immediately without waiting for poll or save', async () => {
    await sync.flush(notebook); const shared = sharedNotebook(doc); shared.cells[0]!.source = 'remote base'; editSharedNotebook(doc, shared);
    push!({ kind: 'notebook', path: 'book.ipynb', epoch: 'epoch', revision: 2, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') });
    for (let n = 0; n < 100 && cell.document.text !== 'remote base'; n++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(cell.document.text, 'remote base');
  });
  it('ignores a late stream callback from a replaced connection', async () => {
    await sync.flush(notebook); const oldReceive = push!;
    connection = { ...connection }; await sync.flush(notebook);
    const shared = sharedNotebook(doc); shared.cells[0]!.source = 'current stream'; editSharedNotebook(doc, shared);
    const event: PersistentLiveEvent = { kind: 'notebook', path: 'book.ipynb', epoch, revision: 2, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') };
    oldReceive(event); await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(cell.document.text, 'base');
    push!(event);
    for (let n = 0; n < 100 && cell.document.text !== 'current stream'; n++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(cell.document.text, 'current stream');
  });
  it('does not roll back fast local deletion when its own earlier publication arrives', async () => {
    await sync.flush(notebook);
    const delayed = pause(); change(4, 0, '!'); await delayed.reached;
    change(0, 5, '');
    const actor = [...sequences.keys()][0]!;
    push!({ kind: 'notebook', path: 'book.ipynb', epoch, revision: 2, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'), acknowledgement: { actor, sequence: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(cell.document.text, '', 'An unacknowledged deletion must stay visible');
    delayed.release(); await sync.flush(notebook);
    assert.equal(cell.document.text, ''); assert.equal(sharedNotebook(doc).cells[0]!.source, '');
  });
  it('prepares a VPS working copy without recursively invoking the notebook save provider', async () => {
    let saves = 0; notebook.save = async () => { saves++; throw new Error('Reentered native save'); };
    await sync.flush(notebook, true); assert.equal(saves, 0);
    change(4, 0, '-local'); await sync.flush(notebook, true); assert.equal(saves, 0);
    assert.equal(sharedNotebook(doc).cells[0]!.source, 'base-local');
  });
  it('prepares execution from acknowledged live source without redundant reads or queries', async () => {
    await sync.flush(notebook);
    const calls: string[] = []; const original = connection.client.call;
    connection.client.call = async (operation: string, input: any) => { calls.push(operation); return original(operation, input); };
    const unchanged = await sync.prepareExecution(notebook);
    assert.equal(unchanged?.identity, '0123456789abcdef0123456789abcdef');
    assert.equal(calls.filter((operation) => operation !== 'presence').length, 0);
    change(4, 0, '-run'); const prepared = await sync.prepareExecution(notebook);
    assert.equal(prepared?.cells[0]?.source, 'base-run');
    assert.equal(sharedNotebook(doc).cells[0]!.source, 'base-run');
    assert.equal(calls.filter((operation) => operation === 'notebookSync').length, 1);
    assert.equal(calls.includes('read'), false);
  });
  for (const scenario of [
    { name: 'newline', offset: 0, remove: 0, insert: 'new\n', line: 1, active: 8 },
    { name: 'replacement boundary', offset: 3, remove: 1, insert: 'X', line: 0, active: 4 },
  ]) it(`publishes and renders relative cursors through a pending ${scenario.name} before its acknowledgement`, async () => {
    await sync.flush(notebook); const delayed = pause(); change(scenario.offset, scenario.remove, scenario.insert); await delayed.reached;
    const previous = boundary.window.activeTextEditor; let published: any;
    const original = connection.client.call;
    connection.client.call = async (operation: string, input: any) => { if (operation === 'presence') published = input; return original(operation, input); };
    cell.document.offsetAt = (position: any) => cell.document.text.split('\n').slice(0, position.line).reduce((length: number, line: string) => length + line.length + 1, 0) + position.character;
    boundary.window.activeTextEditor = { document: cell.document, selection: { anchor: { line: scenario.line, character: 4 }, active: { line: scenario.line, character: 4 } } };
    try {
      await (sync as any).publishPresence(); assert.ok(published?.cursor, 'Cursor renewal must not wait for the text ACK');
      const text = doc.getMap<Y.Map<unknown>>('cells').get('stable')!.get('source') as Y.Text;
      assert.equal(resolveSharedCursorPosition(text, published.cursor)?.active, scenario.active);
      const rendered = (sync as any).renderer.runtime.resolvePresenceCursor({ activeFile: 'book.ipynb', activeNotebookCellId: 'stable', cursor: published.cursor });
      assert.equal(rendered.active, scenario.active, 'A confirmed relative cursor must map through local pending text into the visible editor');
    } finally { boundary.window.activeTextEditor = previous; delayed.release(); }
    await sync.flush(notebook);
  });
  it('suppresses unchanged cursor packets between renewals without delaying movement or expiring an idle cursor', async () => {
    await sync.flush(notebook); const previous = boundary.window.activeTextEditor; let published = 0;
    const original = connection.client.call;
    connection.client.call = async (operation: string, input: any) => { if (operation === 'presence') published++; return original(operation, input); };
    cell.document.offsetAt = (position: any) => position.character;
    boundary.window.activeTextEditor = { document: cell.document, selection: { anchor: { line: 0, character: 1 }, active: { line: 0, character: 1 } } };
    try {
      await (sync as any).publishPresence(); await (sync as any).publishPresence(); assert.equal(published, 1);
      boundary.window.activeTextEditor.selection = { anchor: { line: 0, character: 2 }, active: { line: 0, character: 2 } };
      await (sync as any).publishPresence(); assert.equal(published, 2, 'A real cursor move must publish immediately');
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.ok(published >= 3, 'An unchanged idle cursor must still renew its server lease');
    } finally { boundary.window.activeTextEditor = previous; }
  });
  it('coalesces a fast typing and deletion burst behind one immutable in-flight request', async () => {
    await sync.flush(notebook);
    const delayed = pause(); change(4, 0, '!'); await delayed.reached;
    for (let index = 0; index < 150; index++) change(cell.document.text.length, 0, String(index % 10));
    for (let index = 0; index < 150; index++) change(cell.document.text.length - 1, 1, '');
    change(0, cell.document.text.length, 'first\nsecond');
    assert.equal(cell.document.text, 'first\nsecond');
    delayed.release(); await sync.flush(notebook);
    assert.equal(cell.document.text, 'first\nsecond'); assert.equal(sharedNotebook(doc).cells[0]!.source, 'first\nsecond');
    assert.equal(intentCalls, 2, '301 later edits must not require 301 serial network round trips');
  });
  it('commits structure together with its unsent text dependencies while newer input continues', async () => {
    await sync.flush(notebook); const first = pause(); change(4, 0, '!'); await first.reached;
    change(5, 0, '?'); const added = fakeCell('print(7)', 'added'); added.notebook = notebook; added.index = 1; notebook.cells.push(added);
    boundary.__fireNotebookChange(notebook, true);
    let arrived!: () => void; let release!: () => void; const structural = new Promise<void>((resolve) => { arrived = resolve; }); const waiting = new Promise<void>((resolve) => { release = resolve; });
    const call = connection.client.call; let committed: any;
    connection.client.call = async (operation: string, input: any) => { const result = await call(operation, input); if (input.update && !committed) { committed = result; arrived(); await waiting; } return result; };
    first.release(); await structural;
    assert.equal(committed.cells.length, 2, 'Structure must not remain pending behind an unsent text clock');
    assert.equal(committed.cells[0].source, 'base!?'); change(6, 0, '+'); release(); await sync.flush(notebook);
    assert.equal(sharedNotebook(doc).cells[0]!.source, 'base!?+'); assert.equal(sharedNotebook(doc).cells.length, 2);
  });
  it('preserves a remote insertion while newer local text awaits acknowledgement', async () => {
    await sync.flush(notebook);
    const delayed = pause(); change(4, 0, '!'); await delayed.reached; change(5, 0, '-local');
    const actor = [...sequences.keys()][0]!;
    push!({ kind: 'notebook', path: 'book.ipynb', epoch, revision: 2, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'), acknowledgement: { actor, sequence: 1 } });
    const shared = sharedNotebook(doc); shared.cells[0]!.source = 'peer-' + shared.cells[0]!.source; editSharedNotebook(doc, shared);
    push!({ kind: 'notebook', path: 'book.ipynb', epoch, revision: 3, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') });
    await new Promise((resolve) => setTimeout(resolve, 30)); assert.equal(cell.document.text, 'peer-base!-local');
    delayed.release(); await sync.flush(notebook);
    assert.equal(cell.document.text, 'peer-base!-local'); assert.equal(sharedNotebook(doc).cells[0]!.source, 'peer-base!-local');
  });
  it('journals accepted input before a lost ACK and replays its identity once', async () => {
    await sync.flush(notebook); lostAck = true; change(4, 0, '-offline'); await assert.rejects(sync.flush(notebook), /Acknowledgement/);
    const files = await readdir(path.join(root, 'persistent-replicas')); const saved = JSON.parse(await readFile(path.join(root, 'persistent-replicas', files.find((name) => name.endsWith('.json'))!), 'utf8'));
    assert.equal(saved.intents.length, 1); assert.equal(saved.intents[0].changes[0].insertText, '-offline');
    await sync.flush(notebook); assert.equal(sharedNotebook(doc).cells[0]!.source, 'base-offline');
    const late = pause(); const pending = sync.flush(notebook); await late.reached; connection = { ...connection, memberId: 'replacement' }; late.release(); await assert.rejects(pending, /connection changed/);
  });
  it('archives old-epoch input and automatically reconnects after a privacy change', async () => {
    await sync.flush(notebook); epoch = 'public-epoch'; doc.destroy(); doc = new Y.Doc(); editSharedNotebook(doc, { metadata: {}, cells: [{ id: 'stable', cell_type: 'code', source: 'public', metadata: {} }] });
    await assert.rejects(sync.flush(notebook), /changed/); await sync.flush(notebook);
    assert.equal(sharedNotebook(doc).cells[0]!.source, 'public'); assert.equal(cell.document.text, 'public');
    const files = await readdir(path.join(root, 'persistent-replicas')); const archive = files.find((file) => file.includes('conflict')); assert.ok(archive);
    const recovered = JSON.parse(await readFile(path.join(root, 'persistent-replicas', archive), 'utf8')); assert.equal(recovered.displayed[0].source, 'base');
  });
  it('does not enqueue native execution renders for empty serializer summaries during text editing', async () => {
    sync.dispose(); cell.executionSummary = {}; let renders = 0;
    sync = new Sync({ globalStorageUri: { fsPath: root } } as vscode.ExtensionContext, () => connection, { appendLine() {} }, undefined, undefined,
      { isManagingCellState: () => false, renderRemoteCellState: async () => { renders++; } });
    await sync.flush(notebook); change(4, 0, '-local'); await sync.flush(notebook);
    assert.equal(cell.document.text, 'base-local'); assert.equal(renders, 0);
  });
  it('renders durable server outputs and clears them through the existing cell renderer after a privacy reload', async () => {
    sync.dispose(); const renderer = { isManagingCellState: () => false, renderRemoteCellState: async (target: any, request: any) => { target.outputs = [...request.outputs]; } };
    sync = new Sync({ globalStorageUri: { fsPath: root } } as vscode.ExtensionContext, () => connection, { appendLine() {} }, undefined, undefined, renderer);
    rawOutputs = [{ output_type: 'stream', name: 'stdout', text: 'private-saved-output' }]; await sync.flush(notebook);
    assert.equal(Buffer.from(cell.outputs[0].items[0].data).toString(), 'private-saved-output');
    const warning = boundary.window.showWarningMessage; boundary.window.showWarningMessage = async () => 'Preserve replica and reload';
    try {
      epoch = 'new-public-epoch'; rawOutputs = []; doc.destroy(); doc = new Y.Doc(); editSharedNotebook(doc, { metadata: {}, cells: [{ id: 'stable', cell_type: 'code', source: 'public', metadata: {} }] });
      await assert.rejects(sync.flush(notebook), /changed/); await sync.flush(notebook); assert.equal(cell.document.text, 'public'); assert.deepEqual(cell.outputs, []);
    } finally { boundary.window.showWarningMessage = warning; }
  });
  it('keeps already displayed saved output while a source acknowledgement precedes its refreshed file snapshot', async () => {
    sync.dispose(); rawOutputs = [{ output_type: 'stream', name: 'stdout', text: 'saved 7\n' }];
    const renderer = { isManagingCellState: () => false, renderRemoteCellState: async (target: any, request: any) => { target.outputs = [...request.outputs]; } };
    sync = new Sync({ globalStorageUri: { fsPath: root } } as vscode.ExtensionContext, () => connection, { appendLine() {} }, undefined, undefined, renderer);
    await sync.flush(notebook); assert.equal(cell.outputs.length, 1);
    const delayed = pause(); change(4, 0, '!'); await delayed.reached;
    const state = (sync as any).states.get(notebook);
    push!({ kind: 'notebook', path: 'book.ipynb', epoch, revision: 2, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'), acknowledgement: { actor: state.actor, sequence: state.activeIntent.sequence } });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30)); await state.editor.prepareWorkingCopy(false);
      assert.equal(cell.document.text, 'base!'); assert.equal(cell.outputs.length, 1, 'A source ACK must not erase existing outputs while their snapshot is stale');
    } finally { delayed.release(); }
    await sync.flush(notebook); assert.equal(cell.outputs.length, 1);
  });
});
