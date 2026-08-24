import assert from 'node:assert/strict';
import { describe, it } from 'mocha';

/**
 * Secondary signalling family (MQTT strategy) regression tests:
 * - discovery survives total failure of the primary (Nostr) room;
 * - the same logical participant discovered through both families appears
 *   exactly ONCE and frames are never duplicated;
 * - after the winning transport dies, the peer is re-discovered through the
 *   surviving family.
 */

interface RoomStub {
  makeAction: () => { onMessage: () => void; send: () => Promise<void> };
  onPeerJoin: (id: string) => void;
  onPeerLeave: (id: string) => void;
  ping: () => Promise<number>;
  leave: () => Promise<void>;
}

function deadRoom(): RoomStub {
  return {
    makeAction: () => ({ onMessage: () => undefined, send: async () => undefined }),
    onPeerJoin: () => undefined,
    onPeerLeave: () => undefined,
    ping: async () => -1,
    leave: async () => undefined,
  };
}

describe('secondary signalling family (MQTT)', function () {
  this.timeout(30_000);

  let meshModule: typeof import('../src/runtime/mesh.js');
  let supportModule: typeof import('./support/in_memory_trystero.js');

  it('discovers peers through MQTT when the primary signalling room is dead', async () => {
    meshModule = await import('../src/runtime/mesh.js');
    supportModule = await import('./support/in_memory_trystero.js');

    const inMemory = supportModule.createInMemoryTrysteroFactory();
    const mqttFactory = (config: never, roomId: string, callbacks: never) =>
      inMemory(config, `mqtt#${roomId}`, callbacks);
    const clock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'host-sig' };

    const host = new meshModule.MeshTransport({
      sessionId: 'sig-failover', token: 'signalling-token-long-enough-for-tests',
      localPeer: { peerId: 'host-sig', displayName: 'Host Sig', joinOrder: 0 },
      hostClock: () => clock, isHost: () => true,
      roomFactory: () => deadRoom() as never,
      secondaryRoomFactory: mqttFactory as never,
    });
    const guest = new meshModule.MeshTransport({
      sessionId: 'sig-failover', token: 'signalling-token-long-enough-for-tests',
      localPeer: { peerId: 'guest-sig', displayName: 'Guest Sig', joinOrder: 1 },
      hostClock: () => clock, isHost: () => false,
      roomFactory: () => deadRoom() as never,
      secondaryRoomFactory: mqttFactory as never,
    });

    try {
      const connected = Promise.all([
        new Promise<void>((resolve) => host.once('peerConnected', resolve)),
        new Promise<void>((resolve) => guest.once('peerConnected', resolve)),
      ]);
      await host.start();
      await guest.start();
      await connected;

      // The connection must come from the SECONDARY family: the primary room
      // is a dead stub that can never admit peers.
      const mapped = [...(host as unknown as { identityToTransport: Map<string, string> }).identityToTransport.values()][0];
      assert.ok(mapped.startsWith('mqtt:'), `expected an mqtt-family transport, got ${mapped}`);
      assert.ok(host.activeSignallingFamilies().includes('mqtt'));
      const got = new Promise<string>((resolve) => {
        host.on('message', (frame: { type: string; payload: Uint8Array }) => {
          if (frame.type === 'probePing') resolve(Buffer.from(frame.payload).toString('utf8'));
        });
      });
      guest.sendTo('host-sig', 'probePing', {}, Buffer.from('via-mqtt'));
      assert.equal(await got, 'via-mqtt');
      // Exactly one logical participant on each side.
      assert.equal(host.peerRuntime().filter((peer) => peer.peerId === 'guest-sig').length, 1);
      assert.equal(guest.peerRuntime().filter((peer) => peer.peerId === 'host-sig').length, 1);
    } finally {
      await host.stop();
      await guest.stop();
      supportModule.resetInMemoryTrystero();
    }
  });

  it('deduplicates a participant discovered through both signalling families', async () => {
    const inMemory = supportModule.createInMemoryTrysteroFactory();
    const mqttFactory = (config: never, roomId: string, callbacks: never) =>
      inMemory(config, `mqttD#${roomId}`, callbacks);

    const clock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'host-dup' };
    const host = new meshModule.MeshTransport({
      sessionId: 'sig-dedupe', token: 'dedupe-signalling-token-long-enough',
      localPeer: { peerId: 'host-dup', displayName: 'Host Dup', joinOrder: 0 },
      hostClock: () => clock, isHost: () => true,
      roomFactory: inMemory as never,
      secondaryRoomFactory: mqttFactory as never,
    });
    const guest = new meshModule.MeshTransport({
      sessionId: 'sig-dedupe', token: 'dedupe-signalling-token-long-enough',
      localPeer: { peerId: 'guest-dup', displayName: 'Guest Dup', joinOrder: 1 },
      hostClock: () => clock, isHost: () => false,
      roomFactory: inMemory as never,
      secondaryRoomFactory: mqttFactory as never,
    });

    try {
      const connected = Promise.all([
        new Promise<void>((resolve) => host.once('peerConnected', resolve)),
        new Promise<void>((resolve) => guest.once('peerConnected', resolve)),
      ]);
      await host.start();
      await guest.start();
      await connected;
      // Give the second family time to attempt its (duplicate) handshake.
      await new Promise((resolve) => setTimeout(resolve, 400));

      // One logical participant each side despite two signalling families.
      assert.equal(host.peerRuntime().filter((peer) => peer.peerId === 'guest-dup').length, 1);
      assert.equal(guest.peerRuntime().filter((peer) => peer.peerId === 'host-dup').length, 1);

      // Frames flow exactly once.
      const received: string[] = [];
      host.on('message', (frame: { type: string; payload: Uint8Array }) => {
        if (frame.type === 'probePing') received.push(Buffer.from(frame.payload).toString('utf8'));
      });
      for (let index = 0; index < 5; index += 1) {
        guest.sendTo('host-dup', 'probePing', {}, Buffer.from(`m${index}`));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(received.length, 5, 'no duplicate frame delivery across families');
    } finally {
      await host.stop();
      await guest.stop();
      supportModule.resetInMemoryTrystero();
    }
  });

  it('re-discovers a peer through MQTT after the primary route dies', async () => {
    const inMemory = supportModule.createInMemoryTrysteroFactory();
    const mqttFactory = (config: never, roomId: string, callbacks: never) =>
      inMemory(config, `mqttR#${roomId}`, callbacks);

    const clock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'host-rec' };
    const host = new meshModule.MeshTransport({
      sessionId: 'sig-recovery', token: 'recovery-signalling-token-long-enough',
      localPeer: { peerId: 'host-rec', displayName: 'Host Rec', joinOrder: 0 },
      hostClock: () => clock, isHost: () => true,
      roomFactory: inMemory as never,
      secondaryRoomFactory: mqttFactory as never,
    });
    const guest = new meshModule.MeshTransport({
      sessionId: 'sig-recovery', token: 'recovery-signalling-token-long-enough',
      localPeer: { peerId: 'guest-rec', displayName: 'Guest Rec', joinOrder: 1 },
      hostClock: () => clock, isHost: () => false,
      roomFactory: inMemory as never,
      secondaryRoomFactory: mqttFactory as never,
    });

    try {
      const firstConnection = Promise.all([
        new Promise<void>((resolve) => host.once('peerConnected', resolve)),
        new Promise<void>((resolve) => guest.once('peerConnected', resolve)),
      ]);
      await host.start();
      await guest.start();
      await firstConnection;
      await new Promise((resolve) => setTimeout(resolve, 200));

      // The winning transport dies without any replacement available yet
      // (the duplicate handshake on the other family was previously
      // rejected).
      const mappings = [...(host as unknown as { identityToTransport: Map<string, string> }).identityToTransport.values()];
      const mapped = mappings[0];
      assert.ok(mapped, 'peer should be mapped before teardown');
      (host as unknown as { onPeerLeave: (id: string) => void }).onPeerLeave(mapped);
      // The logical participant is offline until a surviving family finds it.
      const stillMapped = (host as unknown as { identityToTransport: Map<string, string> })
        .identityToTransport.has('guest-rec');
      assert.equal(stillMapped, false);

      // Periodic MQTT announcements re-discover the peer; model that with
      // heal passes over the in-memory rooms.
      const remapped = new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          const m = (host as unknown as { identityToTransport: Map<string, string> })
            .identityToTransport.get('guest-rec');
          if (m) { clearInterval(poll); resolve(); }
        }, 50);
      });
      supportModule.healInMemoryTrystero();
      setTimeout(() => supportModule.healInMemoryTrystero(), 200);
      await Promise.race([remapped, new Promise((resolve) => setTimeout(resolve, 15_000))]);
      const newMapping = (host as unknown as { identityToTransport: Map<string, string> })
        .identityToTransport.get('guest-rec');
      assert.ok(newMapping, 'peer should be re-discovered through a surviving family');
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(host.peerRuntime().filter((peer) => peer.peerId === 'guest-rec').length, 1);
      const got = new Promise<string>((resolve) => {
        host.on('message', (frame: { type: string; payload: Uint8Array }) => {
          if (frame.type === 'probePing') resolve(Buffer.from(frame.payload).toString('utf8'));
        });
      });
      guest.sendTo('host-rec', 'probePing', {}, Buffer.from('back-online'));
      assert.equal(await got, 'back-online');
    } finally {
      await host.stop();
      await guest.stop();
      supportModule.resetInMemoryTrystero();
    }
  });
});
