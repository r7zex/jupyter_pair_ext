import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';
import { CollaborativeProject, ProjectUpdate } from '../src/core/crdt';
import { REMOTE_ORIGIN } from '../src/core/types';

const vscodeBoundary = createNotebookVscodeBoundary();
const moduleWithLoader = Module as typeof Module & {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = moduleWithLoader._load;
moduleWithLoader._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
  if (request === 'vscode') return vscodeBoundary;
  return originalLoad.call(this, request, parent, isMain);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { EditorSynchronizer } = require('../src/vscode/sync') as { EditorSynchronizer: new (...args: any[]) => any };
moduleWithLoader._load = originalLoad;

describe('EditorSynchronizer VS Code-compatible production path', () => {
  it('keeps IDs through middle insertion, first deletion, and movement', async () => {
    const root = path.resolve('/tmp/pair-editor-stable');
    const notebook = fakeNotebook(root, [fakeCell('A', 'a'), fakeCell('B', 'b')]);
    vscodeBoundary.__reset(notebook);
    const project = new CollaborativeProject();
    const synchronizer = new EditorSynchronizer(project, root, logger());
    try {
      await waitFor(() => project.has('work.ipynb'), 1000, 'initial notebook bind');
      const inserted = fakeCell('NEW');
      notebook.cells.splice(1, 0, inserted);
      reindex(notebook);
      vscodeBoundary.__fireNotebookChange(notebook, true);
      await waitFor(() => typeof inserted.metadata.pairNotebookCellId === 'string', 1000, 'new cell metadata ID');
      const insertedId = inserted.metadata.pairNotebookCellId;
      assert.deepEqual(notebook.cells.map((cell: any) => cell.metadata.pairNotebookCellId), ['a', insertedId, 'b']);
      assert.notEqual(insertedId, 'a');
      assert.notEqual(insertedId, 'b');

      notebook.cells.splice(0, 1);
      reindex(notebook);
      vscodeBoundary.__fireNotebookChange(notebook, true);
      assert.deepEqual(notebook.cells.map((cell: any) => cell.metadata.pairNotebookCellId), [insertedId, 'b']);

      notebook.cells.splice(0, 2, notebook.cells[1], notebook.cells[0]);
      reindex(notebook);
      vscodeBoundary.__fireNotebookChange(notebook, true);
      assert.deepEqual(notebook.cells.map((cell: any) => cell.metadata.pairNotebookCellId), ['b', insertedId]);
      assert.deepEqual(project.notebookSnapshot('work.ipynb').cells.map((cell) => cell.id), ['b', insertedId]);
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('applies remote Yjs structure/text/metadata/output updates to the correct stable cell with a minimal splice', async () => {
    const root = path.resolve('/tmp/pair-editor-remote');
    const notebook = fakeNotebook(root, [fakeCell('A', 'a'), fakeCell('B', 'b')]);
    vscodeBoundary.__reset(notebook);
    const local = new CollaborativeProject();
    const synchronizer = new EditorSynchronizer(local, root, logger());
    const remote = new CollaborativeProject();
    try {
      await waitFor(() => local.has('work.ipynb'), 1000, 'initial notebook bind');
      remote.applyRemoteUpdate('work.ipynb', 'notebook', local.encodeUpdate('work.ipynb'));
      const updates: ProjectUpdate[] = [];
      remote.on('update', (event: ProjectUpdate) => {
        if (event.origin !== REMOTE_ORIGIN) updates.push(event);
      });
      const initial = remote.notebookSnapshot('work.ipynb');
      remote.reconcileNotebook('work.ipynb', {
        ...initial,
        cells: [initial.cells[0]!, {
          id: 'remote-new', kind: 2, language: 'python', source: 'REMOTE', metadata: {}, outputs: [],
        }, initial.cells[1]!],
      });
      applyUpdates(local, updates.splice(0));
      await waitFor(() => notebook.cells.length === 3, 1000, 'remote structural edit');
      assert.deepEqual(notebook.cells.map((cell: any) => cell.metadata.pairNotebookCellId), ['a', 'remote-new', 'b']);
      assert.ok(vscodeBoundary.__notebookEdits.some((edit: any) =>
        edit.type === 'replaceCells' && edit.range.start === 1 && edit.range.end === 1 && edit.cells.length === 1));

      remote.applyCellTextChanges('work.ipynb', 'b', [{ offset: 1, deleteCount: 0, insertText: '-REMOTE' }]);
      remote.setCellMetadata('work.ipynb', 'b', { owner: 'remote' });
      remote.setCellOutputs('work.ipynb', 'b', [{
        metadata: { outputType: 'display_data' },
        items: [{ mime: 'text/html', dataBase64: Buffer.from('<b>PAIR</b>').toString('base64') }],
      }]);
      remote.setCellExecution('work.ipynb', 'b', {
        executionOrder: 7,
        success: true,
        timing: { startTime: 100, endTime: 200 },
      });
      applyUpdates(local, updates.splice(0));
      await waitFor(() => notebook.cells[2].document.getText().includes('REMOTE')
        && notebook.cells[2].metadata.owner === 'remote'
        && notebook.cells[2].outputs.length === 1
        && notebook.cells[2].executionSummary?.timing?.endTime === 200, 1500, 'remote cell fields');
      assert.equal(notebook.cells[2].metadata.pairNotebookCellId, 'b');
      assert.equal(Buffer.from(notebook.cells[2].outputs[0].items[0].data).toString('utf8'), '<b>PAIR</b>');
      assert.deepEqual(notebook.cells[2].executionSummary, {
        executionOrder: 7,
        success: true,
        timing: { startTime: 100, endTime: 200 },
      });
    } finally {
      synchronizer.dispose();
      local.destroy();
      remote.destroy();
    }
  });

  it('saves an open notebook through the VS Code document API after queued CRDT edits settle', async () => {
    const root = path.resolve('/tmp/pair-editor-save');
    const notebook = fakeNotebook(root, [fakeCell('before', 'stable')]);
    vscodeBoundary.__reset(notebook);
    const project = new CollaborativeProject();
    const synchronizer = new EditorSynchronizer(project, root, logger());
    try {
      await synchronizer.whenNotebookReady(notebook);
      project.applyCellTextChanges('work.ipynb', 'stable', [{ offset: 0, deleteCount: 6, insertText: 'after' }], REMOTE_ORIGIN);
      assert.equal(await synchronizer.persistWorkingCopy('work.ipynb', Buffer.from('ignored')), true);
      assert.equal(notebook.cells[0].document.getText(), 'after');
      assert.equal(notebook.saveCount, 1, 'native notebook.save owns the physical write');
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('serializes rapid remote text edits and leaves the editor at the newest CRDT state', async () => {
    const root = path.resolve('/tmp/pair-editor-text-queue');
    const document = fakeTextDocument(path.join(root, 'notes.txt'), 'base');
    vscodeBoundary.__resetText(document);
    const project = new CollaborativeProject();
    project.ensureText('notes.txt', 'base');
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let applyCalls = 0;
    vscodeBoundary.__beforeApplyEdit = async () => {
      applyCalls += 1;
      if (applyCalls === 1) await firstGate;
    };
    const synchronizer = new EditorSynchronizer(project, root, logger());
    try {
      project.replaceText('notes.txt', 'first', REMOTE_ORIGIN);
      await waitFor(() => applyCalls === 1, 1000, 'first remote text edit');
      project.replaceText('notes.txt', 'second', REMOTE_ORIGIN);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(applyCalls, 1, 'the second edit waits for the first workspace edit');
      releaseFirst();
      await waitFor(() => document.text === 'second', 1000, 'latest remote text state');
      assert.equal(applyCalls, 2);
    } finally {
      releaseFirst();
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('keeps participant mirrors unsaved while allowing an explicit execution snapshot', async () => {
    const root = path.resolve('/tmp/pair-editor-peer-save');
    const notebook = fakeNotebook(root, [fakeCell('before', 'stable')]);
    vscodeBoundary.__reset(notebook);
    const project = new CollaborativeProject();
    const synchronizer = new EditorSynchronizer(project, root, logger(), undefined, () => false);
    try {
      await synchronizer.whenNotebookReady(notebook);
      project.applyCellTextChanges('work.ipynb', 'stable', [{ offset: 0, deleteCount: 6, insertText: 'after' }], REMOTE_ORIGIN);
      assert.equal(await synchronizer.persistWorkingCopy('work.ipynb', Buffer.from('ignored')), true);
      assert.equal(notebook.cells[0].document.getText(), 'after');
      assert.equal(notebook.saveCount, 0, 'a non-host never saves during background persistence');
      await synchronizer.prepareWorkingCopy();
      assert.equal(notebook.saveCount, 1, 'local execution may explicitly materialize its isolated mirror');
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('does not bind sensitive project files opened in the editor', async () => {
    const root = path.resolve('/tmp/pair-editor-sensitive');
    const notebook = fakeNotebook(root, [fakeCell('secret = true')], '.ssh/private.ipynb');
    vscodeBoundary.__reset(notebook);
    const project = new CollaborativeProject();
    const synchronizer = new EditorSynchronizer(project, root, logger());
    try {
      await synchronizer.whenNotebookReady(notebook);
      assert.equal(project.keys().length, 0);
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('does not reinterpret a notebook opened as raw text as a collaborative text file', async () => {
    const root = path.resolve('/tmp/pair-editor-raw-notebook');
    const project = new CollaborativeProject();
    project.ensureNotebook('work.ipynb', {
      metadata: {},
      cells: [{ id: 'stable', kind: 2, language: 'python', source: '1 + 1', metadata: {}, outputs: [] }],
    });
    const rawDocument = {
      uri: vscodeBoundary.Uri.file(path.join(root, 'work.ipynb')),
      getText: () => '{"cells":[]}',
    };
    vscodeBoundary.workspace.notebookDocuments = [];
    vscodeBoundary.workspace.textDocuments = [rawDocument];
    const synchronizer = new EditorSynchronizer(project, root, logger());
    try {
      assert.equal(project.kindOf('work.ipynb'), 'notebook');
      assert.equal(await synchronizer.persistWorkingCopy('work.ipynb', Buffer.from('ignored')), false);
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('repairs invalid and duplicate notebook cell metadata before sharing it', async () => {
    const root = path.resolve('/tmp/pair-editor-identities');
    const notebook = fakeNotebook(root, [
      fakeCell('A', 'duplicate'),
      fakeCell('B', 'duplicate'),
      fakeCell('C', 'invalid id!'),
    ]);
    vscodeBoundary.__reset(notebook);
    const project = new CollaborativeProject();
    const synchronizer = new EditorSynchronizer(project, root, logger());
    try {
      await synchronizer.whenNotebookReady(notebook);
      const ids: string[] = notebook.cells.map((cell: any) => cell.metadata.pairNotebookCellId as string);
      assert.equal(new Set(ids).size, 3);
      assert.ok(ids.every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id)));
      assert.deepEqual(project.notebookSnapshot('work.ipynb').cells.map((cell) => cell.id), ids);
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('does not save stale notebook contents when VS Code rejects a CRDT edit', async () => {
    const root = path.resolve('/tmp/pair-editor-rejected-edit');
    const notebook = fakeNotebook(root, [fakeCell('before', 'stable')]);
    vscodeBoundary.__reset(notebook);
    const project = new CollaborativeProject();
    const synchronizer = new EditorSynchronizer(project, root, logger());
    try {
      await synchronizer.whenNotebookReady(notebook);
      project.applyCellTextChanges('work.ipynb', 'stable', [
        { offset: 0, deleteCount: 6, insertText: 'after' },
      ], REMOTE_ORIGIN);
      vscodeBoundary.__rejectEdits = true;
      await assert.rejects(
        synchronizer.persistWorkingCopy('work.ipynb', Buffer.from('ignored')),
        /rejected remote/i,
      );
      assert.equal(notebook.saveCount, 0);
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('restores a notebook cell when local validation rejects its editor update', async () => {
    const root = path.resolve('/tmp/pair-editor-validation-revert');
    const notebook = fakeNotebook(root, [fakeCell('safe', 'stable')]);
    vscodeBoundary.__reset(notebook);
    const project = new CollaborativeProject();
    const synchronizer = new EditorSynchronizer(project, root, logger());
    try {
      await synchronizer.whenNotebookReady(notebook);
      notebook.cells[0].document.text = 'unsafe';
      (project as any).applyCellTextChanges = () => { throw new Error('collaborative text-size limit'); };
      vscodeBoundary.__fireTextChange(notebook.cells[0].document, [{
        rangeOffset: 0, rangeLength: 4, text: 'unsafe',
      }]);
      await waitFor(() => notebook.cells[0].document.text === 'safe', 1000, 'rejected cell restoration');
      assert.equal(project.notebookSnapshot('work.ipynb').cells[0]!.source, 'safe');
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });
});

function applyUpdates(project: CollaborativeProject, updates: ProjectUpdate[]): void {
  for (const event of updates) project.applyRemoteUpdate(event.key, event.kind, event.update, event.scope);
}

function fakeNotebook(root: string, cells: any[], relativePath = 'work.ipynb'): any {
  const notebook = {
    uri: vscodeBoundary.Uri.file(path.join(root, relativePath)),
    cells,
    metadata: { language_info: { name: 'python' } },
    saveCount: 0,
    get cellCount() { return this.cells.length; },
    getCells() { return this.cells; },
    cellAt(index: number) { return this.cells[index]; },
    async save() { this.saveCount += 1; return true; },
  };
  for (const cell of cells) cell.notebook = notebook;
  reindex(notebook);
  return notebook;
}

let cellHandle = 0;
function fakeCell(source: string, id?: string): any {
  const handle = cellHandle += 1;
  const document = {
    uri: new vscodeBoundary.Uri(`/cell/${handle}`, 'vscode-notebook-cell'),
    languageId: 'python',
    text: source,
    getText() { return this.text; },
    positionAt(offset: number) { return offset; },
  };
  return {
    index: 0,
    kind: 2,
    document,
    metadata: id ? { pairNotebookCellId: id } : {},
    outputs: [],
    executionSummary: undefined,
    notebook: undefined,
  };
}

function fakeTextDocument(absolutePath: string, source: string): any {
  return {
    uri: vscodeBoundary.Uri.file(absolutePath),
    text: source,
    getText() { return this.text; },
    positionAt(offset: number) { return offset; },
    async save() { return true; },
  };
}

function reindex(notebook: any): void {
  notebook.cells.forEach((cell: any, index: number) => {
    cell.index = index;
    cell.notebook = notebook;
  });
}

function createNotebookVscodeBoundary(): any {
  const handlers: Record<string, Array<(event: any) => void>> = {};
  const on = (name: string) => (callback: (event: any) => void) => {
    (handlers[name] ??= []).push(callback);
    return { dispose: () => { handlers[name] = (handlers[name] ?? []).filter((item) => item !== callback); } };
  };
  class Uri {
    public constructor(public readonly fsPath: string, public readonly scheme = 'file') {}
    public toString(): string { return `${this.scheme}://${this.fsPath}`; }
    public static file(value: string): Uri { return new Uri(value); }
  }
  class Range {
    public constructor(public readonly start: number, public readonly end: number) {}
  }
  class NotebookRange extends Range {}
  class NotebookCellData {
    public metadata: Record<string, unknown> = {};
    public outputs: any[] = [];
    public executionSummary: unknown;
    public constructor(public readonly kind: number, public readonly value: string, public readonly languageId: string) {}
  }
  class NotebookCellOutputItem {
    public constructor(public readonly data: Uint8Array, public readonly mime: string) {}
  }
  class NotebookCellOutput {
    public constructor(public items: any[], public metadata?: Record<string, unknown>) {}
  }
  class WorkspaceEdit {
    public operations: any[] = [];
    public replace(uri: Uri, range: Range, text: string): void { this.operations.push({ type: 'text', uri, range, text }); }
    public set(uri: Uri, edits: any[]): void { this.operations.push({ type: 'notebook', uri, edits }); }
  }
  const boundary: any = {
    Uri,
    Range,
    NotebookRange,
    NotebookCellData,
    NotebookCellOutput,
    NotebookCellOutputItem,
    WorkspaceEdit,
    NotebookEdit: {
      replaceCells: (range: NotebookRange, cells: any[]) => ({ type: 'replaceCells', range, cells }),
      updateCellMetadata: (index: number, metadata: Record<string, unknown>) => ({ type: 'cellMetadata', index, metadata }),
      updateNotebookMetadata: (metadata: Record<string, unknown>) => ({ type: 'notebookMetadata', metadata }),
    },
    workspace: {
      notebookDocuments: [] as any[],
      textDocuments: [] as any[],
      onDidOpenTextDocument: on('openText'),
      onDidChangeTextDocument: on('changeText'),
      onDidOpenNotebookDocument: on('openNotebook'),
      onDidChangeNotebookDocument: on('changeNotebook'),
      applyEdit: async (edit: WorkspaceEdit) => {
        if (boundary.__rejectEdits) return false;
        await boundary.__beforeApplyEdit?.(edit);
        for (const operation of edit.operations) {
          if (operation.type === 'text') {
            const cell = boundary.workspace.notebookDocuments.flatMap((item: any) => item.cells)
              .find((item: any) => item.document.uri.toString() === operation.uri.toString());
            const document = cell?.document ?? boundary.workspace.textDocuments
              .find((item: any) => item.uri.toString() === operation.uri.toString());
            if (document) document.text = `${document.text.slice(0, operation.range.start)}${operation.text}${document.text.slice(operation.range.end)}`;
            continue;
          }
          const notebook = boundary.workspace.notebookDocuments.find((item: any) => item.uri.toString() === operation.uri.toString());
          if (!notebook) continue;
          for (const notebookEdit of operation.edits) {
            boundary.__notebookEdits.push(notebookEdit);
            if (notebookEdit.type === 'cellMetadata') notebook.cells[notebookEdit.index].metadata = { ...notebookEdit.metadata };
            else if (notebookEdit.type === 'notebookMetadata') notebook.metadata = { ...notebookEdit.metadata };
            else if (notebookEdit.type === 'replaceCells') {
              const cells = notebookEdit.cells.map((data: any) => {
                const cell = fakeCell(data.value, data.metadata?.pairNotebookCellId);
                cell.kind = data.kind;
                cell.document.languageId = data.languageId;
                cell.metadata = { ...(data.metadata ?? {}) };
                cell.outputs = data.outputs ?? [];
                cell.executionSummary = data.executionSummary;
                return cell;
              });
              notebook.cells.splice(notebookEdit.range.start, notebookEdit.range.end - notebookEdit.range.start, ...cells);
              reindex(notebook);
            }
          }
        }
        return true;
      },
    },
    window: {
      showWarningMessage: async () => undefined,
    },
    __notebookEdits: [] as any[],
    __rejectEdits: false,
    __beforeApplyEdit: undefined as undefined | ((edit: WorkspaceEdit) => Promise<void>),
    __reset: (notebook: any) => {
      boundary.workspace.notebookDocuments = [notebook];
      boundary.workspace.textDocuments = [];
      boundary.__notebookEdits = [];
      boundary.__rejectEdits = false;
      boundary.__beforeApplyEdit = undefined;
    },
    __resetText: (document: any) => {
      boundary.workspace.notebookDocuments = [];
      boundary.workspace.textDocuments = [document];
      boundary.__notebookEdits = [];
      boundary.__rejectEdits = false;
      boundary.__beforeApplyEdit = undefined;
    },
    __fireNotebookChange: (notebook: any, structural: boolean) => {
      for (const callback of handlers.changeNotebook ?? []) callback({
        notebook,
        contentChanges: structural ? [{}] : [],
        cellChanges: [],
        metadata: undefined,
      });
    },
    __fireTextChange: (document: any, contentChanges: any[]) => {
      for (const callback of handlers.changeText ?? []) callback({ document, contentChanges });
    },
  };
  return boundary;
}

function logger(): any {
  return { appendLine: () => undefined };
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
