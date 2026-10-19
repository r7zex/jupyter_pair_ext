import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import { PersistentComputePolicy, type PersistentDeviceInput } from '../src/vps/persistentCompute';
import type { PersistentMember } from '../src/vps/persistentProtocol';
import { AGENT_ONLINE_MS } from '../src/vps/protocol';

const GPU_ONE = 'GPU-11111111-1111-1111-1111-111111111111';
const GPU_TWO = 'GPU-22222222-2222-2222-2222-222222222222';
const device = (id: string): PersistentDeviceInput => ({ id, name: id, python: '/usr/bin/python3', cpu: '8 cores',
  gpus: [{ uuid: GPU_ONE, name: 'NVIDIA GPU', memoryMb: 16384 }, { uuid: GPU_TWO, name: 'NVIDIA GPU 2', memoryMb: 8192 }],
  isolation: 'dedicated account' });
const member = (id: string, online: boolean, role: PersistentMember['role'] = 'member'): PersistentMember =>
  ({ id, online, role, name: id });

function setup(online: string[] = ['owner', 'alice', 'bob']): {
  policy: PersistentComputePolicy;
  presence: (ids: string[]) => void;
  advance: (milliseconds: number) => void;
} {
  let now = 1000;
  const policy = new PersistentComputePolicy('session-one', 'owner', undefined, () => now);
  const presence = (ids: string[]): void => policy.setMembers([member('owner', ids.includes('owner'), 'owner'),
    member('alice', ids.includes('alice')), member('bob', ids.includes('bob'), 'admin')]);
  presence(online);
  policy.registerVps({ ...device('vps'), gpus: [] });
  for (const id of ['owner', 'alice', 'bob']) {
    policy.registerDevice(id, device(`${id}-pc`));
    policy.share(id, `${id}-pc`, true);
  }
  presence([...new Set([...online, 'owner'])]);
  policy.select('owner', { deviceId: 'vps' });
  presence(online);
  return { policy, presence, advance: (milliseconds) => { now += milliseconds; } };
}

