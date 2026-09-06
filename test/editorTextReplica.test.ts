import assert from 'node:assert/strict';
import { CollaborativeProject } from '../src/core/crdt';
import { EditorTextReplica } from '../src/vscode/editorTextReplica';

describe('displayed text replica sharing', () => {
  it('loads a rich notebook once and shares source-only versions across its cells', () => {
    const canonical = new CollaborativeProject();
    const replicas: EditorTextReplica[] = [];
    canonical.ensureNotebook('work.ipynb', { metadata: {}, cells: Array.from({ length: 100 }, (_, index) => ({
      id: `cell-${index}`, kind: 2, language: 'python', source: `value_${index}`, metadata: {},
      outputs: index ? [] : [{ metadata: {}, items: [{ mime: 'text/plain', dataBase64: Buffer.alloc(1024 * 1024, 65).toString('base64') }] }],
    })) });
    let encodes = 0;
    const encode = canonical.encodeUpdate.bind(canonical);
    canonical.encodeUpdate = (...args) => { encodes += 1; return encode(...args); };
    try {
      for (let index = 0; index < 100; index += 1) replicas.push(new EditorTextReplica(canonical, 'work.ipynb', `cell-${index}`));
      assert.equal(encodes, 1, 'opening N cells must not encode the full notebook N times');
      assert.equal(new Set(replicas.map((replica) => replica.project)).size, 1);
      assert.ok(replicas[0]!.project.encodeUpdate('work.ipynb').byteLength < 50_000, 'rich outputs are absent from shared displayed state');
      canonical.applyCellTextChanges('work.ipynb', 'cell-0', [{ offset: 0, deleteCount: 0, insertText: 'R' }]);
      const rendered = new EditorTextReplica(canonical, 'work.ipynb', 'cell-0');
      replicas.push(rendered);
      assert.equal(encodes, 1, 'subsequent versions use incremental source-only state');
      assert.equal(rendered.source(), 'Rvalue_0');
      replicas[0]!.edit([{ offset: 7, deleteCount: 0, insertText: 'L' }]);
      assert.equal(canonical.cellSource('work.ipynb', 'cell-0').toString(), 'Rvalue_0L');
      assert.equal(canonical.cellSource('work.ipynb', 'cell-1').toString(), 'value_1');
      assert.equal(canonical.notebookCellSnapshot('work.ipynb', 'cell-0')?.outputs.length, 1);
    } finally {
      for (const replica of replicas) replica.dispose();
      canonical.destroy();
    }
  });
});


describe('incremental displayed replica reuse', () => {
  it('uses bounded incremental encodings after warmup while keeping old displayed text intact', () => {
    const canonical = new CollaborativeProject();
    canonical.ensureNotebook('work.ipynb', { metadata: {}, cells: Array.from({ length: 100 }, (_, index) => ({
      id: 'c'+index, kind: 2, language: 'python', source: 'x'.repeat(1000), metadata: {}, outputs: [],
    })) });
    const replicas: EditorTextReplica[] = [];
    const encode = CollaborativeProject.prototype.encodeUpdate;
    let fullEncodes = 0;
    const incrementalSizes: number[] = [];
    CollaborativeProject.prototype.encodeUpdate = function (key, vector) {
      const value = encode.call(this, key, vector);
      if (vector) incrementalSizes.push(value.length); else fullEncodes += 1;
      return value;
    };
    try {
      for (let index = 0; index < 100; index += 1) replicas.push(new EditorTextReplica(canonical, 'work.ipynb', 'c'+index));
      for (let iteration = 0; iteration < 20; iteration += 1) {
        const previous = replicas[0]!;
        const displayed = previous.source();
        canonical.applyCellTextChanges('work.ipynb', 'c0', [{ offset: 0, deleteCount: 0, insertText: 'r' }]);
        const next = new EditorTextReplica(canonical, 'work.ipynb', 'c0');
        assert.equal(previous.source(), displayed, 'pending editor must retain its actual baseline');
        assert.equal(next.source(), 'r'+displayed);
        replicas[0] = next;
        previous.dispose();
      }
      assert.ok(fullEncodes <= 3, 'warmup may create two displayed versions, not one full clone per keystroke');
      assert.equal(incrementalSizes.length, 19);
      assert.ok(incrementalSizes.every((bytes) => bytes < 10_000), 'one-letter edits must not re-encode 100 KB of cell sources');
      assert.equal(replicas[99]!.source(), 'x'.repeat(1000));
    } finally {
      CollaborativeProject.prototype.encodeUpdate = encode;
      for (const replica of replicas) replica.dispose();
      assert.equal(canonical.listenerCount('update'), 0);
      canonical.destroy();
    }
  });

  it('never recycles edits rejected by canonical validation', () => {
    const canonical = new CollaborativeProject();
    canonical.ensureText('work.py', 'abc');
    let displayed = new EditorTextReplica(canonical, 'work.py');
    const merge = canonical.mergeEditorText;
    try {
      canonical.applyTextChanges('work.py', [{ offset: 0, deleteCount: 0, insertText: 'R' }]);
      canonical.mergeEditorText = () => { throw new Error('simulated merged-size rejection'); };
      assert.throws(() => displayed.edit([{ offset: 3, deleteCount: 0, insertText: 'REJECTED' }]), /merged-size/);
      canonical.mergeEditorText = merge;
      const restored = new EditorTextReplica(canonical, 'work.py');
      displayed.dispose(); displayed = restored;
      for (let iteration = 0; iteration < 4; iteration += 1) {
        canonical.applyTextChanges('work.py', [{ offset: 0, deleteCount: 0, insertText: 'X' }]);
        const next = new EditorTextReplica(canonical, 'work.py');
        displayed.dispose(); displayed = next;
        assert.equal(displayed.source(), canonical.text('work.py').toString());
        assert.ok(!displayed.source().includes('REJECTED'));
      }
    } finally { canonical.mergeEditorText = merge; displayed.dispose(); canonical.destroy(); }
  });
});


