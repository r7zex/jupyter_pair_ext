import assert from 'node:assert/strict';
import { describe, it } from 'mocha';

import { statusBarTextForRuntimeState } from '../src/vscode/connectionProgress';

describe('connection progress status', () => {
  it('shows a spinner while the initial transport is connecting', () => {
    assert.equal(statusBarTextForRuntimeState('connecting'), '$(sync~spin) Pair: connecting');
  });

  it('keeps reconnecting and syncing states visible', () => {
    assert.equal(statusBarTextForRuntimeState('reconnecting'), '$(sync~spin) Pair: reconnecting');
    assert.equal(statusBarTextForRuntimeState('syncing'), '$(sync~spin) Pair: syncing');
    assert.equal(statusBarTextForRuntimeState('ready'), undefined);
  });
});
