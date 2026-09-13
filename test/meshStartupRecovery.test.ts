import assert from 'node:assert/strict';
import { generateIdentityCredentials } from '../src/core/identity';
import type { PeerIdentity } from '../src/core/types';
import { configureMeshNetwork, MeshTransport } from '../src/runtime/mesh';
import { createInMemoryTrysteroFactory, resetInMemoryTrystero } from './support/in_memory_trystero';

describe('independent transport startup', () => {
  afterEach(() => { configureMeshNetwork({}); resetInMemoryTrystero(); });

  for (const readiness of ['pending', 'failed']) {
    it(`starts secondary discovery while emergency readiness is ${readiness}`, async () => {
      let secondaryStarted = 0;
      let relayStopped = false;
      const factory = createInMemoryTrysteroFactory();
      configureMeshNetwork({ relayFactory: () => ({
        connectedRelayCount: 0, onFrame: () => undefined, onPeerAnnounce: () => undefined,
        start: () => undefined, stop: () => { relayStopped = true; }, send: () => undefined, sendAnnounce: () => undefined,
        waitUntilReady: () => readiness === 'pending' ? new Promise(() => undefined) : Promise.reject(new Error('public services unavailable')),
      }) });
      const mesh = new MeshTransport({ sessionId: 'independent-startup', token: 'startup-token-that-is-long-enough',
        localPeer: { peerId: 'host', displayName: 'Host', joinOrder: 0 },
        hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'host' }), isHost: () => true,
        roomFactory: factory, secondaryRoomFactory: (...args) => { secondaryStarted += 1; return factory(...args); },
      });
      try {
        await mesh.start();
        assert.equal(secondaryStarted, 1);
        assert.equal(relayStopped, false);
      } finally { await mesh.stop(); }
      assert.equal(relayStopped, true);
    });
  }

  it('keeps secondary discovery when primary room creation throws', async () => {
    const factory = createInMemoryTrysteroFactory();
    const mesh = new MeshTransport({ sessionId: 'primary-unavailable', token: 'startup-token-that-is-long-enough',
      localPeer: { peerId: 'host', displayName: 'Host', joinOrder: 0 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'host' }), isHost: () => true,
      roomFactory: () => { throw new Error('primary unavailable'); }, secondaryRoomFactory: factory,
    });
    try { await mesh.start(); assert.equal(mesh.signallingDiagnostics()[1]?.roomCreated, true); }
    finally { await mesh.stop(); }
  });

  it('releases relay resources even when a discovery room never finishes leaving', async function () {
    this.timeout(7000);
    let relayStopped = false;
    configureMeshNetwork({ relayFactory: () => ({
      connectedRelayCount: 0, onFrame: () => undefined, onPeerAnnounce: () => undefined,
      start: () => undefined, stop: () => { relayStopped = true; }, send: () => undefined, sendAnnounce: () => undefined,
    }) });
    const factory = createInMemoryTrysteroFactory();
    const mesh = new MeshTransport({ sessionId: 'cleanup-unavailable', token: 'startup-token-that-is-long-enough',
      localPeer: { peerId: 'host', displayName: 'Host', joinOrder: 0 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'host' }), isHost: () => true,
      roomFactory: (...args) => {
        const room = factory(...args);
        room.leave = () => new Promise(() => undefined);
        return room;
      },
    });
    await mesh.start();
    await mesh.stop();
    assert.equal(relayStopped, true);
    await mesh.stop();
  });

  it('contains unwritable relay errors and retries a known peer after the attempt limit', async () => {
    let sends = 0;
    let directory: readonly PeerIdentity[] = [];
    configureMeshNetwork({ relayFactory: () => ({
      connectedRelayCount: 0, onFrame: () => undefined, onPeerAnnounce: () => undefined,
      start: () => undefined, stop: () => undefined, sendAnnounce: () => undefined,
      send: () => { sends += 1; throw new Error('route unavailable'); },
      updateDirectory: (peers) => { directory = peers; },
    }) });
    const mesh = new MeshTransport({ sessionId: 'relay-retry-budget', token: 'startup-token-that-is-long-enough',
      localPeer: { peerId: 'guest', displayName: 'Guest', joinOrder: 1 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'host' }), isHost: () => false,
      roomFactory: createInMemoryTrysteroFactory(),
    });
    try {
      await mesh.start();
      const host = { peerId: 'host', displayName: 'Host', joinOrder: 0, identityKey: generateIdentityCredentials().publicKey };
      mesh.connect(host);
      assert.ok(directory.some((peer) => peer.peerId === host.peerId && peer.identityKey === host.identityKey));
      const internal = mesh as any;
      assert.doesNotThrow(() => internal.relaySweepTick());
      assert.equal(internal.relayNegotiations.size, 0);
      internal.relayAttempts.set('host', 6);
      const previous = sends;
      internal.relaySweepTick();
      assert.ok(sends > previous);
    } finally { await mesh.stop(); }
  });
});
