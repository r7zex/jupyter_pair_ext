import assert from 'node:assert/strict';
import { presentAcceptedRun } from '../src/vscode/acceptedRun';

describe('accepted run presentation', () => {
  it('distinguishes cells, actual states and project paths without displaying request UUIDs', () => {
    const reference = { notebook: 'data/test.ipynb', requestId: 'technical-only', projectName: 'Experiment', createdAt: Date.UTC(2026, 9, 18, 8) };
    const item = presentAcceptedRun(reference, { id: 'technical-id', notebook: reference.notebook, cellIndex: 2, requesterId: 'member', deviceId: 'vps', generation: 1, state: 'running', scope: 'private', events: [] });
    assert.equal(item.label, 'test.ipynb · Cell 3 · Running');
    assert.match(item.description, /VPS · Private/);
    assert.match(item.detail, /Experiment \/ data\/test.ipynb/);
    assert.match(item.detail, /will not run again/);
    assert.ok(!JSON.stringify(item).includes('technical-'));
  });
});
