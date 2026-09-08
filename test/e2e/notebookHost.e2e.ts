import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { CollaborativeProject } from '../../src/core/crdt';
import { REMOTE_ORIGIN } from '../../src/core/types';
import { EditorSynchronizer } from '../../src/vscode/sync';

suite('Pair Notebook — real VS Code NotebookDocument boundary', () => {
  test('binds a real .ipynb and persists one stable collaboration cell identity', async function () {
    this.timeout(10_000);
    const harness = await createNotebookHarness('value = 1');
    try {
      const snapshot = harness.project.notebookSnapshot(harness.key);
      assert.equal(snapshot.cells.length, 1);
      assert.equal(snapshot.cells[0]?.source, 'value = 1');
      const stableId = snapshot.cells[0]?.id;
      assert.ok(stableId);
      await waitFor(
        () => harness.notebook.cellAt(0).metadata.pairNotebookCellId === stableId,
        5_000,
        'stable cell id to be persisted through real NotebookEdit metadata',
      );
      assert.equal(harness.notebook.cellAt(0).metadata.pairNotebookCellId, stableId);
    } finally {
      await harness.dispose();
    }
  });

  test('publishes a real notebook-cell TextDocument edit into canonical Yjs source', async () => {
    const harness = await createNotebookHarness('value = 1');
    try {
      const cell = harness.notebook.cellAt(0);
      const stableId = harness.project.notebookSnapshot(harness.key).cells[0]?.id;
      assert.ok(stableId);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(cell.document.uri, cell.document.positionAt(cell.document.getText().length), '\nvalue += 1');
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      await waitFor(
        () => harness.project.cellSource(harness.key, stableId).toString() === 'value = 1\nvalue += 1',
        3_000,
        'real notebook-cell edit to reach canonical source',
      );
      assert.equal(cell.document.getText(), 'value = 1\nvalue += 1');
    } finally {
      await harness.dispose();
    }
  });

  test('projects remote cell text through the real cell TextDocument without replacing the cell', async () => {
    const harness = await createNotebookHarness('value = 1');
    try {
      const cell = harness.notebook.cellAt(0);
      const stableId = harness.project.notebookSnapshot(harness.key).cells[0]?.id;
      assert.ok(stableId);
      harness.project.applyCellTextChanges(
        harness.key,
        stableId,
        [{ offset: 0, deleteCount: cell.document.getText().length, insertText: 'value = 99' }],
        REMOTE_ORIGIN,
      );
      await waitFor(() => cell.document.getText() === 'value = 99', 3_000, 'remote cell source projection');
      assert.equal(harness.notebook.cellCount, 1);
      assert.equal(harness.notebook.cellAt(0), cell, 'text-only projection must preserve NotebookCell identity');
      assert.equal(harness.project.cellSource(harness.key, stableId).toString(), 'value = 99');
    } finally {
      await harness.dispose();
    }
  });

  test('publishes a real local NotebookEdit insertion with a new stable cell identity', async function () {
    this.timeout(10_000);
    const harness = await createNotebookHarness('first = 1');
    try {
      const firstId = harness.project.notebookSnapshot(harness.key).cells[0]?.id;
      assert.ok(firstId);
      const edit = new vscode.WorkspaceEdit();
      edit.set(harness.notebook.uri, [vscode.NotebookEdit.insertCells(1, [
        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'second = 2', 'python'),
      ])]);
      assert.equal(await vscode.workspace.applyEdit(edit), true);

      await waitFor(
        () => harness.project.notebookSnapshot(harness.key).cells.length === 2,
        5_000,
        'local notebook insertion to reach canonical structure',
      );
      const snapshot = harness.project.notebookSnapshot(harness.key);
      assert.equal(snapshot.cells[0]?.id, firstId);
      assert.equal(snapshot.cells[1]?.source, 'second = 2');
      assert.ok(snapshot.cells[1]?.id);
      assert.notEqual(snapshot.cells[1]?.id, firstId);
      await waitFor(
        () => harness.notebook.cellAt(1).metadata.pairNotebookCellId === snapshot.cells[1]?.id,
        5_000,
        'inserted cell stable id metadata',
      );
    } finally {
      await harness.dispose();
    }
  });

  test('applies a remote structural deletion through real NotebookEdit and preserves surviving cell identity', async function () {
    this.timeout(10_000);
    const harness = await createNotebookHarness('first = 1', 'second = 2');
    try {
      const originalFirst = harness.notebook.cellAt(0);
      const snapshot = harness.project.notebookSnapshot(harness.key);
      assert.equal(snapshot.cells.length, 2);
      const first = snapshot.cells[0];
      assert.ok(first);

      harness.project.reconcileNotebook(
        harness.key,
        { metadata: snapshot.metadata, cells: [first] },
        REMOTE_ORIGIN,
      );
      await waitFor(() => harness.notebook.cellCount === 1, 7_000, 'remote structural deletion');
      assert.equal(harness.notebook.cellAt(0).document.getText(), 'first = 1');
      assert.equal(harness.notebook.cellAt(0), originalFirst, 'minimal structural splice should preserve surviving cell object');
      assert.equal(harness.project.notebookSnapshot(harness.key).cells[0]?.id, first.id);
    } finally {
      await harness.dispose();
    }
  });

  test('applies remote cell metadata without replacing source or notebook structure', async () => {
    const harness = await createNotebookHarness('value = 1');
    try {
      const cell = harness.notebook.cellAt(0);
      const stableId = harness.project.notebookSnapshot(harness.key).cells[0]?.id;
      assert.ok(stableId);
      harness.project.setCellMetadata(harness.key, stableId, { role: 'remote' }, REMOTE_ORIGIN);
      await waitFor(() => harness.notebook.cellAt(0).metadata.role === 'remote', 3_000, 'remote cell metadata projection');
      assert.equal(harness.notebook.cellAt(0), cell);
      assert.equal(cell.document.getText(), 'value = 1');
      assert.equal(cell.metadata.pairNotebookCellId, stableId);
    } finally {
      await harness.dispose();
    }
  });

  test('applies remote notebook metadata through the stable NotebookEdit API', async () => {
    const harness = await createNotebookHarness('value = 1');
    try {
      harness.project.setNotebookMetadata(harness.key, { pairNotebookE2E: 'remote' }, REMOTE_ORIGIN);
      await waitFor(
        () => harness.notebook.metadata.pairNotebookE2E === 'remote',
        3_000,
        'remote notebook metadata projection',
      );
      assert.equal(harness.notebook.cellCount, 1);
      assert.equal(harness.notebook.cellAt(0).document.getText(), 'value = 1');
    } finally {
      await harness.dispose();
    }
  });
});

