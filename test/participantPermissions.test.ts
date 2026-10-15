import assert from 'node:assert/strict';
import { defaultPermissions, mayChangeTree, mayEdit, normalizePermissions } from '../src/core/permissions';
import { normalizeCommentInput, participantColor } from '../src/core/lineComments';

describe('participant authority policy', () => {
  it('matches exact files and explicit subtrees without prefix or traversal escapes', () => {
    const policy = normalizePermissions({ ...defaultPermissions(), edit: 'selected', paths: ['src/a.py', 'notes/'] });
    assert.equal(mayEdit(policy, 'src/a.py'), true);
    assert.equal(mayEdit(policy, 'src/a.py.bak'), false);
    assert.equal(mayEdit(policy, 'notes/deep/a.md'), true);
    assert.equal(mayEdit(policy, 'notes-secret/a.md'), false);
    assert.equal(mayEdit(policy, 'notes/../private.py'), false);
    assert.throws(() => normalizePermissions({ ...policy, paths: ['../secret'] }));
    assert.throws(() => normalizePermissions({ ...policy, execute: 'true' }));
    assert.equal(mayChangeTree(policy, 'src', ['src/a.py', 'src/private.py']), false);
    assert.equal(mayChangeTree(policy, 'notes', ['notes/a.md'], 'private'), false);
    assert.equal(mayChangeTree(policy, 'notes', ['notes/a.md'], 'notes/moved'), true);
  });
  it('validates comment content and generates a stable per-participant color', () => {
    const input = { path: 'main.py', startLine: 2, endLine: 4, text: '  Check this  ', color: 'red;display:none' };
    assert.equal(normalizeCommentInput(input).text, 'Check this');
    assert.equal(normalizeCommentInput(input).color, '#4FC3F7');
    assert.throws(() => normalizeCommentInput({ ...input, startLine: -1 }));
    assert.throws(() => normalizeCommentInput({ ...input, text: 'x'.repeat(4001) }));
    assert.equal(participantColor('alice'), participantColor('alice'));
    assert.notEqual(participantColor('alice'), participantColor('bob'));
  });
});
