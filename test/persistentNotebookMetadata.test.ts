import assert from 'node:assert/strict';
import { cellUserMetadata, hasLegacyNotebookMetadata, nativeNotebookMetadata, notebookUserMetadata, renderedCellMetadata, renderedNotebookMetadata } from '../src/vscode/persistentNotebookMetadata';
import { parseIpynb, serializeIpynb } from '../src/core/projectFiles';

describe('Persistent notebook serializer metadata', () => {
  for (const source of ['first\r\nsecond\r\n', 'first\r\n\r\nlast', 'first\r\nsecond\nthird\rfourth']) it(`preserves every character of notebook source with Windows line endings ${JSON.stringify(source)}`, () => {
    const snapshot = parseIpynb(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ id: 'stable', cell_type: 'code', source, metadata: {}, outputs: [], execution_count: null }] }));
    const saved = JSON.parse(Buffer.from(serializeIpynb(snapshot)).toString('utf8'));
    assert.equal(saved.cells[0].source.join(''), source);
  });
  const user = { kernelspec: { name: 'python3' }, project: 'retained' };
  const cell = { id: 'stable-cell', cell_type: 'code', source: 'x = 42', metadata: { tags: ['retained'] } };
  it('extracts only user metadata from the native ipynb envelope', () => {
    const native = { nbformat: 4, nbformat_minor: 5, metadata: { ...user, pair_crdt: { epoch: 'epoch', update: 'state' } }, cells: [cell], indentAmount: ' ' };
    assert.equal(nativeNotebookMetadata(native), true);
    assert.deepEqual(notebookUserMetadata(native), user);
    assert.deepEqual(cellUserMetadata({ id: cell.id, metadata: cell.metadata }, true), cell.metadata);
  });
  it('retains the older Jupyter custom layout and plain metadata', () => {
    assert.deepEqual(notebookUserMetadata({ custom: { metadata: user } }), user);
    assert.deepEqual(notebookUserMetadata(user), user);
    assert.deepEqual(cellUserMetadata({ custom: { metadata: cell.metadata } }, false), cell.metadata);
    assert.deepEqual(cellUserMetadata(cell.metadata, false), cell.metadata);
  });
  it('removes only legacy serialized notebook copies carrying reserved CRDT state', () => {
    let nested: Record<string, unknown> = user;
    for (let index = 0; index < 8; index++) nested = { nbformat: 4, nbformat_minor: 5, cells: [cell], metadata: { ...nested, pair_crdt: { epoch: 'epoch', update: 'state' } }, indentAmount: ' ' };
    assert.equal(hasLegacyNotebookMetadata(nested), true);
    assert.deepEqual(notebookUserMetadata({ custom: { metadata: nested } }), user);
    const reference = { nbformat: 4, cells: [cell], metadata: user };
    assert.deepEqual(notebookUserMetadata({ custom: { metadata: reference } }), reference);
  });
  it('renders native metadata without embedding transient cell snapshots', () => {
    const original = { nbformat: 4, nbformat_minor: 5, cells: [cell], metadata: user, indentAmount: '  ' };
    const rendered = renderedNotebookMetadata(original, user);
    assert.deepEqual(rendered.cells, []);
    assert.deepEqual(notebookUserMetadata(rendered), user);
    assert.deepEqual(renderedCellMetadata({ id: cell.id, metadata: {} }, cell, true), { id: cell.id, metadata: cell.metadata });
    assert.deepEqual(cellUserMetadata(renderedCellMetadata({}, cell, false), false), cell.metadata);
  });
});
