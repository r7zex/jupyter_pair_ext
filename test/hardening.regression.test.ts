import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { CollaborativeProject, NotebookSnapshot } from '../src/core/crdt';
import { StorageAdapter } from '../src/core/persistence';

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function notebook(ids: string[]): NotebookSnapshot {
  return {
    metadata: {},
    cells: ids.map((id) => ({ id, kind: 2, language: 'python', source: `# ${id}`, metadata: {}, outputs: [] })),
  };
}

describe('notebook cell state is never collected behind an absent peer', () => {
  const key = 'notebook.ipynb';

  it('refuses collection while a participant is absent and restarts the grace window', () => {
    const project = new CollaborativeProject();
    project.reconcileNotebook(key, notebook(['A', 'B', 'C']));
    const data = project.ensureNotebook(key).getMap<Y.Map<unknown>>('cellData');
    project.reconcileNotebook(key, notebook(['A', 'C']));
    assert.equal(data.has('B'), true);

    // A peer is offline: no amount of waiting may drop the payload, because the
    // returning peer could still be editing that cell.
    let present = false;
    project.collectionGuard = () => present;
    const start = 1_000_000;
    assert.deepEqual(project.collectGarbage(key, 30_000, start), []);
    assert.deepEqual(project.collectGarbage(key, 30_000, start + 10 * 60_000), []);
    assert.equal(data.has('B'), true, 'payload survives while a peer is absent');

    // Once everybody is present the grace window starts from scratch.
    present = true;
    assert.deepEqual(project.collectGarbage(key, 30_000, start + 10 * 60_000), [], 'first pass only marks');
    assert.deepEqual(project.collectGarbage(key, 30_000, start + 10 * 60_000 + 31_000), ['B']);
    assert.equal(data.has('B'), false);
  });

  it('removes an order entry that points at already collected cell state', () => {
    const project = new CollaborativeProject();
    project.reconcileNotebook(key, notebook(['A', 'B', 'C']));
    project.reconcileNotebook(key, notebook(['A', 'C']));
    const start = 2_000_000;
    project.collectGarbage(key, 30_000, start);
    assert.deepEqual(project.collectGarbage(key, 30_000, start + 31_000), ['B']);

    // A returning peer re-references the collected id; its payload no longer
    // exists anywhere, so the visible order must not keep a phantom cell.
    const doc = project.ensureNotebook(key);
    doc.transact(() => doc.getArray<string>('cells').insert(0, ['B']));
    assert.deepEqual(project.repairCollectedResurrections(key), ['B']);
    assert.deepEqual(doc.getArray<string>('cells').toArray(), ['A', 'C']);
    assert.deepEqual(project.notebookSnapshot(key).cells.map((cell) => cell.id), ['A', 'C']);
  });

  it('retains collected-cell repair state when a notebook is renamed', () => {
    const project = new CollaborativeProject();
    const renamedKey = 'renamed.ipynb';
    project.reconcileNotebook(key, notebook(['A', 'B']));
    project.reconcileNotebook(key, notebook(['A']));
    const start = 3_000_000;
    project.collectGarbage(key, 30_000, start);
    assert.deepEqual(project.collectGarbage(key, 30_000, start + 31_000), ['B']);

    project.renameDocument(key, renamedKey);
    const doc = project.ensureNotebook(renamedKey);
    doc.transact(() => doc.getArray<string>('cells').insert(0, ['B']));

    assert.deepEqual(project.repairCollectedResurrections(renamedKey), ['B']);
    assert.deepEqual(doc.getArray<string>('cells').toArray(), ['A']);
    project.destroy();
  });
});

describe('persistence recovers from a transient failure', () => {
  it('retries the unwritten path on the next flush and reports the failure once', async () => {
    const workingRoot = await temporaryDirectory('pn-retry-');
    const adapter = new StorageAdapter({
      workingRoot,
      // Long debounce: this test drives the flushes explicitly.
      debounceMs: 60_000,
      serialize: async () => {
        if (broken) throw new Error('transient disk failure');
        return Buffer.from('recovered\n', 'utf8');
      },
    });
    let broken = true;
    const errors: unknown[] = [];
    adapter.on('operationError', (error) => errors.push(error));
    try {
      adapter.schedule('notes.txt');
      await assert.rejects(adapter.flush(), /transient disk failure/);
      assert.equal(errors.length, 1, 'a single failure is reported exactly once');
      assert.equal(adapter.pendingCount(), 1, 'the unwritten path is retried later');

      broken = false;
      await adapter.flush();
      assert.equal(await readFile(path.join(workingRoot, 'notes.txt'), 'utf8'), 'recovered\n');
      assert.equal(adapter.pendingCount(), 0);
      assert.equal(errors.length, 1);
    } finally {
      await adapter.stop(false);
      await rm(workingRoot, { recursive: true, force: true });
    }
  });
});
