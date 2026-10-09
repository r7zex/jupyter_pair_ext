import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type * as vscode from 'vscode';
import { copyProject, parseIpynb } from '../src/core/projectFiles';
import { captureInitialWorkingCopy } from '../src/vscode/initialWorkingCopy';

const uri = (file: string, scheme = 'file'): vscode.Uri => ({ fsPath: file, scheme } as vscode.Uri);
const textDocument = (file: string, text: string, changes: Record<string, unknown> = {}): vscode.TextDocument => ({
  uri: uri(file), isDirty: true, isClosed: false, languageId: 'python', getText: () => text, ...changes,
} as unknown as vscode.TextDocument);

describe('initial host repository working copy', () => {
  it('copies unsaved host imports and new files while retaining the original disk files', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'pair-initial-editor-'));
    const root = path.join(parent, 'source');
    const destination = path.join(parent, 'copy');
    try {
      await mkdir(root);
      const source = path.join(root, 'model.py');
      await writeFile(source, 'weight = 1\n');
      const captured = captureInitialWorkingCopy(root, [
        textDocument(source, 'weight = 9\n'),
        textDocument(path.join(root, 'new_data.csv'), 'input,target\n1,2\n'),
        textDocument(path.join(root, '.env'), 'TOKEN=private'),
        textDocument(path.join(root, '..', 'outside.py'), 'outside'),
        textDocument(path.join(root, 'closed.py'), 'closed', { isClosed: true }),
        textDocument(path.join(root, 'clean.py'), 'clean', { isDirty: false }),
        textDocument(path.join(root, 'cell.py'), 'cell', { uri: uri(path.join(root, 'cell.py'), 'vscode-notebook-cell') }),
      ], []);
      assert.deepEqual(captured.map((file) => file.relativePath), ['model.py', 'new_data.csv']);
      await copyProject(root, destination, captured);
      assert.equal(await readFile(path.join(destination, 'model.py'), 'utf8'), 'weight = 9\n');
      assert.equal(await readFile(path.join(destination, 'new_data.csv'), 'utf8'), 'input,target\n1,2\n');
      assert.equal(await readFile(source, 'utf8'), 'weight = 1\n');
    } finally { await rm(parent, { recursive: true, force: true }); }
  });

  it('takes notebook cells, outputs and metadata from the editor instead of stale raw ipynb text', () => {
    const root = path.join(os.tmpdir(), 'pair-unsaved-notebook');
    const filename = path.join(root, 'train.ipynb');
    const cell = {
      kind: 2, metadata: { pairNotebookCellId: 'training-cell', tags: ['train'] },
      document: textDocument(filename, 'loss = train(weight)\n'),
      outputs: [{ metadata: { outputType: 'stream', name: 'stdout' }, items: [{
        mime: 'application/vnd.code.notebook.stdout', data: Buffer.from('loss=0.25\n'),
      }] }],
      executionSummary: { executionOrder: 7, success: true },
    } as unknown as vscode.NotebookCell;
    const notebook = {
      uri: uri(filename), isDirty: true, isClosed: false, cellCount: 1,
      metadata: { custom: { cells: [], metadata: { training: { epochs: 3 } }, nbformat: 4, nbformat_minor: 5 } },
      getCells: () => [cell],
    } as unknown as vscode.NotebookDocument;
    const captured = captureInitialWorkingCopy(root, [textDocument(filename, '{"cells":[]}')], [notebook]);
    assert.equal(captured.length, 1);
    const snapshot = parseIpynb(Buffer.from(captured[0]!.bytes).toString('utf8'));
    assert.equal(snapshot.cells[0]!.id, 'training-cell');
    assert.equal(snapshot.cells[0]!.source, 'loss = train(weight)\n');
    assert.deepEqual(snapshot.cells[0]!.metadata.tags, ['train']);
    assert.equal(snapshot.cells[0]!.execution?.executionOrder, 7);
    assert.equal(Buffer.from(snapshot.cells[0]!.outputs[0]!.items[0]!.dataBase64, 'base64').toString(), 'loss=0.25\n');
    assert.deepEqual(snapshot.metadata.training, { epochs: 3 });
  });
});