describe('persistent session compute authorization', () => {
  it('grants execution on the owner-selected machine without granting member switching', () => {
    const { policy } = setup();
    const target = { deviceId: 'owner-pc', gpuUuid: GPU_ONE };
    policy.select('owner', target);
    const generation = policy.view().generation;
    assert.throws(() => policy.executionTarget('alice'), /consent/);
    const requested = policy.select('alice', target);
    assert.equal(requested.consent?.status, 'pending');
    assert.equal(policy.view().generation, generation);
    assert.throws(() => policy.select('alice', { deviceId: 'owner-pc', gpuUuid: GPU_TWO }), /disabled member/);
    policy.decideConsent('owner', requested.consent!.id, true);
    assert.deepEqual(policy.executionTarget('alice').target, target);
    assert.equal(policy.view().generation, generation);
    assert.deepEqual(policy.view().ownerBaseline, target);
    policy.revokeConsent('owner', requested.consent!.id);
    assert.throws(() => policy.executionTarget('alice'), /consent/);
    assert.deepEqual(policy.executionTarget('owner').target, target);
  });

  it('does not switch back when a current-device execution consent is approved after owner selection changes', () => {
    const { policy } = setup();
    policy.select('owner', { deviceId: 'owner-pc' });
    const requested = policy.select('alice', { deviceId: 'owner-pc' });
    policy.select('owner', { deviceId: 'vps' });
    policy.decideConsent('owner', requested.consent!.id, true);
    assert.deepEqual(policy.view().target, { deviceId: 'vps' });
    assert.throws(() => policy.select('alice', { deviceId: 'owner-pc' }), /disabled member/);
  });

  it('defaults to the VPS CPU and counts only connected human members', () => {
    const { policy, presence } = setup([]);
    assert.deepEqual(policy.view().target, { deviceId: 'vps' });
    assert.deepEqual(policy.view().devices.find((entry) => entry.id === 'vps')!.gpus, []);
    presence(['alice']);
    assert.deepEqual(policy.select('alice', { deviceId: 'alice-pc', gpuUuid: GPU_ONE }).target,
      { deviceId: 'alice-pc', gpuUuid: GPU_ONE });
    assert.throws(() => policy.setMembers([member('vps', true)]), /human member/);
  });

  it('allows absent-owner members to select the VPS or their own explicitly shared computer', () => {
    const { policy } = setup(['alice']);
    policy.share('alice', 'alice-pc', false);
    assert.throws(() => policy.select('alice', { deviceId: 'alice-pc' }), /your own/);
    policy.share('alice', 'alice-pc', true);
    policy.select('alice', { deviceId: 'alice-pc' });
    assert.throws(() => policy.select('alice', { deviceId: 'bob-pc' }), /your own/);
    policy.select('alice', { deviceId: 'vps' });
    assert.deepEqual(policy.view().target, { deviceId: 'vps' });
  });

  it('retains the selected member computer with multiple participants until the owner returns', () => {
    const { policy, presence } = setup(['alice']);
    policy.select('alice', { deviceId: 'alice-pc', gpuUuid: GPU_ONE });
    const accepted = policy.executionTarget('alice');
    presence(['alice', 'bob']);
    assert.deepEqual(policy.executionTarget('alice').target, accepted.target);
    assert.equal(policy.view().generation, accepted.generation);
    assert.throws(() => policy.select('bob', { deviceId: 'alice-pc', gpuUuid: GPU_TWO }), /your own/);
    policy.select('bob', { deviceId: 'bob-pc' });
    policy.select('alice', accepted.target);
    presence(['owner', 'alice', 'bob']);
    assert.deepEqual(policy.executionTarget('alice').target, { deviceId: 'vps' });
    assert.ok(policy.view().generation > accepted.generation);
    assert.throws(() => policy.assertExecutionTarget('alice', accepted.target, accepted.generation), /expired compute selection/);
    assert.deepEqual(accepted.target, { deviceId: 'alice-pc', gpuUuid: GPU_ONE });
    assert.throws(() => policy.select('alice', accepted.target), /disabled member/);
    presence([]);
    assert.deepEqual(policy.view().target, { deviceId: 'vps' });
    assert.deepEqual(accepted.target, { deviceId: 'alice-pc', gpuUuid: GPU_ONE });
  });

  it('restores the owner baseline when the owner returns', () => {
    const { policy, presence } = setup(['owner', 'bob']);
    const request = policy.select('owner', { deviceId: 'bob-pc' }).consent!;
    policy.decideConsent('bob', request.id, true);
    presence(['alice']);
    policy.select('alice', { deviceId: 'alice-pc' });
    presence(['owner', 'alice', 'bob']);
    assert.deepEqual(policy.view().target, { deviceId: 'bob-pc' });
    assert.deepEqual(policy.view().ownerBaseline, { deviceId: 'bob-pc' });
    assert.throws(() => policy.executionTarget('alice'), /consent/);
  });

  it('defaults to a ready shared owner computer and falls back to VPS when it disconnects', () => {
    const policy = new PersistentComputePolicy('session-auto-owner', 'owner');
    policy.setMembers([member('owner', true, 'owner'), member('alice', true)]);
    policy.registerVps({ ...device('vps'), gpus: [] });
    assert.deepEqual(policy.view().target, { deviceId: 'vps' });
    policy.registerDevice('owner', device('owner-pc'));
    policy.share('owner', 'owner-pc', true);
    assert.deepEqual(policy.view().target, { deviceId: 'owner-pc' });
    policy.setMembers([member('owner', false, 'owner'), member('alice', true)]);
    assert.deepEqual(policy.view().target, { deviceId: 'vps' });
    policy.setMembers([member('owner', true, 'owner'), member('alice', true)]);
    assert.deepEqual(policy.view().target, { deviceId: 'owner-pc' });
    policy.select('owner', { deviceId: 'vps' });
    policy.share('owner', 'owner-pc', true);
    assert.deepEqual(policy.view().target, { deviceId: 'vps' }, 'agent registration must preserve an explicit owner choice');
  });

  it('keeps baseline sharing consent mandatory for the owner and rejects admin permission bypasses', () => {
    const { policy } = setup();
    assert.throws(() => policy.select('bob', { deviceId: 'bob-pc' }), /disabled member/);
    assert.throws(() => policy.setAllowMemberSwitch('bob', true), /session owner/);
    assert.throws(() => policy.share('owner', 'bob-pc', true), /device owner/);
    const pending = policy.select('owner', { deviceId: 'bob-pc' });
    assert.equal(pending.consent!.status, 'pending');
    assert.deepEqual(policy.view().target, { deviceId: 'vps' });
    assert.throws(() => policy.assertExecutionTarget('owner', { deviceId: 'bob-pc' }), /consent/);
    assert.throws(() => policy.decideConsent('owner', pending.consent!.id, true), /device owner/);
  });

  it('assigns registration ownership from membership and never trusts supplied owner or sharing fields', () => {
    const { policy } = setup();
    const registered = policy.registerDevice('alice', { ...device('new-pc'), ownerId: 'owner', enabled: true, online: true });
    assert.equal(registered.ownerId, 'alice');
    assert.equal(registered.enabled, false);
    assert.throws(() => policy.registerDevice('bob', device('new-pc')), /another member/);
    assert.throws(() => policy.registerDevice('alice', device('vps')), /configured agent/);
    assert.throws(() => policy.share('owner', 'new-pc', true), /device owner/);
  });

  it('leaves active selection unchanged while pending and when denied', () => {
    const { policy } = setup();
    policy.select('owner', { deviceId: 'owner-pc' });
    const before = policy.view();
    const pending = policy.select('owner', { deviceId: 'bob-pc', gpuUuid: GPU_ONE }).consent!;
    assert.deepEqual(policy.view().target, before.target);
    assert.equal(policy.view().generation, before.generation);
    policy.decideConsent('bob', pending.id, false);
    assert.deepEqual(policy.view().target, before.target);
    assert.equal(policy.view().generation, before.generation);
  });

  it('binds approvals to the requester, session, device owner and exact GPU', () => {
    const { policy } = setup();
    policy.setAllowMemberSwitch('owner', true);
    const pending = policy.select('alice', { deviceId: 'bob-pc', gpuUuid: GPU_ONE }).consent!;
    assert.equal(pending.sessionId, 'session-one');
    assert.equal(pending.ownerId, 'bob');
    policy.decideConsent('bob', pending.id, true);
    policy.assertExecutionTarget('alice', { deviceId: 'bob-pc', gpuUuid: GPU_ONE });
    assert.throws(() => policy.assertExecutionTarget('owner', { deviceId: 'bob-pc', gpuUuid: GPU_ONE }), /consent/);
    assert.throws(() => policy.assertExecutionTarget('alice', { deviceId: 'bob-pc', gpuUuid: GPU_TWO }), /consent/);
    assert.throws(() => policy.assertExecutionTarget('alice', { deviceId: 'bob-pc' }), /consent/);
    assert.throws(() => new PersistentComputePolicy('other-session', 'owner', policy.serialize()), /another session/);
  });

  it('revalidates consent and sharing at claim after admission without mutating the accepted target', () => {
    const { policy } = setup();
    policy.setAllowMemberSwitch('owner', true);
    const pending = policy.select('alice', { deviceId: 'bob-pc' }).consent!;
    policy.decideConsent('bob', pending.id, true);
    const admitted = policy.executionTarget('alice');
    policy.revokeConsent('bob', pending.id);
    assert.throws(() => policy.assertExecutionTarget('alice', admitted.target), /consent/);
    assert.deepEqual(policy.view().target, { deviceId: 'vps' });
    assert.deepEqual(admitted.target, { deviceId: 'bob-pc' });
    const replacement = policy.select('alice', { deviceId: 'bob-pc' }).consent!;
    policy.decideConsent('bob', replacement.id, true);
    policy.share('bob', 'bob-pc', false);
    assert.throws(() => policy.assertExecutionTarget('alice', admitted.target), /sharing/);
  });

  it('does not apply an older approval over a newer concurrent selection request', () => {
    const { policy } = setup();
    policy.setAllowMemberSwitch('owner', true);
    const older = policy.select('alice', { deviceId: 'bob-pc', gpuUuid: GPU_ONE }).consent!;
    const newer = policy.select('owner', { deviceId: 'bob-pc', gpuUuid: GPU_TWO }).consent!;
    policy.decideConsent('bob', older.id, true);
    assert.deepEqual(policy.view().target, { deviceId: 'vps' });
    policy.decideConsent('bob', newer.id, true);
    assert.deepEqual(policy.view().target, { deviceId: 'bob-pc', gpuUuid: GPU_TWO });
  });

  it('does not apply stale decisions after a newer direct selection or a switching-permission change', () => {
    const { policy } = setup();
    policy.setAllowMemberSwitch('owner', true);
    const older = policy.select('alice', { deviceId: 'bob-pc' }).consent!;
    policy.select('owner', { deviceId: 'owner-pc' });
    policy.decideConsent('bob', older.id, true);
    assert.deepEqual(policy.view().target, { deviceId: 'owner-pc' });
    const revokedPermission = policy.select('alice', { deviceId: 'bob-pc', gpuUuid: GPU_TWO }).consent!;
    policy.setAllowMemberSwitch('owner', false);
    policy.decideConsent('bob', revokedPermission.id, true);
    assert.deepEqual(policy.view().target, { deviceId: 'owner-pc' });
    assert.throws(() => policy.select('alice', { deviceId: 'bob-pc', gpuUuid: GPU_TWO }), /disabled member/);
  });

  it('requires both human presence and fresh agent heartbeats, and cannot approve while the owner is offline', () => {
    const { policy, presence, advance } = setup();
    policy.setAllowMemberSwitch('owner', true);
    const pending = policy.select('alice', { deviceId: 'bob-pc' }).consent!;
    presence(['owner', 'alice']);
    assert.throws(() => policy.decideConsent('bob', pending.id, true), /must be online/);
    assert.equal(policy.view().devices.find((entry) => entry.id === 'bob-pc')!.online, false);
    presence(['owner', 'alice', 'bob']);
    advance(AGENT_ONLINE_MS + 1);
    assert.equal(policy.view().devices.find((entry) => entry.id === 'bob-pc')!.online, false);
    assert.throws(() => policy.select('alice', { deviceId: 'bob-pc' }), /offline/);
    policy.heartbeatDevice('bob-pc');
    assert.equal(policy.view().devices.find((entry) => entry.id === 'bob-pc')!.online, true);
    const current = policy.select('alice', { deviceId: 'bob-pc' }).consent!;
    policy.decideConsent('bob', current.id, true);
    presence(['owner', 'alice']);
    assert.deepEqual(policy.view().target, { deviceId: 'vps' });
    assert.throws(() => policy.assertExecutionTarget('alice', { deviceId: 'bob-pc' }), /offline/);
  });

  it('persists settings, owner baseline and consent while resetting all runtime presence on restart', () => {
    const { policy } = setup();
    policy.setAllowMemberSwitch('owner', true);
    const consent = policy.select('owner', { deviceId: 'bob-pc', gpuUuid: GPU_ONE }).consent!;
    policy.decideConsent('bob', consent.id, true);
    const saved = JSON.parse(JSON.stringify(policy.serialize()));
    const restored = new PersistentComputePolicy('session-one', 'owner', saved);
    assert.equal(restored.view().allowMemberSwitch, true);
    assert.deepEqual(restored.view().ownerBaseline, { deviceId: 'bob-pc', gpuUuid: GPU_ONE });
    assert.equal(restored.view().consents.find((entry) => entry.id === consent.id)!.status, 'approved');
    assert.deepEqual(restored.view().target, { deviceId: 'vps' });
    assert.ok(restored.view().devices.every((entry) => !entry.online));
    restored.setMembers([member('owner', true, 'owner'), member('bob', true)]);
    restored.heartbeatDevice('bob-pc');
    assert.deepEqual(restored.view().target, { deviceId: 'bob-pc', gpuUuid: GPU_ONE });
    restored.assertExecutionTarget('owner', { deviceId: 'bob-pc', gpuUuid: GPU_ONE });
  });

  it('rejects corrupt saved settings, counters, device ownership, consent bindings and GPU targets', () => {
    const { policy } = setup();
    const pending = policy.select('owner', { deviceId: 'bob-pc', gpuUuid: GPU_ONE }).consent!;
    policy.decideConsent('bob', pending.id, true);
    const saved = policy.serialize();
    const corruptions: ((state: any) => void)[] = [
      (state) => { state.allowMemberSwitch = 'true'; },
      (state) => { state.generation = -1; },
      (state) => { state.generation = Number.MAX_SAFE_INTEGER + 1; },
      (state) => { state.selectionVersion = 1.5; },
      (state) => { state.requestSequence = null; },
      (state) => { state.devices[1].enabled = 'true'; },
      (state) => { state.devices[1].ownerId = ''; },
      (state) => { state.devices.push({ ...state.devices[1] }); },
      (state) => { state.consents[0].status = 'allowed'; },
      (state) => { state.consents[0].ownerId = 'alice'; },
      (state) => { state.consents[0].sessionId = 'different-session'; },
      (state) => { state.ownerBaseline.gpuUuid = 'GPU-missing'; },
      (state) => { state.ownerBaseline.gpuUuid = 'GPU-33333333-3333-3333-3333-333333333333'; },
    ];
    for (const corrupt of corruptions) {
      const altered = JSON.parse(JSON.stringify(saved));
      corrupt(altered);
      assert.throws(() => new PersistentComputePolicy('session-one', 'owner', altered));
    }
  });

  it('reports readiness diagnostics and refuses unhealthy agents even after resource sharing is enabled', () => {
    const { policy } = setup();
    const inventory = { ...device('alice-pc'), ready: false, cudaAvailable: false, cpuCount: 8,
      diagnostics: ['Install jupyter_client in the selected environment.'] };
    const registered = policy.registerDevice('alice', inventory);
    policy.share('alice', 'alice-pc', true);
    policy.setAllowMemberSwitch('owner', true);
    assert.equal(registered.online, false);
    assert.deepEqual(registered.diagnostics, inventory.diagnostics);
    assert.throws(() => policy.select('alice', { deviceId: 'alice-pc' }), /not ready/);
    policy.registerDevice('alice', { ...inventory, ready: true });
    policy.select('alice', { deviceId: 'alice-pc' });
    assert.throws(() => policy.select('alice', { deviceId: 'alice-pc', gpuUuid: GPU_ONE }), /CUDA PyTorch/);
    const vps = policy.registerVps({ ...device('vps'), gpus: [], ready: false, diagnostics: ['Sandbox is unavailable.'] });
    assert.equal(vps.enabled, false);
    assert.equal(vps.online, false);
    assert.throws(() => policy.assertExecutionTarget('owner', { deviceId: 'vps' }), /not ready/);
  });

  it('invalidates queued kernel generations after server ACL or lifecycle changes', () => {
    const { policy } = setup();
    const admitted = policy.executionTarget('owner');
    policy.invalidateKernels();
    assert.throws(() => policy.assertExecutionTarget('owner', admitted.target, admitted.generation), /kernel generation/);
    const current = policy.executionTarget('owner');
    policy.assertExecutionTarget('owner', current.target, current.generation);
  });

  it('limits inventory growth and rejects malformed direct API targets', () => {
    const { policy } = setup();
    for (let index = 0; index < 60; index++) policy.registerDevice('alice', device(`device-${index}`));
    assert.throws(() => policy.registerDevice('alice', device('one-too-many')), /device limit/);
    assert.throws(() => policy.select('owner', { deviceId: 123 } as any), /Invalid compute target/);
    assert.throws(() => policy.registerDevice('alice', { ...device('bad-device'), ready: 'yes' } as any), /inventory/);
  });

  it('prunes revoked device memberships while retaining offline humans and devices with accepted work', () => {
    const { policy } = setup();
    policy.setAllowMemberSwitch('owner', true);
    const request = policy.select('alice', { deviceId: 'bob-pc' }).consent!;
    policy.decideConsent('bob', request.id, true);
    policy.setMembers([member('owner', true, 'owner'), member('alice', false)]);
    policy.pruneRetiredDevices(['bob-pc']);
    assert.ok(policy.view().devices.some((entry) => entry.id === 'bob-pc'));
    assert.ok(policy.view().devices.some((entry) => entry.id === 'alice-pc'));
    assert.equal(policy.view().consents.length, 0);
    policy.pruneRetiredDevices([]);
    assert.equal(policy.view().devices.some((entry) => entry.id === 'bob-pc'), false);
    assert.ok(policy.view().devices.some((entry) => entry.id === 'alice-pc'));
    policy.setMembers([member('owner', true, 'owner'), member('alice', false), member('charlie', true)]);
    assert.equal(policy.registerDevice('charlie', device('bob-pc')).enabled, false);
    assert.equal(policy.view().devices.find((entry) => entry.id === 'bob-pc')!.ownerId, 'charlie');
  });

  it('retires departed devices while protecting accepted runs and the VPS', () => {
    const { policy, presence } = setup();
    presence(['owner']);
    policy.pruneRetiredDevices(['alice-pc'], true);
    assert.ok(policy.view().devices.some(device => device.id === 'alice-pc'));
    assert.equal(policy.view().devices.some(device => device.id === 'bob-pc'), false);
    assert.ok(policy.view().devices.some(device => device.id === 'vps'));
    policy.pruneRetiredDevices([], true);
    assert.equal(policy.view().devices.some(device => device.id === 'alice-pc'), false);
    assert.equal(policy.registerDevice('alice', device('alice-pc')).enabled, false);
  });

  it('reclaims terminal and superseded consent records before the lifetime limit can block new requests', () => {
    const { policy } = setup();
    policy.setAllowMemberSwitch('owner', true);
    for (let index = 0; index < 520; index++) {
      const pending = policy.select('alice', { deviceId: 'bob-pc' }).consent!;
      policy.decideConsent('bob', pending.id, false);
    }
    const next = policy.select('alice', { deviceId: 'bob-pc' }).consent!;
    policy.decideConsent('bob', next.id, true);
    policy.assertExecutionTarget('alice', { deviceId: 'bob-pc' });
    assert.ok(policy.serialize().consents.length <= 512);
    new PersistentComputePolicy('session-one', 'owner', policy.serialize());
  });
});
