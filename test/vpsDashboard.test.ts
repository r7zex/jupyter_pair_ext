import assert from 'node:assert/strict';
import { vpsDashboardState } from '../src/vscode/vpsDashboard';
import type { PersistentSessionView } from '../src/vps/persistentProtocol';

describe('VPS dashboard state', () => {
  const view: PersistentSessionView = { id: 'session', name: 'Research', state: 'running', ownerId: 'alice', memberId: 'alice',
    allowMemberSwitch: false, members: [{ id: 'alice', name: 'Alice', role: 'owner', online: true }, { id: 'bob', name: 'Bob', role: 'member', online: true }],
    devices: [], target: { deviceId: 'vps' }, generation: 1, consents: [], revision: 0,
    host: { cpu: 'VPS CPU', memoryTotalBytes: 1024 ** 3, memoryFreeBytes: 512 * 1024 ** 2, diskTotalBytes: 20 * 1024 ** 3, diskFreeBytes: 8 * 1024 ** 3 } };
  it('represents a live server host and a separate authenticated owner with real capacity', () => {
    const state = vpsDashboardState(view, Date.now());
    assert.equal(state.live, true);
    assert.equal(state.hostName, 'VPS');
    assert.equal(state.participants?.[0]?.role, 'ВЛАДЕЛЕЦ VPS');
    assert.equal(state.participants?.[1]?.role, 'УЧАСТНИК');
    assert.match(state.hostDetails!, /RAM: 0.5 GiB \/ 1.0 GiB/);
    assert.match(state.hostDetails!, /Диск: 8.0 GiB \/ 20.0 GiB/);
  });
  it('retains the session during network recovery and never grants owner controls by display name', () => {
    const state = vpsDashboardState({ ...view, memberId: 'bob', mode: 'temporary' }, Date.now(), true);
    assert.equal(state.live, true);
    assert.equal(state.isHost, false);
    assert.equal(state.runtimeState, 'reconnecting');
    assert.equal(state.mode, 'Временная VPS-сессия');
  });
});