describe('reusable replica lifecycle', () => {
  it('renames the spare together with the displayed version', () => {
    const canonical = new CollaborativeProject();
    canonical.ensureText('old.py', 'abc');
    let replica = new EditorTextReplica(canonical, 'old.py');
    try {
      canonical.applyTextChanges('old.py', [{ offset: 0, deleteCount: 0, insertText: 'R' }]);
      const next = new EditorTextReplica(canonical, 'old.py');
      replica.dispose(); replica = next;
      canonical.renameDocument('old.py', 'new.py');
      replica.rename('new.py');
      canonical.applyTextChanges('new.py', [{ offset: 0, deleteCount: 0, insertText: 'X' }]);
      const renamed = new EditorTextReplica(canonical, 'new.py');
      replica.dispose(); replica = renamed;
      assert.equal(replica.source(), 'XRabc');
      assert.deepEqual(replica.project.keys(), ['new.py']);
    } finally { replica.dispose(); canonical.destroy(); }
  });

  it('preserves independent lagging cell edits across several retained versions', () => {
    const canonical = new CollaborativeProject();
    canonical.ensureNotebook('work.ipynb', { metadata: {}, cells: ['a', 'b'].map((id) => ({
      id, kind: 2, language: 'python', source: id, metadata: {}, outputs: [],
    })) });
    const a = new EditorTextReplica(canonical, 'work.ipynb', 'a');
    const b = new EditorTextReplica(canonical, 'work.ipynb', 'b');
    const replicas = [a, b];
    try {
      canonical.applyCellTextChanges('work.ipynb', 'a', [{ offset: 0, deleteCount: 0, insertText: 'R' }]);
      replicas.push(new EditorTextReplica(canonical, 'work.ipynb', 'a'));
      canonical.applyCellTextChanges('work.ipynb', 'b', [{ offset: 0, deleteCount: 0, insertText: 'S' }]);
      replicas.push(new EditorTextReplica(canonical, 'work.ipynb', 'b'));
      assert.equal(a.source(), 'a');
      assert.equal(b.source(), 'b');
      a.edit([{ offset: 1, deleteCount: 0, insertText: 'L' }]);
      b.edit([{ offset: 1, deleteCount: 0, insertText: 'M' }]);
      assert.equal(canonical.cellSource('work.ipynb', 'a').toString(), 'RaL');
      assert.equal(canonical.cellSource('work.ipynb', 'b').toString(), 'SbM');
    } finally { for (const replica of replicas) replica.dispose(); canonical.destroy(); }
  });
});
