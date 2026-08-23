import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {
  SharedCursorPosition,
  createSharedCursorPosition,
  resolveRelativeOffset,
  resolveSharedCursorPosition,
} from '../src/core/cursorPosition';

describe('Yjs relative cursor positions', () => {
  it('keeps a cursor anchored when another peer inserts earlier on the same line', () => {
    const left = new Y.Doc();
    const right = new Y.Doc();
    const leftText = left.getText('content');
    leftText.insert(0, 'abc');
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    const rightText = right.getText('content');
    const cursor = createSharedCursorPosition(rightText, 2, 2);

    leftText.insert(0, 'X');

    assert.deepEqual(resolveSharedCursorPosition(leftText, cursor), { anchor: 3, active: 3 });
    assert.equal(cursor.anchor, 2, 'the absolute compatibility offset remains unchanged');
  });

  it('resolves identically after concurrent inserts in either replica', () => {
    const left = new Y.Doc();
    const right = new Y.Doc();
    const leftText = left.getText('content');
    leftText.insert(0, 'abcd');
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    const rightText = right.getText('content');

    rightText.insert(2, 'R');
    const cursor = createSharedCursorPosition(rightText, 3, 3);
    leftText.insert(2, 'L');
    const leftUpdate = Y.encodeStateAsUpdate(left);
    const rightUpdate = Y.encodeStateAsUpdate(right);
    Y.applyUpdate(left, rightUpdate);
    Y.applyUpdate(right, leftUpdate);

    assert.equal(leftText.toString(), rightText.toString());
    assert.deepEqual(
      resolveSharedCursorPosition(leftText, cursor),
      resolveSharedCursorPosition(rightText, cursor),
    );
  });

  it('works for a Y.Text nested inside notebook cell data', () => {
    const left = new Y.Doc();
    const leftCell = new Y.Map<unknown>();
    const leftSource = new Y.Text('value = 1');
    leftCell.set('source', leftSource);
    left.getMap<Y.Map<unknown>>('cellData').set('cell-a', leftCell);
    const right = new Y.Doc();
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    const rightSource = right.getMap<Y.Map<unknown>>('cellData').get('cell-a')?.get('source');
    assert.ok(rightSource instanceof Y.Text);
    const cursor = createSharedCursorPosition(rightSource, 5, 5);

    leftSource.insert(0, '# ');

    assert.deepEqual(resolveSharedCursorPosition(leftSource, cursor), { anchor: 7, active: 7 });
  });

  it('accepts legacy offsets and safely rejects malformed relative data', () => {
    const doc = new Y.Doc();
    const text = doc.getText('content');
    text.insert(0, 'abc');
    assert.deepEqual(resolveSharedCursorPosition(text, { anchor: 1, active: 2 }), { anchor: 1, active: 2 });
    assert.equal(resolveRelativeOffset(text, 'not base64', 2), 2);
    assert.equal(resolveRelativeOffset(text, 'A'.repeat(2048), 99), 3, 'fallback is clamped to the text');
    assert.equal(resolveSharedCursorPosition(text, { anchor: Number.NaN, active: 1 }), undefined);
    assert.equal(resolveSharedCursorPosition(undefined, {
      anchor: 'bad', active: 1,
    } as unknown as SharedCursorPosition), undefined);
  });
});