interface NotebookHarness {
  readonly root: string;
  readonly key: string;
  readonly notebook: vscode.NotebookDocument;
  readonly project: CollaborativeProject;
  readonly synchronizer: EditorSynchronizer;
  readonly log: vscode.OutputChannel;
  dispose(): Promise<void>;
}

async function createNotebookHarness(...sources: string[]): Promise<NotebookHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pair-notebook-notebook-e2e-'));
  const key = 'work.ipynb';
  const absolutePath = path.join(root, key);
  const cells = (sources.length ? sources : ['value = 1']).map((source, index) => ({
    cell_type: 'code',
    execution_count: null,
    id: `fixture-${index + 1}`,
    metadata: {},
    outputs: [],
    source: [source],
  }));
  await writeFile(absolutePath, JSON.stringify({
    cells,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }), 'utf8');

  const notebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(absolutePath));
  await vscode.window.showNotebookDocument(notebook, { preview: false, preserveFocus: false });
  const project = new CollaborativeProject();
  const log = vscode.window.createOutputChannel(`Pair Notebook Notebook E2E ${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const synchronizer = new EditorSynchronizer(project, root, log);
  await synchronizer.whenNotebookReady(notebook);

  return {
    root,
    key,
    notebook,
    project,
    synchronizer,
    log,
    dispose: async () => {
      synchronizer.dispose();
      project.destroy();
      log.dispose();
      if (!notebook.isClosed) {
        try {
          await notebook.save();
        } catch {
          // Cleanup is best-effort; assertions have already completed.
        }
        if (!notebook.isClosed) {
          await vscode.window.showNotebookDocument(notebook, { preview: false, preserveFocus: false });
          await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }
      }
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(20);
  }
  const detail = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${label}.${detail}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
