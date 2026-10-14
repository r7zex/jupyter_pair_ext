import assert from 'node:assert/strict';
import { lineLockMessage } from '../src/core/lineLock';
import type { PresenceState } from '../src/runtime/session';

describe('Shared host selected-line policy', () => {
  const state = (id: string, joinOrder: number, offset: number): PresenceState => ({ peer: { peerId: id, displayName: id, joinOrder }, activeFile: 'book.ipynb', activeNotebookCellId: 'cell', activeLine: offset, shareCursor: true, cursorColor: '#4FC3F7', kernelStatus: 'Idle' });
  const check = (states: PresenceState[], offset: number, length = 0): string | undefined => lineLockMessage(states, 'local', 'book.ipynb', 'cell', [{ rangeOffset: offset, rangeLength: length }], 'one\ntwo', (presence) => presence.activeLine);
  it('blocks the occupied row and its newline without blocking the next row', () => {
    const states = [state('remote', 0, 0)]; assert.ok(check(states, 0)); assert.ok(check(states, 3)); assert.equal(check(states, 4), undefined); assert.ok(check(states, 3, 2));
  });
  it('uses the original stable participant priority when both select the same row', () => {
    assert.equal(check([state('local', 0, 0), state('remote', 1, 0)], 1), undefined);
    assert.ok(check([state('local', 1, 0), state('remote', 0, 0)], 1));
  });
  it('blocks deleting the preceding newline that would merge an occupied row', () => {
    assert.ok(check([state('remote', 0, 4)], 3, 1));
    assert.equal(check([state('remote', 0, 4)], 3), undefined);
  });
  it('does not block a different cell or an unresolved stale position', () => {
    const remote = state('remote', 0, 0); remote.activeNotebookCellId = 'other'; assert.equal(check([remote], 0), undefined);
    remote.activeNotebookCellId = 'cell'; assert.equal(lineLockMessage([remote], 'local', 'book.ipynb', 'cell', [{ rangeOffset: 0, rangeLength: 0 }], 'one', () => undefined), undefined);
  });
});
