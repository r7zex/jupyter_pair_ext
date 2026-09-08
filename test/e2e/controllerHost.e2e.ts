import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { PairNotebookController } from '../../src/vscode/jupyterController';

suite('Pair Notebook — production NotebookController in real VS Code', () => {
  test('renders remote outputs and terminal execution state through NotebookCellExecution', async function () {
    this.timeout(10_000);
    const fixture = await openNotebookFixture('print("remote")');
    const log = vscode.window.createOutputChannel(`Pair Notebook Controller E2E ${Date.now()}`);
    const controller = new PairNotebookController(log);
    try {
      const editor = vscode.window.activeNotebookEditor;
      assert.ok(editor);
      assert.equal(editor.notebook, fixture.notebook);
      const selected = await vscode.commands.executeCommand<boolean>('notebook.selectKernel', {
        id: 'pair-notebook-jupyter',
        extension: 'pair-notebook.pair-notebook',
        notebookEditor: editor,
      });
      assert.equal(selected, true, 'VS Code must accept the production Pair Notebook controller');

      const cell = fixture.notebook.cellAt(0);
      const startTime = Date.now() - 10;
      const endTime = Date.now();
      await controller.renderRemoteCellState(cell, {
        outputs: [new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.text('remote output\n', 'text/plain'),
        ], { outputType: 'stream' })],
        execution: {
          executionOrder: 17,
          success: true,
          timing: { startTime, endTime },
        },
        outputsChanged: true,
        executionChanged: true,
        executionMode: 'snapshot',
      });

      await waitFor(
        () => cell.outputs.length === 1
          && cell.executionSummary?.executionOrder === 17
          && cell.executionSummary?.success === true,
        5_000,
        'remote output and terminal execution summary to render',
      );
      assert.equal(cell.outputs.length, 1);
      assert.equal(cell.outputs[0]?.items.length, 1);
      assert.equal(cell.outputs[0]?.items[0]?.mime, 'text/plain');
      assert.equal(Buffer.from(cell.outputs[0]?.items[0]?.data ?? []).toString('utf8'), 'remote output\n');
      assert.equal(cell.executionSummary?.executionOrder, 17);
      assert.equal(cell.executionSummary?.success, true);
    } finally {
      controller.dispose();
      log.dispose();
      await fixture.dispose();
    }
  });

  test('updates an existing mirrored execution without duplicating output state', async function () {
    this.timeout(10_000);
    const fixture = await openNotebookFixture('print("stream")');
    const log = vscode.window.createOutputChannel(`Pair Notebook Controller Stream E2E ${Date.now()}`);
    const controller = new PairNotebookController(log);
    try {
      const editor = vscode.window.activeNotebookEditor;
      assert.ok(editor);
      const selected = await vscode.commands.executeCommand<boolean>('notebook.selectKernel', {
        id: 'pair-notebook-jupyter',
        extension: 'pair-notebook.pair-notebook',
        notebookEditor: editor,
      });
      assert.equal(selected, true);

      const cell = fixture.notebook.cellAt(0);
      const started = Date.now();
      await controller.renderRemoteCellState(cell, {
        outputs: [new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text('first', 'text/plain')])],
        execution: { executionOrder: 3, timing: { startTime: started, endTime: started } },
        outputsChanged: true,
        executionChanged: true,
        executionMode: 'live',
      });
      await controller.renderRemoteCellState(cell, {
        outputs: [new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text('final', 'text/plain')])],
        execution: { executionOrder: 3, success: true, timing: { startTime: started, endTime: Date.now() } },
        outputsChanged: true,
        executionChanged: true,
        executionMode: 'live',
      });

      await waitFor(
        () => cell.executionSummary?.success === true && cell.outputs.length === 1,
        3_000,
        'live mirrored execution to finish',
      );
      assert.equal(Buffer.from(cell.outputs[0]?.items[0]?.data ?? []).toString('utf8'), 'final');
      assert.equal(cell.executionSummary?.executionOrder, 3);
      assert.equal(cell.executionSummary?.success, true);
      assert.equal(controller.isManagingCellState(cell), false, 'terminal mirrored state must retire its execution handle');
    } finally {
      controller.dispose();
      log.dispose();
      await fixture.dispose();
    }
  });
});

interface NotebookFixture {
  readonly root: string;
  readonly notebook: vscode.NotebookDocument;
  dispose(): Promise<void>;
}

async function openNotebookFixture(source: string): Promise<NotebookFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pair-notebook-controller-e2e-'));
  const absolutePath = path.join(root, 'controller.ipynb');
  await writeFile(absolutePath, JSON.stringify({
    cells: [{
      cell_type: 'code',
      execution_count: null,
      id: 'controller-fixture',
      metadata: {},
      outputs: [],
      source: [source],
    }],
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }), 'utf8');
  const notebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(absolutePath));
  await vscode.window.showNotebookDocument(notebook, { preview: false, preserveFocus: false });
  return {
    root,
    notebook,
    dispose: async () => {
      if (!notebook.isClosed) {
        await vscode.window.showNotebookDocument(notebook, { preview: false, preserveFocus: false });
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      }
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
