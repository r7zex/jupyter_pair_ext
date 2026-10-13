import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import type * as vscode from 'vscode';
import { editSharedNotebook, sharedNotebook, type NotebookSyncReply } from '../src/vps/persistentNotebookCrdt';
import type { PersistentClient } from '../src/vps/persistentClient';
let text = 'base';
let onChange: ((event: any) => void) | undefined;
const cell: any = { kind: 2, metadata: {}, document: { uri: 'cell', getText: () => text, positionAt: (position: number) => position } };
const notebook: any = { uri: { scheme: 'pair-vps', authority: 'session', path: '/book.ipynb' }, metadata: {}, getCells: () => [cell], cellCount: 1 };
const boundary = {
  NotebookCellKind: { Code: 2, Markup: 1 }, Range: class {},
  WorkspaceEdit: class { public texts: string[] = []; public notebookEdits: any[] = []; public get size(): number { return this.texts.length + this.notebookEdits.length; } public replace(_uri: unknown, _range: unknown, source: string): void { this.texts.push(source); } public set(_uri: unknown, edits: any[]): void { this.notebookEdits.push(...edits); } },
  NotebookEdit: { updateCellMetadata: (_index: number, metadata: any) => ({ metadata }) },
  workspace: {
    onDidChangeNotebookDocument: (listener: (event: any) => void) => { onChange = listener; return { dispose: () => { onChange = undefined; } }; },
    onDidCloseNotebookDocument: () => ({ dispose: () => undefined }),
    applyEdit: async (edit: { texts: string[]; notebookEdits: any[] }) => { for (const value of edit.texts) text = value; for (const value of edit.notebookEdits) cell.metadata = value.metadata; return true; },
  },
  window: { showWarningMessage: async () => undefined, showInformationMessage: async () => undefined },
};
const loader = Module as typeof Module & { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load; const before = new Set(Object.keys(require.cache));
loader._load = function (request, parent, isMain): unknown { return request === 'vscode' ? boundary : originalLoad.call(this, request, parent, isMain); };
let Sync: typeof import('../src/vscode/persistentNotebookSync').PersistentNotebookSynchronizer;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Sync = require('../src/vscode/persistentNotebookSync').PersistentNotebookSynchronizer;
} finally { loader._load = originalLoad; for (const id of Object.keys(require.cache)) if (!before.has(id) && id.includes(`${path.sep}src${path.sep}`)) delete require.cache[id]; }

describe('Persistent notebook replica race and durable recovery boundaries', () => {
  let root: string; let doc: Y.Doc; let sync: InstanceType<typeof Sync>; let connection: any;
  let gate: (() => Promise<void>) | undefined; let lostAck = false;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pair-editor-replica-')); text = 'base'; cell.metadata = {}; doc = new Y.Doc();
    editSharedNotebook(doc, { metadata: {}, cells: [{ id: 'stable', cell_type: 'code', source: 'base', metadata: {} }] }); gate = undefined; lostAck = false;
    const client = { call: async (_operation: string, input: any): Promise<NotebookSyncReply> => {
      if (input.update) Y.applyUpdate(doc, Buffer.from(input.update, 'base64'));
      const reply = { epoch: 'epoch', revision: 1, update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'), ...sharedNotebook(doc) };
      const blocked = gate; gate = undefined; if (blocked) await blocked();
      if (lostAck && input.update) { lostAck = false; throw new Error('Acknowledgement lost after server commit'); }
      return reply;
    } } as unknown as PersistentClient;
    connection = { endpoint: 'https://example.com', sessionId: 'session', memberId: 'member', client };
    sync = new Sync({ globalStorageUri: { fsPath: root } } as vscode.ExtensionContext, () => connection);
  });
  afterEach(async () => { sync.dispose(); doc.destroy(); await rm(root, { recursive: true, force: true }); });
  const changed = (): void => onChange?.({ notebook, contentChanges: [], cellChanges: [{ document: cell.document }] });
  const pause = async (): Promise<{ reached: Promise<void>; release: () => void }> => {
    let release!: () => void; let arrived!: () => void; const reached = new Promise<void>((resolve) => { arrived = resolve; }); const waiting = new Promise<void>((resolve) => { release = resolve; });
    gate = async () => { arrived(); await waiting; }; return { reached, release };
  };
  it('preserves edits made during initial handshake and an older response instead of replacing the displayed source', async () => {
    const initial = await pause(); const first = sync.flush(notebook); await initial.reached;
    text = 'base-local'; changed(); initial.release(); await first; await sync.flush(notebook);
    assert.equal(text, 'base-local'); assert.equal(sharedNotebook(doc).cells[0]!.source, 'base-local');
    const late = await pause(); const pending = sync.flush(notebook); await late.reached;
    text = 'base-newer'; changed(); late.release(); await pending; await sync.flush(notebook);
    assert.equal(text, 'base-newer'); assert.equal(sharedNotebook(doc).cells[0]!.source, 'base-newer');
  });
  it('keeps queued initial edits blocked after a conflicting first snapshot until the user chooses reload', async () => {
    const remote = sharedNotebook(doc); remote.cells[0]!.source = 'base-remote'; editSharedNotebook(doc, remote);
    const initial = await pause(); const first = sync.flush(notebook); await initial.reached;
    text = 'base-local'; changed(); initial.release(); await assert.rejects(first, /changed|Reload/);
    await assert.rejects(sync.flush(notebook, true), /explicit reload/);
    assert.equal(sharedNotebook(doc).cells[0]!.source, 'base-remote'); assert.equal(text, 'base-local');
    const files = await readdir(path.join(root, 'persistent-replicas')); assert.ok(files.some((name) => name.includes('initial-conflict')));
  });

  it('retains local update bytes before a lost ACK and fences a late reply after connection replacement', async () => {
    await sync.flush(notebook); text = 'base-offline'; lostAck = true;
    await assert.rejects(sync.flush(notebook, true), /Acknowledgement/);
    const files = await readdir(path.join(root, 'persistent-replicas')); const saved = JSON.parse(await readFile(path.join(root, 'persistent-replicas', files[0]!), 'utf8'));
    const recovered = new Y.Doc(); Y.applyUpdate(recovered, Buffer.from(saved.update, 'base64')); assert.equal(sharedNotebook(recovered).cells[0]!.source, 'base-offline'); recovered.destroy();
    await sync.flush(notebook); assert.equal(sharedNotebook(doc).cells[0]!.source, 'base-offline');
    const late = await pause(); const pending = sync.flush(notebook); await late.reached; connection = { ...connection, memberId: 'replacement' }; late.release();
    await assert.rejects(pending, /connection changed/); assert.equal(text, 'base-offline');
  });
});
