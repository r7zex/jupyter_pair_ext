import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { PairNotebookController } from '../../src/vscode/jupyterController';
import { SessionRuntime } from '../../src/runtime/session';
import { EditorSynchronizer } from '../../src/vscode/sync';

suite('Pair Notebook — production NotebookController in real VS Code', () => {
  test('routes the active cell through the single controller into a persistent backend', async function () {
    this.timeout(10_000);
    const fixture = await openNotebookFixture('a = 1\na');
    const log = vscode.window.createOutputChannel(`Pair Notebook Unified Controller E2E ${Date.now()}`);
    const controller = new PairNotebookController(log);
    let calls = 0;
    controller.persistent = {
      owns: notebook => notebook === fixture.notebook,
      execute: async cells => {
        calls++;
        assert.equal(cells[0]?.document.getText(), 'a = 1\na');
        const execution = controller.controller.createNotebookCellExecution(cells[0]!);
        execution.start(Date.now());
        await execution.replaceOutput([new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text('1', 'text/plain')])]);
        execution.end(true, Date.now());
      },
      interrupt: async () => undefined,
    };
    try {
      await controller.executeActive();
      assert.equal(calls, 1);
      await waitFor(() => fixture.notebook.cellAt(0).executionSummary?.success === true, 3000, 'persistent execution summary');
      assert.equal(fixture.notebook.cellAt(0).executionSummary?.success, true);
      assert.equal(Buffer.from(fixture.notebook.cellAt(0).outputs[0]!.items[0]!.data).toString(), '1');
    } finally { controller.dispose(); log.dispose(); await fixture.dispose(); }
  });

  test('executes two real Jupyter cells as the only session owner and preserves Python variables', async function () {
    this.timeout(30_000);
    const fixture = await openNotebookFixture('a = 41\nprint(a + 1)');
    const backing = await mkdtemp(path.join(os.tmpdir(), 'pair-notebook-solo-backing-'));
    const log = vscode.window.createOutputChannel(`Pair Notebook Solo Execution E2E ${Date.now()}`);
    const python = process.env.PAIR_NOTEBOOK_E2E_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
    const runtime = new SessionRuntime({
      sessionId: 'solo-execution', projectId: 'solo-project', projectName: 'Solo execution', mode: 'resilient', role: 'host',
      localPeer: { peerId: 'solo-owner', displayName: 'Owner', joinOrder: 0 }, hostPeerId: 'solo-owner',
      backingFolder: backing, workingFolder: fixture.root, createdAt: Date.now(), sessionEpoch: 1, hostEpoch: 0,
      computeExecutorId: 'solo-owner', pythonPath: python, notebookPythonPaths: { 'controller.ipynb': python },
    }, 'solo-test-token-that-is-long-enough', { extensionUri: vscode.Uri.file(path.resolve(__dirname, '../../..')) } as vscode.ExtensionContext, log);
    runtime.project.ensureNotebook('controller.ipynb', { metadata: {}, cells: [{ id: 'controller-fixture', kind: 2, language: 'python', source: 'a = 41\nprint(a + 1)', metadata: {}, outputs: [] }] });
    const controller = new PairNotebookController(log);
    const synchronizer = new EditorSynchronizer(runtime.project, fixture.root, log, undefined, controller);
    controller.setSynchronizer(synchronizer); controller.setRuntime(runtime);
    try {
      await synchronizer.whenNotebookReady(fixture.notebook);
      await controller.executeActive();
      await waitFor(() => fixture.notebook.cellAt(0).executionSummary?.success !== undefined, 3000, 'owner-only execution completion');
      assert.equal(fixture.notebook.cellAt(0).executionSummary?.success, true, fixture.notebook.cellAt(0).outputs.flatMap(output => output.items.map(item => Buffer.from(item.data).toString())).join('\n'));
      await waitFor(() => fixture.notebook.cellAt(0).outputs.some(output => output.items.some(item => Buffer.from(item.data).toString().includes('42'))), 3000, 'real owner-only Jupyter result');
      const cell = fixture.notebook.cellAt(0);
      const edit = new vscode.WorkspaceEdit(); edit.replace(cell.document.uri, new vscode.Range(cell.document.positionAt(0), cell.document.positionAt(cell.document.getText().length)), 'print(a + 2)');
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      await controller.executeActive();
      await waitFor(() => cell.outputs.some(output => output.items.some(item => Buffer.from(item.data).toString().includes('43'))), 3000, 'retained Python variable');
    } finally { controller.dispose(); synchronizer.dispose(); await runtime.leave(); log.dispose(); await fixture.dispose(); await rm(backing, { recursive: true, force: true }); }
  });

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
