import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  closeIsolatedPairTabs,
  isWithinIsolatedPairRoot,
  tabInputUris,
} from '../src/vscode/sessionTabs';

const fileUri = (fsPath: string) => ({ scheme: 'file', fsPath });
const otherUri = (fsPath: string) => ({ scheme: 'untitled', fsPath });

describe('isolated Pair tab cleanup', () => {
  it('extracts text, notebook and both diff URIs while ignoring unrelated shapes', () => {
    const root = path.join(os.tmpdir(), 'pair-tabs');
    assert.deepEqual(tabInputUris({ uri: fileUri(path.join(root, 'a.py')) }).length, 1);
    assert.deepEqual(tabInputUris({ uri: fileUri(path.join(root, 'a.ipynb')) }).length, 1);
    assert.deepEqual(tabInputUris({
      original: fileUri(path.join(root, 'before.py')),
      modified: fileUri(path.join(root, 'after.py')),
    }).length, 2);
    assert.deepEqual(tabInputUris({ value: 'not-a-tab-uri' }), []);
  });

  it('uses strict resolved containment and rejects non-file, sibling-prefix and escape paths', () => {
    const root = path.join(os.tmpdir(), 'pair', 'foo');
    assert.equal(isWithinIsolatedPairRoot(root, fileUri(path.join(root, 'a.py'))), true);
    assert.equal(isWithinIsolatedPairRoot(root, fileUri(path.join(root, 'folder', '..', 'a.ipynb'))), true);
    assert.equal(isWithinIsolatedPairRoot(root, fileUri(path.join(root, '..', 'foo-other', 'a.py'))), false);
    assert.equal(isWithinIsolatedPairRoot(root, fileUri(path.join(root, '..', 'outside.py'))), false);
    assert.equal(isWithinIsolatedPairRoot(root, otherUri(path.join(root, 'virtual.py'))), false);
  });

  it('closes only Pair text/notebook/diff tabs, leaves unrelated tabs/window alone and continues after one close failure', async () => {
    const root = path.join(os.tmpdir(), 'pair-tabs-close');
    const pairText = { input: { uri: fileUri(path.join(root, 'a.py')) } };
    const pairNotebook = { input: { uri: fileUri(path.join(root, 'n.ipynb')) } };
    const pairDiff = { input: {
      original: fileUri(path.join(root, 'old.py')),
      modified: fileUri(path.join(root, 'new.py')),
    } };
    const unrelatedText = { input: { uri: fileUri(path.join(os.tmpdir(), 'workspace', 'a.py')) } };
    const unrelatedNotebook = { input: { uri: fileUri(path.join(os.tmpdir(), 'workspace', 'n.ipynb')) } };
    const siblingPrefix = { input: { uri: fileUri(`${root}-other/sibling.py`) } };
    const closed: unknown[] = [];
    let windowCloseCalls = 0;
    const groups = {
      all: [{ tabs: [pairText, pairNotebook, pairDiff, unrelatedText, unrelatedNotebook, siblingPrefix] }],
      close: async (tab: unknown) => {
        closed.push(tab);
        if (tab === pairNotebook) throw new Error('synthetic one-tab close failure');
        return true;
      },
      closeWindow: () => { windowCloseCalls += 1; },
    };
    const result = await closeIsolatedPairTabs(groups, root);
    assert.equal(result.matched, 3);
    assert.equal(result.closed, 2);
    assert.equal(result.failed, 1);
    assert.deepEqual(closed, [pairText, pairNotebook, pairDiff]);
    assert.equal(closed.includes(unrelatedText), false);
    assert.equal(closed.includes(unrelatedNotebook), false);
    assert.equal(closed.includes(siblingPrefix), false);
    assert.equal(windowCloseCalls, 0, 'tab cleanup must never close the VS Code window');
  });

  it('gracefully handles a VS Code build without tabGroups', async () => {
    assert.deepEqual(await closeIsolatedPairTabs(undefined, '/pair/root'), {
      matched: 0, closed: 0, failed: 0, errors: [],
    });
  });
});
