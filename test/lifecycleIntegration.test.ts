import assert from 'node:assert/strict';
import { MeshTransport, type TransportLifecycleDiagnostic } from '../src/runtime/mesh';

function transport(recoveryMs = 25): MeshTransport {
  return new MeshTransport({
    sessionId: 'diagnostic-test-session',
    token: 'diagnostic-test-token-that-is-long-enough',
    localPeer: { peerId: 'host', displayName: 'Host', joinOrder: 0 },
    hostClock: () => ({ sessionEpoch: 0, hostEpoch: 0, hostId: 'host' }),
    isHost: () => true,
    logicalPeerRecoveryMs: recoveryMs,
  });
}

describe('transport lifecycle diagnostic correlation', () => {
  it('uses one id inside a recovery and a different id after the cycle ends', async () => {
    const mesh = transport(1000);
    const events: TransportLifecycleDiagnostic[] = [];
    mesh.on('lifecycleDiagnostic', (event: TransportLifecycleDiagnostic) => events.push(event));
    const peer = { peerId: 'peer-a', displayName: 'Peer A', joinOrder: 1 };
    (mesh as any).beginLogicalRecovery(peer, 'runtime', Date.now(), 'route-lost', 'direct');
    const first = events[0]?.correlationId;
    assert.ok(first);
    assert.deepEqual(events.slice(0, 2).map((event) => event.eventType), ['route-lost', 'recovery-started']);
    assert.equal(new Set(events.slice(0, 2).map((event) => event.correlationId)).size, 1);
    (mesh as any).finishLogicalRecovery(peer.peerId);
    (mesh as any).beginLogicalRecovery(peer, 'runtime', Date.now(), 'route-lost', 'relay');
    assert.notEqual(events.at(-2)?.correlationId, first);
    await mesh.stop();
  });

  it('emits half-open, route loss, deadline and terminal peer disconnect under one id', async () => {
    const mesh = transport(10);
    const events: TransportLifecycleDiagnostic[] = [];
    mesh.on('lifecycleDiagnostic', (event: TransportLifecycleDiagnostic) => events.push(event));
    (mesh as any).beginLogicalRecovery(
      { peerId: 'peer-b', displayName: 'Peer B', joinOrder: 1 },
      'runtime', Date.now(), 'half-open-detected', 'direct',
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(events.map((event) => event.eventType), [
      'half-open-detected', 'route-lost', 'recovery-started', 'recovery-deadline', 'peer-disconnected',
    ]);
    assert.equal(new Set(events.map((event) => event.correlationId)).size, 1);
    await mesh.stop();
  });
});
