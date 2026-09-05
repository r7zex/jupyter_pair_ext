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
