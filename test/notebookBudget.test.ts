import assert from 'node:assert/strict';
import { CollaborativeProject } from '../src/core/crdt';
import { encodeFrame } from '../src/core/wire';

describe('aggregate notebook state budget', () => {
  it('rejects the output that would break joining and releases capacity after clearing outputs', () => {
    const host = new CollaborativeProject();
    const guest = new CollaborativeProject();
    const output = [{ metadata: {}, items: [{ mime: 'text/plain', dataBase64: Buffer.alloc(10 * 1024 * 1024, 65).toString('base64') }] }];
    host.ensureNotebook('work.ipynb', { metadata: {}, cells: Array.from({ length: 5 }, (_, index) => ({
      id: `cell-${index}`, kind: 2, language: 'python', source: 'pass', metadata: {}, outputs: [],
    })) });
    try {
      for (let index = 0; index < 3; index += 1) host.setCellOutputs('work.ipynb', `cell-${index}`, output);
      assert.throws(() => host.setCellOutputs('work.ipynb', 'cell-3', output), /collaborative-state limit/);
      assert.equal(host.notebookCellSnapshot('work.ipynb', 'cell-3')!.outputs.length, 0);
      const update = host.encodeUpdate('work.ipynb');
      assert.doesNotThrow(() => encodeFrame('stateDocument', { key: 'work.ipynb', kind: 'notebook' }, update));
      guest.applyRemoteUpdate('work.ipynb', 'notebook', update);
      assert.equal(guest.notebookSnapshot('work.ipynb').cells.filter((cell) => cell.outputs.length).length, 3);
      host.setCellOutputs('work.ipynb', 'cell-0', []);
      host.setCellOutputs('work.ipynb', 'cell-3', output);
      const current = host.notebookSnapshot('work.ipynb');
      host.reconcileNotebook('work.ipynb', { ...current, cells: current.cells.filter((cell) => cell.id !== 'cell-1') });
      assert.throws(() => host.setCellOutputs('work.ipynb', 'cell-4', output), /collaborative-state limit/,
        'retained deleted cells still consume wire-state capacity');
    } finally { host.destroy(); guest.destroy(); }
  });

  it('applies the same aggregate limit to incremental cell source edits', () => {
    const project = new CollaborativeProject();
    project.ensureNotebook('work.ipynb', { metadata: {}, cells: ['a', 'b'].map((id) => ({
      id, kind: 2, language: 'python', source: '', metadata: {}, outputs: [],
    })) });
    try {
      const change = [{ offset: 0, deleteCount: 0, insertText: 'x'.repeat(25 * 1024 * 1024) }];
      project.applyCellTextChanges('work.ipynb', 'a', change);
      assert.throws(() => project.applyCellTextChanges('work.ipynb', 'b', change), /collaborative-state limit/);
      assert.equal(project.cellSource('work.ipynb', 'b').length, 0);
    } finally { project.destroy(); }
  });
});
