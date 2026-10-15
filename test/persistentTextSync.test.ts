import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import type * as vscode from 'vscode';
import { PersistentHttpError } from '../src/vps/persistentClient';
import { createEditorVscodeBoundary } from './editorVscodeBoundary';

const { vscodeBoundary: boundary, fakeTextDocument } = createEditorVscodeBoundary();
const loader = Module as typeof Module & { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load; const before = new Set(Object.keys(require.cache)); const cached = new Map<string, NodeModule>();
for (const relative of ['../src/vscode/sync', '../src/vscode/persistentTextSync']) { const key = require.resolve(relative); if (require.cache[key]) cached.set(key, require.cache[key]!); delete require.cache[key]; }
loader._load = function (request, parent, isMain): unknown { return request === 'vscode' ? boundary : originalLoad.call(this, request, parent, isMain); };
let Sync: typeof import('../src/vscode/persistentTextSync').PersistentTextSynchronizer;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Sync = require('../src/vscode/persistentTextSync').PersistentTextSynchronizer;
} finally { loader._load = originalLoad; for (const key of Object.keys(require.cache)) if (!before.has(key) && key.includes(`${path.sep}src${path.sep}`)) delete require.cache[key]; for (const [key, value] of cached) require.cache[key] = value; }

describe('Persistent ordinary-file editor recovery', () => {
  let root: string; let sync: InstanceType<typeof Sync>; let server: Y.Doc; let epoch: string; let document: any;
  let failBootstrap: boolean; let loseAck: boolean; let rejectUpdate: boolean; let updateCalls: number;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pair-text-repair-')); server = new Y.Doc(); server.getText('content').insert(0, 'VALUE=1'); epoch = 'original';
    failBootstrap = false; loseAck = false; rejectUpdate = false; updateCalls = 0;
    document = fakeTextDocument(path.join(root, 'helper.py'), 'VALUE=1');
    document.uri = { scheme: 'pair-vps', authority: 'session', path: '/helper.py', toString: () => 'pair-vps://session/helper.py' };
    boundary.__resetText(document);
    const connection = { endpoint: 'https://example.com', sessionId: 'session', memberId: 'member', client: { call: async (_operation: string, input: any) => {
      if (failBootstrap) { failBootstrap = false; throw new Error('temporary text bootstrap failure'); }
      if (input.epoch !== undefined && input.epoch !== epoch) throw new PersistentHttpError(409);
      if (rejectUpdate && input.update) { rejectUpdate = false; throw new PersistentHttpError(413); }
      if (input.update) { updateCalls++; Y.applyUpdate(server, Buffer.from(input.update, 'base64')); }
      if (loseAck && input.update) { loseAck = false; throw new Error('lost text acknowledgement'); }
      return { epoch, revision: 1, update: Buffer.from(Y.encodeStateAsUpdate(server)).toString('base64') };
    } } };
    sync = new Sync({ globalStorageUri: { fsPath: root } } as vscode.ExtensionContext, () => connection as any, { appendLine() {} });
  });
  afterEach(async () => { await sync.shutdown(); server.destroy(); await rm(root, { recursive: true, force: true }); });
  function change(offset: number, count: number, value: string): void {
    document.text = document.text.slice(0, offset) + value + document.text.slice(offset + count); document.isDirty = true;
    boundary.__fireTextChange(document, [{ rangeOffset: offset, rangeLength: count, text: value }]);
  }
  it('publishes unsaved module changes before execution without calling native Save', async () => {
    await sync.flushAll(); change(6, 1, '2'); await sync.flushAll();
    assert.equal(server.getText('content').toString(), 'VALUE=2'); assert.equal(document.saveCount, 0); assert.equal(updateCalls, 1);
  });
  it('retries a failed initialization and then synchronizes normal typing', async () => {
    failBootstrap = true; await assert.rejects(sync.flushAll(), /bootstrap failure/);
    await sync.flushAll(); change(7, 0, '0'); await sync.flushAll(); assert.equal(server.getText('content').toString(), 'VALUE=10');
  });
  it('retains an accepted update in the journal after lost acknowledgement and retries it once', async () => {
    await sync.flushAll(); loseAck = true; change(7, 0, '0'); await assert.rejects(sync.flushAll(), /lost text acknowledgement/);
    const directory = path.join(root, 'persistent-text'); const filename = (await readdir(directory)).find((name) => name.endsWith('.json'))!;
    const journal = JSON.parse(await readFile(path.join(directory, filename), 'utf8')); assert.ok(journal.pending);
    await sync.flushAll(); assert.equal(server.getText('content').toString(), 'VALUE=10'); assert.equal(document.text, 'VALUE=10');
  });
  it('applies a pushed peer edit immediately without saving or polling', async () => {
    await sync.flushAll(); const vector = Y.encodeStateVector(server); server.getText('content').insert(0, '# peer\n');
    sync.receive({ kind: 'text', path: 'helper.py', epoch, revision: 2, update: Buffer.from(Y.encodeStateAsUpdate(server, vector)).toString('base64') });
    for (let n = 0; n < 100 && !document.text.startsWith('# peer'); n++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(document.text, '# peer\nVALUE=1'); assert.equal(document.saveCount, 0);
  });
  it('recovers from a rejected edit without leaving later small edits behind it forever', async () => {
    await sync.flushAll(); rejectUpdate = true; change(7, 0, '-rejected'); await assert.rejects(sync.flushAll());
    await sync.flushAll();
    for (let n = 0; n < 100 && document.text !== 'VALUE=1'; n++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(document.text, 'VALUE=1'); change(7, 0, '0'); await sync.flushAll(); assert.equal(server.getText('content').toString(), 'VALUE=10');
  });
  it('archives dirty old-scope content before automatically loading a replacement', async () => {
    await sync.flushAll(); change(0, 7, 'PRIVATE_VALUE=secret'); await sync.flushAll();
    server.destroy(); server = new Y.Doc(); server.getText('content').insert(0, 'PUBLIC_VALUE=7'); epoch = 'replacement';
    await sync.flushAll(true);
    for (let n = 0; n < 100 && document.text !== 'PUBLIC_VALUE=7'; n++) await new Promise((resolve) => setTimeout(resolve, 5));
    await sync.flushAll(); assert.equal(document.text, 'PUBLIC_VALUE=7'); assert.equal(server.getText('content').toString(), 'PUBLIC_VALUE=7');
    const directory = path.join(root, 'persistent-text'); const archive = (await readdir(directory)).find((name) => name.includes('.recovered-'))!;
    assert.ok(archive); const restored = new Y.Doc();
    Y.applyUpdate(restored, Buffer.from(JSON.parse(await readFile(path.join(directory, archive), 'utf8')).update, 'base64'));
    assert.equal(restored.getText('content').toString(), 'PRIVATE_VALUE=secret'); restored.destroy();
  });
});
