import assert from 'node:assert/strict';
import { rebaseInitialTextChanges } from '../src/vscode/initialTextChanges';

describe('initial editor text rebasing', () => {
  const apply = (before: string, target: string, changes: Parameters<typeof rebaseInitialTextChanges>[2]): string => {
    let result = target;
    for (const change of rebaseInitialTextChanges(before, target, changes).reverse()) {
      result = result.slice(0, change.offset) + change.insertText + result.slice(change.offset + change.deleteCount);
    }
    return result;
  };
  it('preserves remote insertions inside a local deletion', () => {
    assert.equal(apply('abcdef', 'abREMOTEcdef', [{ offset: 1, deleteCount: 4, insertText: '' }]), 'aREMOTEf');
  });
  it('keeps separate remote edits around local typing', () => {
    assert.equal(apply('one two three', '#one two three!', [{ offset: 5, deleteCount: 0, insertText: 'X' }]), '#one tXwo three!');
  });
  it('does not delete replacement content that was never displayed', () => {
    assert.equal(apply('old', 'NEW', [{ offset: 0, deleteCount: 3, insertText: 'typed' }]), 'NEWtyped');
  });
  it('keeps multi-cursor insertions and UTF-16 newline positions', () => {
    assert.equal(apply('a\ud83d\ude00\nb', '#a\ud83d\ude00\nb!', [
      { offset: 1, deleteCount: 0, insertText: 'X' }, { offset: 4, deleteCount: 0, insertText: 'Y' },
    ]), '#aX\ud83d\ude00\nYb!');
  });
});
