import { SESSION_NOTEBOOK_TYPE, SessionNotebookSerializer } from '../../src/vscode/sessionNotebook';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { PairNotebookController } from '../../src/vscode/jupyterController';
import type { SessionRuntime } from '../../src/runtime/session';
import { EditorSynchronizer } from '../../src/vscode/sync';
import { captureInitialWorkingCopy } from '../../src/vscode/initialWorkingCopy';
import { claimGuestWorkspace, preserveGuestBuffers, retireGuestWorkspace } from '../../src/vscode/temporarySessions';

suite('Pair Notebook — production NotebookController in real VS Code', () => {
  suiteSetup(async () => { await vscode.extensions.getExtension('pair-notebook.pair-notebook')!.activate(); });
  test('unregisters the native Pair kernel on leave and rejects stale ownership callbacks', async () => {
    const fixture = await openNotebookFixture('print(1)');
    const log = vscode.window.createOutputChannel('Pair kernel lifecycle acceptance');
    const controller = new PairNotebookController(log);
    let connected = true;
    controller.persistent = { get connected() { return connected; }, owns: () => true, execute: async () => undefined, interrupt: async () => undefined };
    try {
      const native = controller.controller;
      connected = false;
      controller.refreshSession();
      assert.throws(() => controller.controller, /Join a Pair Notebook session/);
      await assert.rejects((controller as any).selectController(vscode.window.activeNotebookEditor), /session ended/);
      assert.equal((controller as any).registeredController, undefined);
      assert.equal(await vscode.commands.executeCommand('notebook.selectKernel', { id: native.id, extension: 'pair-notebook.pair-notebook', notebookEditor: vscode.window.activeNotebookEditor }), false);
      connected = true;
      assert.notEqual(controller.controller, native);
    } finally { connected = false; controller.dispose(); log.dispose(); await fixture.dispose(); }
  });
  test('preserves a real dirty notebook in recovery before removing its temporary workspace', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'pair-native-recovery-'));
    const base = path.join(fixture, 'pair-notebook.pair-notebook');
    const workingFolder = path.join(base, 'sessions', 'native', 'peer', 'workspace');
    const descriptor: any = { sessionId: 'native', localPeer: { peerId: 'peer' }, workingFolder };
    const context: any = { extensionPath: vscode.extensions.getExtension('pair-notebook.pair-notebook')!.extensionPath, globalStorageUri: vscode.Uri.file(base) };
    await mkdir(workingFolder, { recursive: true });
    const uri = vscode.Uri.file(path.join(workingFolder, 'test.ipynb'));
    await writeFile(uri.fsPath, JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: 'code', id: 'native', source: ['print(1)'], metadata: {}, outputs: [], execution_count: null }] }));
    await claimGuestWorkspace(context, descriptor);
    await vscode.commands.executeCommand('vscode.openWith', uri, SESSION_NOTEBOOK_TYPE);
    const notebook = vscode.window.activeNotebookEditor!.notebook;
    try {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(notebook.cellAt(0).document.uri, new vscode.Position(0, 0), '# unsaved native recovery\n');
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      assert.equal(notebook.isDirty, true);
      await preserveGuestBuffers(context, descriptor, captureInitialWorkingCopy(workingFolder, vscode.workspace.textDocuments, vscode.workspace.notebookDocuments));
      assert.equal(notebook.isClosed, false);
      assert.equal(notebook.isDirty, true);
      assert.equal((await readFile(uri.fsPath, 'utf8')).includes('unsaved native recovery'), false);
      // This fixture explicitly saves and closes its own editor after recovery;
      // the production cleanup never forces a dirty editor to discard changes.
      await notebook.save();
      assert.equal(await vscode.window.tabGroups.close(vscode.window.tabGroups.activeTabGroup.activeTab!, true), true);
      await retireGuestWorkspace(context, descriptor);
      await waitFor(() => notebook.isClosed, 3000, 'closed recovery fixture');
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { await access(workingFolder); } catch { break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await assert.rejects(access(workingFolder));
      const directory = path.join(base, 'recovery', 'temporary-sessions');
      let archive: string | undefined;
      const archiveDeadline = Date.now() + 5000;
      while (Date.now() < archiveDeadline) {
        const files = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        const name = files.find(name => name.endsWith('.jsonl.gz'));
        if (name) { archive = path.join(directory, name); break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(archive, 'the recovery archive must be published before reading it');
      const entries = gunzipSync(await readFile(archive)).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
      const saved = entries.find(entry => entry.path === 'buffers/test.ipynb');
      assert.match(Buffer.from(saved.content, 'base64').toString(), /unsaved native recovery/);
    } finally { if (!notebook.isClosed) { await notebook.save(); await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); } await rm(fixture, { recursive: true, force: true }); }
  });
  for (const dirty of [false, true]) test(`switches one restored Jupyter model safely with dirty=${dirty}`, async function () {
    this.timeout(20_000);
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-editor-switch-'));
    const uri = vscode.Uri.file(path.join(root, 'test.ipynb'));
    const localUri = vscode.Uri.file(path.join(root, 'local', 'test.ipynb'));
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(localUri.fsPath)));
    const bytes = Buffer.from(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
      { cell_type: 'code', id: 'restored', source: ['print(1)'], metadata: {}, outputs: [], execution_count: null },
    ] }));
    await vscode.workspace.fs.writeFile(uri, bytes); await vscode.workspace.fs.writeFile(localUri, bytes);
    const local = await vscode.workspace.openNotebookDocument(localUri);
    const original = await vscode.workspace.openNotebookDocument(uri);
    const editor = await vscode.window.showNotebookDocument(original, { preview: false });
    assert.equal(original.notebookType, 'jupyter-notebook');
    const log = vscode.window.createOutputChannel('Pair editor switch acceptance');
    const controller = new PairNotebookController(log);
    controller.persistent = { connected: true, owns: notebook => notebook.uri.toString() === uri.toString(), execute: async () => undefined, interrupt: async () => undefined };
    const select = controller as unknown as { selectController(editor: vscode.NotebookEditor): Promise<vscode.NotebookEditor> };
    try {
      if (dirty) {
        const edit = new vscode.WorkspaceEdit(); edit.insert(original.cellAt(0).document.uri, new vscode.Position(0, 8), '\n# unsaved recovery');
        assert.equal(await vscode.workspace.applyEdit(edit), true); assert.equal(original.isDirty, true);
        await assert.rejects(select.selectController(editor), /unsaved/);
        assert.equal(original.isClosed, false); assert.equal(original.isDirty, true);
        assert.deepEqual(await vscode.workspace.fs.readFile(uri), bytes, 'switching must not save over the backing file');
        await original.save();
        assert.equal(original.isDirty, false);
        await select.selectController(editor);
        await waitFor(() => vscode.workspace.notebookDocuments.some(document => document.uri.toString() === uri.toString() && document.notebookType === SESSION_NOTEBOOK_TYPE), 6000, 'saved legacy notebook switch');
      } else {
        const reopened = await Promise.all([select.selectController(editor), select.selectController(editor), select.selectController(editor)]);
        assert.equal(reopened[0]!.notebook, reopened[1]!.notebook);
      }
      const documents = vscode.workspace.notebookDocuments.filter(document => document.uri.toString() === uri.toString());
      assert.equal(documents.length, 1); assert.equal(documents[0]!.notebookType, SESSION_NOTEBOOK_TYPE);
      assert.equal(local.notebookType, 'jupyter-notebook');
      if (dirty) assert.match(documents[0]!.cellAt(0).document.getText(), /unsaved recovery/);
      await documents[0]!.save(); await documents[0]!.save();
    } finally {
      controller.dispose(); log.dispose();
      for (const document of vscode.workspace.notebookDocuments.filter(document => document.uri.fsPath.startsWith(root))) {
        if (document.isClosed) continue;
        await Promise.resolve(document.save()).catch(error => { if (!document.isClosed) throw error; });
        if (!document.isClosed) { await vscode.window.showNotebookDocument(document); await vscode.commands.executeCommand('workbench.action.closeActiveEditor'); }
      }
    }
  });
  test('round-trips attachment, metadata, outputs and stable cell IDs in the session serializer', () => {
    const serializer = new SessionNotebookSerializer();
    assert.deepEqual(serializer.deserializeNotebook(new Uint8Array()).cells, [], 'Save As must accept its empty destination model');
    const original = { nbformat: 4, nbformat_minor: 5, metadata: { customStudy: { name: 'Study' }, kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } }, cells: [
      { cell_type: 'markdown', id: 'markdown', source: ['![image](attachment:tiny.png)'], metadata: { tags: ['note'] }, attachments: { 'tiny.png': { 'image/png': 'YWJj' } } },
      { cell_type: 'code', id: 'code', source: ['print(42)'], metadata: { tags: ['run'] }, execution_count: 3, outputs: [{ output_type: 'stream', name: 'stdout', text: ['42\n'] }] },
    ] };
    const saved = JSON.parse(Buffer.from(serializer.serializeNotebook(serializer.deserializeNotebook(Buffer.from(JSON.stringify(original))))).toString());
    assert.deepEqual(saved.metadata, original.metadata);
    assert.deepEqual(saved.cells[0].attachments, original.cells[0]!.attachments);
    assert.deepEqual(saved.cells.map((cell: any) => cell.id), ['markdown', 'code']);
    assert.equal(saved.cells[1].execution_count, 3);
    assert.deepEqual(saved.cells[1].outputs, original.cells[1]!.outputs);
  });

  test('routes the active cell through the single controller into a persistent backend', async function () {
    this.timeout(10_000);
    const fixture = await openNotebookFixture('a = 1\na');
    const log = vscode.window.createOutputChannel(`Pair Notebook Unified Controller E2E ${Date.now()}`);
    const controller = new PairNotebookController(log);
    let calls = 0;
    controller.persistent = {
      connected: true,
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
    // Match the deployed CommonJS bundle on VS Code's minimum Node runtime.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SessionRuntime: Runtime } = require(process.env.PAIR_NOTEBOOK_E2E_RUNTIME!) as { SessionRuntime: typeof import('../../src/runtime/session').SessionRuntime };
    const runtime: SessionRuntime = new Runtime({
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
      const physicalPath = path.join(fixture.root, 'controller.ipynb');
      const beforeFallback = await readFile(physicalPath);
      const writeFallback = runtime as unknown as { writeWorkingCopy: (key: string, bytes: Uint8Array) => Promise<boolean> };
      assert.equal(await writeFallback.writeWorkingCopy('controller.ipynb', Buffer.from('stale raw notebook projection')), true);
      assert.deepEqual(await readFile(physicalPath), beforeFallback, 'an open notebook must not be written behind the VS Code working copy');
      assert.equal(await fixture.notebook.save(), true);
      assert.equal(await fixture.notebook.save(), true);
      const saved = JSON.parse(await readFile(physicalPath, 'utf8'));
      assert.equal(saved.cells[0].source.join(''), 'print(a + 2)');
      assert.equal(saved.cells[0].id, 'controller-fixture');
      assert.match(JSON.stringify(saved.cells[0].outputs), /43/);
    } finally { controller.dispose(); synchronizer.dispose(); await runtime.leave(); log.dispose(); await fixture.dispose(); await rm(backing, { recursive: true, force: true }); }
  });

  test('renders remote outputs and terminal execution state through NotebookCellExecution', async function () {
    this.timeout(10_000);
    const fixture = await openNotebookFixture('print("remote")');
    const log = vscode.window.createOutputChannel(`Pair Notebook Controller E2E ${Date.now()}`);
    const controller = new PairNotebookController(log);
    controller.persistent = { connected: true, owns: notebook => notebook === fixture.notebook, execute: async () => undefined, interrupt: async () => undefined };
    const native = controller.controller;
    assert.ok(native);
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
    controller.persistent = { connected: true, owns: notebook => notebook === fixture.notebook, execute: async () => undefined, interrupt: async () => undefined };
    const native = controller.controller;
    assert.ok(native);
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
  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(absolutePath), SESSION_NOTEBOOK_TYPE);
  const notebook = vscode.workspace.notebookDocuments.find(document => document.uri.toString() === vscode.Uri.file(absolutePath).toString() && document.notebookType === SESSION_NOTEBOOK_TYPE)!;
  assert.ok(notebook, 'the session serializer must open this notebook');
  await vscode.window.showNotebookDocument(notebook, { preview: false });
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
