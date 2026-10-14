import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import type * as vscode from 'vscode';
import { editSharedNotebook, sharedNotebook, type NotebookSyncReply } from '../src/vps/persistentNotebookCrdt';
import { rebaseTextChanges } from '../src/core/textChanges';
import { createEditorVscodeBoundary } from './editorVscodeBoundary';
import type { PersistentLiveEvent } from '../src/vps/persistentLive';
import { encodeRelativeOffset } from '../src/core/cursorPosition';
import { PersistentHttpError } from '../src/vps/persistentClient';

const { vscodeBoundary: boundary, fakeCell, fakeNotebook } = createEditorVscodeBoundary();
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
  let gate: (() => Promise<void>) | undefined; let lostAck: boolean; let denyNext: boolean; let epoch: string; let push: ((event: PersistentLiveEvent) => void) | undefined;
  const sequences = new Map<string, number>();
  let rawOutputs: unknown[];
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pair-editor-replica-')); cell = fakeCell('base', 'stable'); notebook = fakeNotebook(root, [cell]);
    notebook.uri = { scheme: 'pair-vps', authority: 'session', path: '/book.ipynb', toString: () => 'pair-vps://session/book.ipynb' };
    boundary.__reset(notebook); doc = new Y.Doc(); editSharedNotebook(doc, { metadata: {}, cells: [{ id: 'stable', cell_type: 'code', source: 'base', metadata: {} }] });
    gate = undefined; lostAck = false; denyNext = false; epoch = 'epoch'; rawOutputs = []; sequences.clear();
    const client = { subscribe: (_id: string, receive: (event: PersistentLiveEvent) => void) => { push = receive; return { dispose() { push = undefined; } }; }, call: async (operation: string, input: any): Promise<any> => {
      if (operation === 'presence') return { states: [] };
      if (operation === 'read') return { content: Buffer.from(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: sharedNotebook(doc).cells.map((item) => ({ ...item, outputs: rawOutputs, execution_count: null })) })).toString('base64') };
      if (input.epoch !== undefined && input.epoch !== epoch) throw new PersistentHttpError(409);
      if (input.intent && denyNext) { denyNext = false; const blocked = gate; gate = undefined; if (blocked) await blocked(); throw new PersistentHttpError(423); }
      if (input.update) Y.applyUpdate(doc, Buffer.from(input.update, 'base64'));
      if (input.snapshot) editSharedNotebook(doc, input.snapshot);
      if (input.intent && (sequences.get(input.intent.actor) ?? 0) < input.intent.sequence) {
        const intent = input.intent; const text = doc.getMap<Y.Map<unknown>>('cells').get(intent.cellId)!.get('source') as Y.Text;
        for (const change of rebaseTextChanges(intent.baseline, text.toString(), intent.changes).sort((a, b) => b.offset - a.offset)) { if (change.deleteCount) text.delete(change.offset, change.deleteCount); if (change.insertText) text.insert(change.offset, change.insertText); }
        sequences.set(intent.actor, intent.sequence);
      }
      const reply: NotebookSyncReply = { epoch, revision: 1, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'), ...sharedNotebook(doc) };
      const blocked = gate; gate = undefined; if (blocked) await blocked();
      if (lostAck && input.intent) { lostAck = false; throw new Error('Acknowledgement lost after server commit'); }
      return reply;
    } };
    connection = { endpoint: 'https://example.com', sessionId: 'session', memberId: 'member', client };
    sync = new Sync({ globalStorageUri: { fsPath: root } } as vscode.ExtensionContext, () => connection);
  });
  afterEach(async () => { sync.dispose(); doc.destroy(); await rm(root, { recursive: true, force: true }); });
  const change = (offset: number, length: number, insert: string): void => { const document = cell.document; document.text = document.text.slice(0, offset) + insert + document.text.slice(offset + length); document.isDirty = true; boundary.__fireTextChange(document, [{ rangeOffset: offset, rangeLength: length, text: insert }]); };
  const pause = (): { reached: Promise<void>; release(): void } => { let release!: () => void; let arrived!: () => void; const reached = new Promise<void>((resolve) => { arrived = resolve; }); const waiting = new Promise<void>((resolve) => { release = resolve; }); gate = async () => { arrived(); await waiting; }; return { reached, release }; };
  it('retains genuine input during the handshake and an older response', async () => {
    const initial = pause(); const first = sync.flush(notebook); await initial.reached; change(4, 0, '-local'); initial.release(); await first; await sync.flush(notebook);
    assert.equal(cell.document.text, 'base-local'); assert.equal(sharedNotebook(doc).cells[0]!.source, 'base-local');
    const late = pause(); const pending = sync.flush(notebook); await late.reached; change(cell.document.text.length, 0, '!'); late.release(); await pending; await sync.flush(notebook);
    assert.equal(cell.document.text, 'base-local!'); assert.equal(sharedNotebook(doc).cells[0]!.source, 'base-local!');
  });
  it('uses a push update immediately without waiting for poll or save', async () => {
    await sync.flush(notebook); const shared = sharedNotebook(doc); shared.cells[0]!.source = 'remote base'; editSharedNotebook(doc, shared);
    push!({ kind: 'notebook', path: 'book.ipynb', epoch: 'epoch', revision: 2, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') });
    for (let n = 0; n < 100 && cell.document.text !== 'remote base'; n++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(cell.document.text, 'remote base');
  });
  it('journals accepted input before a lost ACK and replays its identity once', async () => {
    await sync.flush(notebook); lostAck = true; change(4, 0, '-offline'); await assert.rejects(sync.flush(notebook), /Acknowledgement/);
    const files = await readdir(path.join(root, 'persistent-replicas')); const saved = JSON.parse(await readFile(path.join(root, 'persistent-replicas', files.find((name) => name.endsWith('.json'))!), 'utf8'));
    assert.equal(saved.intents.length, 1); assert.equal(saved.intents[0].changes[0].insertText, '-offline');
    await sync.flush(notebook); assert.equal(sharedNotebook(doc).cells[0]!.source, 'base-offline');
    const late = pause(); const pending = sync.flush(notebook); await late.reached; connection = { ...connection, memberId: 'replacement' }; late.release(); await assert.rejects(pending, /connection changed/);
  });
  it('restores occupied-row input locally while allowing another row of the same native cell', async () => {
    const shared = sharedNotebook(doc); shared.cells[0]!.source = 'base\nfree'; editSharedNotebook(doc, shared); cell.document.text = 'base\nfree';
    notebook.metadata = { nbformat: 4, nbformat_minor: 5, cells: [], metadata: { kernelspec: { name: 'python3' } } };
    cell.metadata = { id: 'stable', metadata: { tags: ['retained'] } };
    await sync.flush(notebook);
    const text = doc.getMap<Y.Map<unknown>>('cells').get('stable')!.get('source') as Y.Text;
    push!({ kind: 'presence', states: [{ peer: { peerId: 'other', displayName: 'Other', joinOrder: 0 }, epoch: 'epoch', readOnly: false, activeFile: 'book.ipynb', activeNotebookCellId: 'stable', activeLine: 0, activeLineAnchor: encodeRelativeOffset(text, 0), shareCursor: true, cursorColor: '#4FC3F7', kernelStatus: 'Idle' }] });
    change(0, 0, 'denied ');
    for (let n = 0; n < 100 && cell.document.text !== 'base\nfree'; n++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(cell.document.text, 'base\nfree'); assert.equal(sharedNotebook(doc).cells[0]!.source, 'base\nfree');
    change(5, 0, 'kept '); await sync.flush(notebook); assert.equal(sharedNotebook(doc).cells[0]!.source, 'base\nkept free');
    assert.equal(Array.isArray(notebook.metadata.cells), true); assert.equal(notebook.metadata.cells.length, 0); assert.equal(cell.metadata.id, 'stable');
    assert.equal(JSON.stringify(notebook.metadata).includes('pair_crdt'), false);
  });
  it('preserves later free-row typing after a server line-occupation race without consuming a new actor', async () => {
    const shared = sharedNotebook(doc); shared.cells[0]!.source = 'base\nfree'; editSharedNotebook(doc, shared); cell.document.text = 'base\nfree'; await sync.flush(notebook);
    denyNext = true; const denied = pause(); change(0, 0, 'denied '); const pending = sync.flush(notebook); await denied.reached;
    change(cell.document.text.indexOf('\n') + 1, 0, 'kept '); denied.release(); await pending; await sync.flush(notebook);
    assert.equal(cell.document.text, 'base\nkept free'); assert.equal(sharedNotebook(doc).cells[0]!.source, 'base\nkept free');
    assert.equal(sequences.size, 1); assert.equal([...sequences.values()][0], 1);
    assert.ok((await readdir(path.join(root, 'persistent-replicas'))).some((file) => file.includes('occupied-line')));
  });
  it('archives and blocks old-epoch input until an explicit reload after a privacy change', async () => {
    await sync.flush(notebook); epoch = 'public-epoch'; doc.destroy(); doc = new Y.Doc(); editSharedNotebook(doc, { metadata: {}, cells: [{ id: 'stable', cell_type: 'code', source: 'public', metadata: {} }] });
    await assert.rejects(sync.flush(notebook), /changed/); await assert.rejects(sync.flush(notebook), /preserved/);
    assert.equal(sharedNotebook(doc).cells[0]!.source, 'public'); assert.equal(cell.document.text, 'base');
    const files = await readdir(path.join(root, 'persistent-replicas')); const archive = files.find((file) => file.includes('conflict')); assert.ok(archive);
    const recovered = JSON.parse(await readFile(path.join(root, 'persistent-replicas', archive), 'utf8')); assert.equal(recovered.displayed[0].source, 'base');
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
});
