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
  for (const notebookCell of [false, true]) for (const local of [
    { name: 'append', text: 'abcL', offset: 3, length: 0, insert: 'L', expected: 'RabcL' },
    { name: 'identical insertion', text: 'Rabc', offset: 0, length: 0, insert: 'R', expected: 'RRabc' },
    { name: 'delete', text: 'ac', offset: 1, length: 1, insert: '', expected: 'Rac' },
  ]) {
    it(`preserves local ${local.name} during a pending remote ${notebookCell ? 'cell' : 'file'} edit`, async () => {
      const root = path.resolve('/tmp/pair-editor-concurrent-text');
      const notebook = fakeNotebook(root, [fakeCell('abc', 'a')]);
      const document = notebookCell ? notebook.cells[0].document : fakeTextDocument(path.join(root, 'notes.txt'), 'abc');
      if (notebookCell) vscodeBoundary.__reset(notebook);
      else vscodeBoundary.__resetText(document);
      const project = new CollaborativeProject();
      const synchronizer = new EditorSynchronizer(project, root, logger());
      let release!: () => void;
      let entered = false;
      try {
        if (notebookCell) await synchronizer.whenNotebookReady(notebook);
        vscodeBoundary.__beforeApplyEdit = async (edit: any) => {
          if (!edit.operations.some((operation: any) => operation.type === 'text')) return;
          vscodeBoundary.__beforeApplyEdit = undefined;
          entered = true;
          await new Promise<void>((resolve) => { release = resolve; });
        };
        const change = [{ offset: 0, deleteCount: 0, insertText: 'R' }];
        if (notebookCell) project.applyCellTextChanges('work.ipynb', 'a', change, REMOTE_ORIGIN);
        else project.applyTextChanges('notes.txt', change, REMOTE_ORIGIN);
        await waitFor(() => entered, 1000, 'remote edit queued');
        document.text = local.text;
        vscodeBoundary.__fireTextChange(document, [{ rangeOffset: local.offset, rangeLength: local.length, text: local.insert }]);
        release();
        const source = () => (notebookCell ? project.cellSource('work.ipynb', 'a') : project.text('notes.txt')).toString();
        await waitFor(() => document.getText() === local.expected, 1000, 'rebased editor text');
        assert.equal(source(), local.expected);
        document.text = `${local.expected}!`;
        vscodeBoundary.__fireTextChange(document, [{ rangeOffset: local.expected.length, rangeLength: 0, text: '!' }]);
        assert.equal(source(), `${local.expected}!`);
      } finally {
        release?.();
        synchronizer.dispose();
        project.destroy();
      }
    });
  }

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
    const synchronizer = new EditorSynchronizer(local, root, logger(), undefined, fakeCellStateRenderer());
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

      vscodeBoundary.__notebookEdits = [];
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
      const replacements = vscodeBoundary.__notebookEdits.filter((edit: any) => edit.type === 'replaceCells');
      assert.equal(replacements.length, 0, 'output/execution rendering must never replace the cell');
    } finally {
      synchronizer.dispose();
      local.destroy();
      remote.destroy();
    }
  });

  it('applies cellText by stable ID with one minimal text edit, zero replaceCells and no full snapshot', async () => {
    const root = path.resolve('/tmp/pair-editor-cell-text-scope');
    const left = fakeCell('LEFT', 'left');
    const target = fakeCell('abcXYZdef', 'target');
    target.metadata = { pairNotebookCellId: 'target', keep: 'metadata' };
    target.outputs = [{ metadata: { keep: true }, items: [] }];
    target.executionSummary = { executionOrder: 4, success: true };
    const right = fakeCell('RIGHT', 'right');
    const notebook = fakeNotebook(root, [left, target, right]);
    vscodeBoundary.__reset(notebook);
    const project = new CollaborativeProject();
    const synchronizer = new EditorSynchronizer(project, root, logger());
    try {
      await synchronizer.whenNotebookReady(notebook);
      const leftRef = notebook.cells[0];
      const targetRef = notebook.cells[1];
      const rightRef = notebook.cells[2];
      const metadataBefore = { ...target.metadata };
      const outputsBefore = target.outputs;
      const executionBefore = target.executionSummary;
      let fullSnapshotCalls = 0;
      const originalSnapshot = (synchronizer as any).applyNotebookSnapshot.bind(synchronizer);
      (synchronizer as any).applyNotebookSnapshot = async (...args: unknown[]) => {
        fullSnapshotCalls += 1;
        return originalSnapshot(...args);
      };
      vscodeBoundary.__notebookEdits = [];
      vscodeBoundary.__textEdits = [];

      project.applyCellTextChanges('work.ipynb', 'target', [
        { offset: 3, deleteCount: 3, insertText: '++' },
      ], REMOTE_ORIGIN);
      await waitFor(() => target.document.getText() === 'abc++def', 1000, 'scoped cell text edit');

      assert.equal(fullSnapshotCalls, 0);
      assert.equal(vscodeBoundary.__notebookEdits.filter((edit: any) => edit.type === 'replaceCells').length, 0);
      assert.equal(vscodeBoundary.__textEdits.length, 1);
      assert.equal(vscodeBoundary.__textEdits[0].range.start, 3);
      assert.equal(vscodeBoundary.__textEdits[0].range.end, 6);
      assert.equal(vscodeBoundary.__textEdits[0].text, '++');
      assert.equal(notebook.cells[0], leftRef);
      assert.equal(notebook.cells[1], targetRef);
      assert.equal(notebook.cells[2], rightRef);
      assert.deepEqual(target.metadata, metadataBefore);
      assert.equal(target.outputs, outputsBefore);
      assert.equal(target.executionSummary, executionBefore);
      assert.equal(target.metadata.pairNotebookCellId, 'target');
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('applies cellMetadata by stable ID with updateCellMetadata only and preserves source/output/execution', async () => {
    const root = path.resolve('/tmp/pair-editor-cell-metadata-scope');
    const moved = fakeCell('TARGET SOURCE', 'target');
    moved.outputs = [{ metadata: { x: 1 }, items: [] }];
    moved.executionSummary = { executionOrder: 9, success: false };
    const notebook = fakeNotebook(root, [fakeCell('OTHER', 'other'), moved]);
    vscodeBoundary.__reset(notebook);
    const project = new CollaborativeProject();
    const synchronizer = new EditorSynchronizer(project, root, logger());
    try {
      await synchronizer.whenNotebookReady(notebook);
      const sourceBefore = moved.document.getText();
      const outputsBefore = moved.outputs;
      const executionBefore = moved.executionSummary;
      let fullSnapshotCalls = 0;
      const originalSnapshot = (synchronizer as any).applyNotebookSnapshot.bind(synchronizer);
      (synchronizer as any).applyNotebookSnapshot = async (...args: unknown[]) => {
        fullSnapshotCalls += 1;
        return originalSnapshot(...args);
      };
      vscodeBoundary.__notebookEdits = [];
      project.setCellMetadata('work.ipynb', 'target', { z: 2, a: 1 }, REMOTE_ORIGIN);
      await waitFor(() => moved.metadata.a === 1 && moved.metadata.z === 2, 1000, 'scoped cell metadata');

      assert.equal(fullSnapshotCalls, 0);
      assert.equal(vscodeBoundary.__notebookEdits.filter((edit: any) => edit.type === 'replaceCells').length, 0);
      assert.equal(vscodeBoundary.__notebookEdits.filter((edit: any) => edit.type === 'cellMetadata').length, 1);
      assert.equal(moved.document.getText(), sourceBefore);
      assert.equal(moved.outputs, outputsBefore);
      assert.equal(moved.executionSummary, executionBefore);
      assert.equal(moved.metadata.pairNotebookCellId, 'target');
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('applies notebookMetadata without replacing cells and preserves every cell object', async () => {
    const root = path.resolve('/tmp/pair-editor-notebook-metadata-scope');
    const first = fakeCell('A', 'a');
    const second = fakeCell('B', 'b');
    const notebook = fakeNotebook(root, [first, second]);
    vscodeBoundary.__reset(notebook);
    const project = new CollaborativeProject();
    const synchronizer = new EditorSynchronizer(project, root, logger());
    try {
      await synchronizer.whenNotebookReady(notebook);
      let fullSnapshotCalls = 0;
      const originalSnapshot = (synchronizer as any).applyNotebookSnapshot.bind(synchronizer);
      (synchronizer as any).applyNotebookSnapshot = async (...args: unknown[]) => {
        fullSnapshotCalls += 1;
        return originalSnapshot(...args);
      };
      vscodeBoundary.__notebookEdits = [];
      project.setNotebookMetadata('work.ipynb', { language_info: { name: 'python' }, owner: 'remote' }, REMOTE_ORIGIN);
      await waitFor(() => notebook.metadata.owner === 'remote', 1000, 'scoped notebook metadata');

      assert.equal(fullSnapshotCalls, 0);
      assert.equal(vscodeBoundary.__notebookEdits.filter((edit: any) => edit.type === 'replaceCells').length, 0);
      assert.equal(vscodeBoundary.__notebookEdits.filter((edit: any) => edit.type === 'notebookMetadata').length, 1);
      assert.equal(notebook.cells[0], first);
      assert.equal(notebook.cells[1], second);
      assert.equal(first.metadata.pairNotebookCellId, 'a');
      assert.equal(second.metadata.pairNotebookCellId, 'b');
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('does not escalate a cell metadata apply failure to a full notebook snapshot', async () => {
    const root = path.resolve('/tmp/pair-editor-metadata-failure');
    const notebook = fakeNotebook(root, [fakeCell('A', 'a'), fakeCell('B', 'b')]);
    vscodeBoundary.__reset(notebook);
    const project = new CollaborativeProject();
    const synchronizer = new EditorSynchronizer(project, root, logger());
    try {
      await synchronizer.whenNotebookReady(notebook);
      let fullSnapshotCalls = 0;
      (synchronizer as any).applyNotebookSnapshot = async () => { fullSnapshotCalls += 1; };
      vscodeBoundary.__rejectEdits = true;
      project.setCellMetadata('work.ipynb', 'b', { owner: 'remote' }, REMOTE_ORIGIN);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(fullSnapshotCalls, 0);
      assert.equal(vscodeBoundary.__notebookEdits.filter((edit: any) => edit.type === 'replaceCells').length, 0);
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('coalesces a remote output burst into one render and the last canonical output wins', async () => {
    const root = path.resolve('/tmp/pair-editor-output-coalesce');
    const target = fakeCell('TARGET', 'target');
    const notebook = fakeNotebook(root, [target]);
    vscodeBoundary.__reset(notebook);
    const project = new CollaborativeProject();
    const calls: any[] = [];
    const synchronizer = new EditorSynchronizer(
      project, root, logger(), undefined, recordingCellStateRenderer(calls),
    );
    try {
      await synchronizer.whenNotebookReady(notebook);
      for (const value of ['first', 'second', 'third']) {
        project.setCellOutputs('work.ipynb', 'target', [{
          metadata: { outputType: 'stream' },
          items: [{ mime: 'text/plain', dataBase64: Buffer.from(value).toString('base64') }],
        }], REMOTE_ORIGIN);
      }
      await waitFor(() => calls.length === 1, 1000, 'coalesced output burst');
      assert.equal(calls.length, 1);
      assert.equal(
        Buffer.from(calls[0].outputs[0].items[0].data).toString('utf8'),
        'third',
      );
      assert.equal(target.outputs.length, 1, 'the editor exposes only the final coalesced output');
      assert.equal(Buffer.from(target.outputs[0].items[0].data).toString('utf8'), 'third');
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('does not lose a terminal execution update that arrives inside the coalescing window', async () => {
    const root = path.resolve('/tmp/pair-editor-execution-terminal-coalesce');
    const target = fakeCell('TARGET', 'target');
    const notebook = fakeNotebook(root, [target]);
    vscodeBoundary.__reset(notebook);
    const project = new CollaborativeProject();
    const calls: any[] = [];
    const synchronizer = new EditorSynchronizer(
      project, root, logger(), undefined, recordingCellStateRenderer(calls),
    );
    try {
      await synchronizer.whenNotebookReady(notebook);
      project.setCellExecution('work.ipynb', 'target', { executionOrder: 4 }, REMOTE_ORIGIN);
      project.setCellExecution('work.ipynb', 'target', {
        executionOrder: 4,
        success: true,
        timing: { startTime: 10, endTime: 20 },
      }, REMOTE_ORIGIN);
      await waitFor(() => calls.length === 1, 1000, 'terminal execution coalescing');
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].execution, {
        executionOrder: 4,
        success: true,
        timing: { startTime: 10, endTime: 20 },
      });
      assert.equal(target.executionSummary.success, true);
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('applies an outputs-only remote update through the renderer with zero replaceCells and no neighbor mutation', async () => {
    const root = path.resolve('/tmp/pair-editor-output-only');
    const target = fakeCell('TARGET', 'target');
    target.metadata = { pairNotebookCellId: 'target', owner: 'keep' };
    const neighbor = fakeCell('NEIGHBOR', 'neighbor');
    neighbor.outputs = [{ metadata: { keep: true }, items: [] }];
    const neighborOutputs = neighbor.outputs;
    const neighborSummary = { executionOrder: 12, success: true };
    neighbor.executionSummary = neighborSummary;
    const notebook = fakeNotebook(root, [target, neighbor]);
    vscodeBoundary.__reset(notebook);
    const project = new CollaborativeProject();
    const synchronizer = new EditorSynchronizer(project, root, logger(), undefined, fakeCellStateRenderer());
    try {
      await synchronizer.whenNotebookReady(notebook);
      const targetSource = target.document.getText();
      const targetMetadata = { ...target.metadata };
      let fullSnapshotCalls = 0;
      const originalSnapshot = (synchronizer as any).applyNotebookSnapshot.bind(synchronizer);
      (synchronizer as any).applyNotebookSnapshot = async (...args: unknown[]) => {
        fullSnapshotCalls += 1;
        return originalSnapshot(...args);
      };
      vscodeBoundary.__notebookEdits = [];

      project.setCellOutputs('work.ipynb', 'target', [{
        metadata: { outputType: 'stream' },
        items: [{ mime: 'text/plain', dataBase64: Buffer.from('REMOTE OUT').toString('base64') }],
      }], REMOTE_ORIGIN);

      await waitFor(() => target.outputs.length === 1, 1000, 'outputs-only renderer');
      assert.equal(
        vscodeBoundary.__notebookEdits.filter((edit: any) => edit.type === 'replaceCells').length,
        0,
      );
      assert.equal(target.document.getText(), targetSource);
      assert.deepEqual(target.metadata, targetMetadata);
      assert.equal(
        Buffer.from(target.outputs[0].items[0].data).toString('utf8'),
        'REMOTE OUT',
      );
      assert.equal(neighbor.outputs, neighborOutputs);
      assert.equal(neighbor.executionSummary, neighborSummary);
      assert.equal(fullSnapshotCalls, 0, 'ordinary output updates never enter full snapshot recovery');
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('applies an execution-only remote update through the renderer with zero replaceCells and no neighbor mutation', async () => {
    const root = path.resolve('/tmp/pair-editor-execution-only');
    const target = fakeCell('TARGET', 'target');
    const targetOutputs = [{ metadata: { keep: true }, items: [] }];
    target.outputs = targetOutputs;
    const neighbor = fakeCell('NEIGHBOR', 'neighbor');
    const neighborMetadata = { ...neighbor.metadata };
    const neighborOutputs = [{ metadata: { neighbor: true }, items: [] }];
    neighbor.outputs = neighborOutputs;
    const notebook = fakeNotebook(root, [target, neighbor]);
    vscodeBoundary.__reset(notebook);
    const project = new CollaborativeProject();
    const synchronizer = new EditorSynchronizer(project, root, logger(), undefined, fakeCellStateRenderer());
    try {
      await synchronizer.whenNotebookReady(notebook);
      const targetSource = target.document.getText();
      const targetMetadata = { ...target.metadata };
      let fullSnapshotCalls = 0;
      const originalSnapshot = (synchronizer as any).applyNotebookSnapshot.bind(synchronizer);
      (synchronizer as any).applyNotebookSnapshot = async (...args: unknown[]) => {
        fullSnapshotCalls += 1;
        return originalSnapshot(...args);
      };
      vscodeBoundary.__notebookEdits = [];

      project.setCellExecution('work.ipynb', 'target', {
        executionOrder: 5,
        success: true,
      }, REMOTE_ORIGIN);

      await waitFor(() => target.executionSummary?.success === true, 1000, 'execution-only renderer');
      assert.equal(
        vscodeBoundary.__notebookEdits.filter((edit: any) => edit.type === 'replaceCells').length,
        0,
      );
      assert.equal(target.document.getText(), targetSource);
      assert.deepEqual(target.metadata, targetMetadata);
      assert.equal(target.outputs, targetOutputs);
      assert.deepEqual(target.executionSummary, {
        executionOrder: 5,
        success: true,
        timing: undefined,
      });
      assert.deepEqual(neighbor.metadata, neighborMetadata);
      assert.equal(neighbor.outputs, neighborOutputs);
      assert.equal(neighbor.executionSummary, undefined);
      assert.equal(fullSnapshotCalls, 0, 'ordinary execution updates never enter full snapshot recovery');
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('allows full snapshot only after a proven structural inconsistency', async () => {
    const root = path.resolve('/tmp/pair-editor-structural-fallback');
    const notebook = fakeNotebook(root, [fakeCell('A', 'a')]);
    vscodeBoundary.__reset(notebook);
    const project = new CollaborativeProject();
    const synchronizer = new EditorSynchronizer(
      project, root, logger(), undefined, fakeCellStateRenderer(),
    );
    try {
      await synchronizer.whenNotebookReady(notebook);
      let snapshotCalls = 0;
      const originalSnapshot = (synchronizer as any).applyNotebookSnapshot.bind(synchronizer);
      (synchronizer as any).applyNotebookSnapshot = async (...args: unknown[]) => {
        snapshotCalls += 1;
        return originalSnapshot(...args);
      };
      const snapshot = project.notebookSnapshot('work.ipynb');
      project.reconcileNotebook('work.ipynb', {
        ...snapshot,
        cells: [
          snapshot.cells[0]!,
          { id: 'new', kind: 2, language: 'python', source: 'NEW', metadata: {}, outputs: [] },
        ],
      }, REMOTE_ORIGIN);
      await waitFor(() => notebook.cells.length === 2, 1000, 'structural recovery snapshot');
      assert.equal(snapshotCalls, 1);
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('uses one minimal structural splice for insert and preserves unaffected cell identities', async () => {
    const root = path.resolve('/tmp/pair-editor-structure-insert');
    const a = fakeCell('A', 'a');
    const b = fakeCell('B', 'b');
    const notebook = fakeNotebook(root, [a, b]);
    vscodeBoundary.__reset(notebook);
    const project = new CollaborativeProject();
    const synchronizer = new EditorSynchronizer(project, root, logger(), undefined, fakeCellStateRenderer());
    try {
      await synchronizer.whenNotebookReady(notebook);
      const snapshot = project.notebookSnapshot('work.ipynb');
      vscodeBoundary.__notebookEdits = [];
      project.reconcileNotebook('work.ipynb', {
        ...snapshot,
        cells: [{ id: 'new', kind: 2, language: 'python', source: 'NEW', metadata: {}, outputs: [] }, ...snapshot.cells],
      }, REMOTE_ORIGIN);
      await waitFor(() => notebook.cells.length === 3, 1000, 'structure insert');
      const replacements = vscodeBoundary.__notebookEdits.filter((edit: any) => edit.type === 'replaceCells');
      assert.equal(replacements.length, 1);
      assert.equal(replacements[0].range.start, 0);
      assert.equal(replacements[0].range.end, 0);
      assert.equal(replacements[0].cells.length, 1);
      assert.equal(notebook.cells[1], a);
      assert.equal(notebook.cells[2], b);
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('uses one minimal structural splice for delete and preserves unaffected cell identities', async () => {
    const root = path.resolve('/tmp/pair-editor-structure-delete');
    const a = fakeCell('A', 'a');
    const b = fakeCell('B', 'b');
    const c = fakeCell('C', 'c');
    const notebook = fakeNotebook(root, [a, b, c]);
    vscodeBoundary.__reset(notebook);
    const project = new CollaborativeProject();
    const synchronizer = new EditorSynchronizer(project, root, logger(), undefined, fakeCellStateRenderer());
    try {
      await synchronizer.whenNotebookReady(notebook);
      const snapshot = project.notebookSnapshot('work.ipynb');
      vscodeBoundary.__notebookEdits = [];
      project.reconcileNotebook('work.ipynb', {
        ...snapshot,
        cells: [snapshot.cells[0]!, snapshot.cells[2]!],
      }, REMOTE_ORIGIN);
      await waitFor(() => notebook.cells.length === 2, 1000, 'structure delete');
      const replacements = vscodeBoundary.__notebookEdits.filter((edit: any) => edit.type === 'replaceCells');
      assert.equal(replacements.length, 1);
      assert.equal(replacements[0].range.start, 1);
      assert.equal(replacements[0].range.end, 2);
      assert.equal(replacements[0].cells.length, 0);
      assert.equal(notebook.cells[0], a);
      assert.equal(notebook.cells[1], c);
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('uses a bounded structural splice for reorder and preserves unaffected prefix/suffix identities', async () => {
    const root = path.resolve('/tmp/pair-editor-structure-reorder');
    const a = fakeCell('A', 'a');
    const b = fakeCell('B', 'b');
    const c = fakeCell('C', 'c');
    const d = fakeCell('D', 'd');
    const notebook = fakeNotebook(root, [a, b, c, d]);
    vscodeBoundary.__reset(notebook);
    const project = new CollaborativeProject();
    const synchronizer = new EditorSynchronizer(project, root, logger(), undefined, fakeCellStateRenderer());
    try {
      await synchronizer.whenNotebookReady(notebook);
      const snapshot = project.notebookSnapshot('work.ipynb');
      vscodeBoundary.__notebookEdits = [];
      project.reconcileNotebook('work.ipynb', {
        ...snapshot,
        cells: [snapshot.cells[0]!, snapshot.cells[2]!, snapshot.cells[1]!, snapshot.cells[3]!],
      }, REMOTE_ORIGIN);
      await waitFor(() => notebook.cells.map((cell: any) => cell.metadata.pairNotebookCellId).join(',') === 'a,c,b,d',
        1000, 'structure reorder');
      const replacements = vscodeBoundary.__notebookEdits.filter((edit: any) => edit.type === 'replaceCells');
      assert.equal(replacements.length, 1);
      assert.equal(replacements[0].range.start, 1);
      assert.equal(replacements[0].range.end, 3);
      assert.equal(replacements[0].cells.length, 2);
      assert.equal(notebook.cells[0], a);
      assert.equal(notebook.cells[3], d);
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('restores notebook/text selection and a stable viewport anchor after structural insert', async () => {
    const root = path.resolve('/tmp/pair-editor-structure-ui');
    const a = fakeCell('AAAA', 'a');
    const b = fakeCell('BBBB', 'b');
    const notebook = fakeNotebook(root, [a, b]);
    vscodeBoundary.__reset(notebook);
    const revealCalls: any[] = [];
    const notebookEditor: any = {
      notebook,
      selection: new vscodeBoundary.NotebookRange(1, 2),
      selections: [new vscodeBoundary.NotebookRange(1, 2)],
      visibleRanges: [new vscodeBoundary.NotebookRange(1, 2)],
      revealRange: (range: any, revealType: any) => {
        revealCalls.push({ range, revealType });
        notebookEditor.visibleRanges = [range];
      },
    };
    const textSelection = { anchor: 2, active: 3 };
    const textEditor: any = { document: b.document, selections: [textSelection] };
    vscodeBoundary.window.activeNotebookEditor = notebookEditor;
    vscodeBoundary.window.visibleNotebookEditors = [notebookEditor];
    vscodeBoundary.window.activeTextEditor = textEditor;
    vscodeBoundary.window.visibleTextEditors = [textEditor];

    const project = new CollaborativeProject();
    const synchronizer = new EditorSynchronizer(project, root, logger(), undefined, fakeCellStateRenderer());
    try {
      await synchronizer.whenNotebookReady(notebook);
      const snapshot = project.notebookSnapshot('work.ipynb');
      project.reconcileNotebook('work.ipynb', {
        ...snapshot,
        cells: [{ id: 'new', kind: 2, language: 'python', source: 'NEW', metadata: {}, outputs: [] }, ...snapshot.cells],
      }, REMOTE_ORIGIN);
      await waitFor(() => notebook.cells.length === 3, 1000, 'structure UI restore');
      assert.equal(notebook.cells[2], b);
      assert.equal(notebookEditor.selections[0].start, 2);
      assert.equal(notebookEditor.selections[0].end, 3);
      assert.deepEqual(textEditor.selections, [textSelection]);
      assert.equal(revealCalls.length, 1);
      assert.equal(revealCalls[0].range.start, 2);
      assert.equal(revealCalls[0].revealType, vscodeBoundary.NotebookEditorRevealType.AtTop);
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('does not fabricate cell/line zero when the active stable cell is deleted', async () => {
    const root = path.resolve('/tmp/pair-editor-structure-delete-active');
    const a = fakeCell('A', 'a');
    const b = fakeCell('B', 'b');
    const notebook = fakeNotebook(root, [a, b]);
    vscodeBoundary.__reset(notebook);
    const originalSelections = [new vscodeBoundary.NotebookRange(1, 2)];
    const notebookEditor: any = {
      notebook,
      selection: originalSelections[0],
      selections: originalSelections,
      visibleRanges: [new vscodeBoundary.NotebookRange(0, 2)],
      revealRange: () => undefined,
    };
    vscodeBoundary.window.activeNotebookEditor = notebookEditor;
    vscodeBoundary.window.visibleNotebookEditors = [notebookEditor];

    const project = new CollaborativeProject();
    const synchronizer = new EditorSynchronizer(project, root, logger(), undefined, fakeCellStateRenderer());
    try {
      await synchronizer.whenNotebookReady(notebook);
      const snapshot = project.notebookSnapshot('work.ipynb');
      project.reconcileNotebook('work.ipynb', {
        ...snapshot,
        cells: [snapshot.cells[0]!],
      }, REMOTE_ORIGIN);
      await waitFor(() => notebook.cells.length === 1, 1000, 'delete active cell');
      assert.equal(notebookEditor.selections, originalSelections);
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('keeps background persistence out of the open notebook save hot path', async () => {
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
      assert.equal(notebook.saveCount, 0, 'background persistence never save-spams an open notebook');
      await synchronizer.prepareWorkingCopy();
      assert.equal(notebook.saveCount, 1, 'an explicit filesystem barrier may save the open notebook');
    } finally {
      synchronizer.dispose();
      project.destroy();
    }
  });

  it('keeps background text persistence unsaved and saves only at an explicit filesystem barrier', async () => {
    const root = path.resolve('/tmp/pair-editor-text-save');
    const document = fakeTextDocument(path.join(root, 'notes.txt'), 'before');
    vscodeBoundary.__resetText(document);
    const project = new CollaborativeProject();
    project.ensureText('notes.txt', 'before');
    const synchronizer = new EditorSynchronizer(project, root, logger());
    try {
      project.replaceText('notes.txt', 'after', REMOTE_ORIGIN);
      assert.equal(await synchronizer.persistWorkingCopy('notes.txt', Buffer.from('ignored')), true);
      assert.equal(document.text, 'after');
      assert.equal(document.saveCount, 0, 'background text persistence never calls document.save()');
      await synchronizer.prepareWorkingCopy();
      assert.equal(document.saveCount, 1, 'explicit filesystem barrier calls document.save() exactly once');
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
    const synchronizer = new EditorSynchronizer(project, root, logger());
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

  it('restores a notebook cell before publishing a change to another participant-selected line', async () => {
    const root = path.resolve('/tmp/pair-editor-line-lock');
    const notebook = fakeNotebook(root, [fakeCell('locked', 'stable')]);
    vscodeBoundary.__reset(notebook);
    const project = new CollaborativeProject();
    const synchronizer = new EditorSynchronizer(
      project,
      root,
      logger(),
      undefined,
      undefined,
      () => 'Line is currently selected by Guest.',
    );
    try {
      await synchronizer.whenNotebookReady(notebook);
      notebook.cells[0].document.text = 'attempted overwrite';
      vscodeBoundary.__fireTextChange(notebook.cells[0].document, [{
        rangeOffset: 0, rangeLength: 6, text: 'attempted overwrite',
      }]);
      await waitFor(() => notebook.cells[0].document.text === 'locked', 1000, 'line-lock restoration');
      assert.equal(project.notebookSnapshot('work.ipynb').cells[0]!.source, 'locked');
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
    getCells(range?: { start: number; end: number }) {
      return range ? this.cells.slice(range.start, range.end) : this.cells;
    },
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
    saveCount: 0,
    getText() { return this.text; },
    positionAt(offset: number) { return offset; },
    async save() { this.saveCount += 1; return true; },
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
      onDidCloseTextDocument: on('closeText'),
      onDidOpenNotebookDocument: on('openNotebook'),
      onDidChangeNotebookDocument: on('changeNotebook'),
      applyEdit: async (edit: WorkspaceEdit) => {
        if (boundary.__rejectEdits) return false;
        const documents = [...boundary.workspace.textDocuments,
          ...boundary.workspace.notebookDocuments.flatMap((item: any) => item.cells.map((cell: any) => cell.document))];
        const versions = new Map(documents.map((document: any) => [document, document.version]));
        await boundary.__beforeApplyEdit?.(edit);
        if (edit.operations.some((operation: any) => operation.type === 'text'
          && documents.some((document: any) => document.uri.toString() === operation.uri.toString()
            && document.version !== versions.get(document)))) return false;
        for (const operation of edit.operations) {
          if (operation.type === 'text') {
            boundary.__textEdits.push(operation);
            const cell = boundary.workspace.notebookDocuments.flatMap((item: any) => item.cells)
              .find((item: any) => item.document.uri.toString() === operation.uri.toString());
            const document = cell?.document ?? boundary.workspace.textDocuments
              .find((item: any) => item.uri.toString() === operation.uri.toString());
            if (document) {
              document.text = `${document.text.slice(0, operation.range.start)}${operation.text}${document.text.slice(operation.range.end)}`;
              boundary.__fireTextChange(document, [{ rangeOffset: operation.range.start,
                rangeLength: operation.range.end - operation.range.start, text: operation.text }]);
            }
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
      activeNotebookEditor: undefined as any,
      activeTextEditor: undefined as any,
      visibleNotebookEditors: [] as any[],
      visibleTextEditors: [] as any[],
      showWarningMessage: async () => undefined,
    },
    NotebookEditorRevealType: { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 },
    __notebookEdits: [] as any[],
    __textEdits: [] as any[],
    __rejectEdits: false,
    __beforeApplyEdit: undefined as undefined | ((edit: WorkspaceEdit) => Promise<void>),
    __reset: (notebook: any) => {
      boundary.workspace.notebookDocuments = [notebook];
      boundary.workspace.textDocuments = [];
      boundary.__notebookEdits = [];
      boundary.__textEdits = [];
      boundary.__rejectEdits = false;
      boundary.__beforeApplyEdit = undefined;
      boundary.window.activeNotebookEditor = undefined;
      boundary.window.activeTextEditor = undefined;
      boundary.window.visibleNotebookEditors = [];
      boundary.window.visibleTextEditors = [];
    },
    __resetText: (document: any) => {
      boundary.workspace.notebookDocuments = [];
      boundary.workspace.textDocuments = [document];
      boundary.__notebookEdits = [];
      boundary.__textEdits = [];
      boundary.__rejectEdits = false;
      boundary.__beforeApplyEdit = undefined;
      boundary.window.activeNotebookEditor = undefined;
      boundary.window.activeTextEditor = undefined;
      boundary.window.visibleNotebookEditors = [];
      boundary.window.visibleTextEditors = [];
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
      document.version = (document.version ?? 0) + 1;
      for (const callback of handlers.changeText ?? []) callback({ document, contentChanges });
    },
  };
  return boundary;
}

function recordingCellStateRenderer(calls: any[]): any {
  return {
    renderRemoteCellState: async (cell: any, request: any) => {
      calls.push({
        cellId: cell.metadata.pairNotebookCellId,
        outputs: request.outputs,
        execution: request.execution,
        outputsChanged: request.outputsChanged,
        executionChanged: request.executionChanged,
        executionMode: request.executionMode,
      });
      if (request.outputsChanged) cell.outputs = [...request.outputs];
      if (request.executionChanged) {
        cell.executionSummary = request.execution
          ? {
            executionOrder: request.execution.executionOrder,
            success: request.execution.success,
            timing: request.execution.timing ? { ...request.execution.timing } : undefined,
          }
          : undefined;
      }
    },
  };
}

function fakeCellStateRenderer(): any {
  return {
    renderRemoteCellState: async (cell: any, request: any) => {
      if (request.outputsChanged) cell.outputs = [...request.outputs];
      if (request.executionChanged) {
        cell.executionSummary = request.execution
          ? {
            executionOrder: request.execution.executionOrder,
            success: request.execution.success,
            timing: request.execution.timing ? { ...request.execution.timing } : undefined,
          }
          : undefined;
      }
    },
  };
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
