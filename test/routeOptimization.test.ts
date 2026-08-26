import assert from 'node:assert/strict';
import { describe, it, before, after } from 'mocha';

/**
 * Make-before-break acceptance tests (mandatory regression).
 *
 * ACTIVE_ROUTE = emergency relay, successfully exchanging application frames.
 * The user clicks "Try to improve": a candidate direct WebRTC connection is
 * built inside a separate negotiation room while the relay keeps carrying
 * traffic. The active route may only be retired AFTER the candidate has been
 * authenticated and verified; failure leaves the session untouched.
 */

interface HubFixture {
  hub: import('ws').WebSocketServer;
  hubPort: number;
}

async function startRelayHub(): Promise<HubFixture> {
  const { WebSocketServer } = await import('ws');
  const hub = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => hub.on('listening', resolve));
  const hubPort = (hub.address() as { port: number }).port;
  hub.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as unknown[];
      if (message[0] === 'EVENT') {
        for (const client of hub.clients) {
          if (client.readyState === 1) client.send(JSON.stringify(['EVENT', 'sub', message[1]]));
        }
      }
    });
  });
  return { hub, hubPort };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('make-before-break route optimization', function () {
  this.timeout(60_000);

  let hubFixture: HubFixture;
  let meshModule: typeof import('../src/runtime/mesh.js');
  let nostrRelayModule: typeof import('../src/runtime/nostrRelay.js');
  let supportModule: typeof import('./support/in_memory_trystero.js');

  before(async () => {
    meshModule = await import('../src/runtime/mesh.js');
    nostrRelayModule = await import('../src/runtime/nostrRelay.js');
    supportModule = await import('./support/in_memory_trystero.js');
    hubFixture = await startRelayHub();
  });

  after(async () => {
    meshModule.configureMeshNetwork({});
    await new Promise<void>((resolve) => hubFixture.hub.close(() => resolve()));
  });

  interface TwoPeers {
    host: import('../src/runtime/mesh.js').MeshTransport;
    guest: import('../src/runtime/mesh.js').MeshTransport;
    receivedAtHost: Array<{ type: string; id: string; payload: string }>;
    receivedAtGuest: Array<{ type: string; id: string; payload: string }>;
    guestDisconnectedEvents: number;
    stop(): Promise<void>;
  }

  /**
   * Host + guest connected ONLY through the emergency relay. The main
   * Trystero room is intentionally dead (ICE can never connect); the route
   * upgrade room is served by the injected factory so tests control whether
   * the direct candidate succeeds or fails.
   */
  async function connectTwoPeersOverRelay(
    upgradeRoomFactory: ReturnType<typeof supportModule.createInMemoryTrysteroFactory> | 'dead',
  ): Promise<TwoPeers> {
    const { MeshTransport, configureMeshNetwork } = meshModule;
    const { NostrFrameRelay: RelayCtor } = nostrRelayModule;

    configureMeshNetwork({
      disableRelayFallback: false,
      relayFactory: ({ token, sessionId, localPeerId }) => new RelayCtor({
        token, sessionId, localPeerId,
        relays: [`ws://127.0.0.1:${hubFixture.hubPort}`],
      }),
    });

    const deadRoom = {
      makeAction: () => ({ onMessage: () => undefined, send: async () => undefined }),
      onPeerJoin: () => undefined,
      onPeerLeave: () => undefined,
      ping: async () => -1,
      leave: async () => undefined,
    };
    const inMemory = supportModule.createInMemoryTrysteroFactory();
    const { ROUTE_UPGRADE_ROOM_SUFFIX } = meshModule;
    const hybridFactory: import('../src/runtime/mesh.js').TrysteroRoomFactory = (config, roomId, callbacks) => {
      if (upgradeRoomFactory !== 'dead' && roomId.endsWith(ROUTE_UPGRADE_ROOM_SUFFIX)) {
        return inMemory(config, roomId, callbacks);
      }
      return deadRoom as never;
    };

    const clock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'host-mbb' };
    const identityA = { peerId: 'host-mbb', displayName: 'Host MBB', joinOrder: 0 };
    const identityB = { peerId: 'guest-mbb', displayName: 'Guest MBB', joinOrder: 1 };

    const commonToken = 'mbp-relay-token-that-is-long-enough';
    const host = new MeshTransport({
      sessionId: 'relay-mbb', token: commonToken,
      localPeer: identityA, hostClock: () => clock, isHost: () => true, roomFactory: hybridFactory,
    });
    const guest = new MeshTransport({
      sessionId: 'relay-mbb', token: commonToken,
      localPeer: identityB, hostClock: () => clock, isHost: () => false, roomFactory: hybridFactory,
    });

    const receivedAtHost: Array<{ type: string; id: string; payload: string }> = [];
    const receivedAtGuest: Array<{ type: string; id: string; payload: string }> = [];
    let guestDisconnectedEvents = 0;
    host.on('message', (frame: { type: string; meta: { messageId?: string }; payload: Uint8Array }) => {
      receivedAtHost.push({ type: frame.type, id: String(frame.meta.messageId), payload: Buffer.from(frame.payload).toString('utf8') });
    });
    guest.on('message', (frame: { type: string; meta: { messageId?: string }; payload: Uint8Array }) => {
      receivedAtGuest.push({ type: frame.type, id: String(frame.meta.messageId), payload: Buffer.from(frame.payload).toString('utf8') });
    });
    guest.on('peerDisconnected', () => { guestDisconnectedEvents += 1; });

    await host.start();
    await guest.start();
    guest.connect(identityA);

    const connected = Promise.all([
      new Promise<void>((resolve) => host.once('peerConnected', resolve)),
      new Promise<void>((resolve) => guest.once('peerConnected', resolve)),
    ]);
    (guest as unknown as { considerRelayFallback: (id: string) => void }).considerRelayFallback('host-mbb');
    await sleep(50);
    (host as unknown as { considerRelayFallback: (id: string) => void }).considerRelayFallback('guest-mbb');
    await connected;

    return {
      host,
      guest,
      receivedAtHost,
      receivedAtGuest,
      guestDisconnectedEvents,
      async stop(): Promise<void> {
        await host.stop();
        await guest.stop();
        supportModule.resetInMemoryTrystero();
      },
    };
  }

  it('candidate failure keeps the relay route alive with no lost frames', async () => {
    const two = await connectTwoPeersOverRelay('dead');
    try {
      assert.equal(two.host.peerRuntime().find((peer) => peer.peerId === 'guest-mbb')?.route, 'Relay');

      // Application frames keep flowing before and during the attempt.
      two.guest.sendTo('host-mbb', 'probePing', {}, Buffer.from('before-attempt'));
      await sleep(100);
      assert.ok(two.receivedAtHost.some((frame) => frame.payload === 'before-attempt'));

      assert.equal(two.host.tryImproveRoute('guest-mbb'), true);
      await sleep(200);
      two.guest.sendTo('host-mbb', 'probePing', {}, Buffer.from('during-attempt'));
      await sleep(150);
      assert.ok(two.receivedAtHost.some((frame) => frame.payload === 'during-attempt'),
        'the working relay route stopped delivering during optimization');

      // The candidate room is dead: cancel instead of waiting out the deadline.
      two.host.cancelRouteUpgrade('guest-mbb');
      await sleep(100);
      assert.equal(two.host.hasActiveRouteUpgrades(), false);

      // The old route survived untouched.
      two.guest.sendTo('host-mbb', 'probePing', {}, Buffer.from('after-cancel'));
      await sleep(150);
      assert.ok(two.receivedAtHost.some((frame) => frame.payload === 'after-cancel'));
      assert.equal(two.host.peerRuntime().find((peer) => peer.peerId === 'guest-mbb')?.route, 'Relay');
      assert.equal(two.guestDisconnectedEvents, 0);
    } finally {
      await two.stop();
    }
  });

  it('successful candidate is promoted only after verification; relay retired afterwards', async () => {
    const two = await connectTwoPeersOverRelay(supportModule.createInMemoryTrysteroFactory());
    const events: Array<{ status: string }> = [];
    try {
      two.host.on('routeUpgradeStatus', (state: { status: string }) => events.push(state));
      assert.equal(two.host.tryImproveRoute('guest-mbb'), true);

      // Wait out stability window + required pings (3s window, 1s ticks).
      const promoted = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('promotion did not happen')), 25_000);
        two.host.on('routeChanged', () => { clearTimeout(timer); resolve(); });
      });
      await promoted;

      const route = two.host.peerRuntime().find((peer) => peer.peerId === 'guest-mbb')?.route;
      assert.equal(route, 'Direct');
      const statuses = events.map((event) => event.status);
      assert.ok(statuses.includes('verifying'), `missing verifying phase: ${statuses.join(',')}`);
      assert.ok(statuses.includes('promoting'), `missing promoting phase: ${statuses.join(',')}`);
      assert.ok(statuses.includes('completed'), `missing completed phase: ${statuses.join(',')}`);

      // Frames now flow over the promoted direct route.
      two.guest.sendTo('host-mbb', 'probePing', {}, Buffer.from('after-promotion'));
      await sleep(300);
      assert.ok(two.receivedAtHost.some((frame) => frame.payload === 'after-promotion'));

      // The logical participant was NEVER torn down: no disconnect event,
      // exactly one participant entry after migration.
      assert.equal(two.guestDisconnectedEvents, 0);
      assert.equal(two.host.peerRuntime().filter((peer) => peer.peerId === 'guest-mbb').length, 1);
    } finally {
      await two.stop();
    }
  });

  it('delivers every frame exactly once across the migration boundary', async () => {
    const two = await connectTwoPeersOverRelay(supportModule.createInMemoryTrysteroFactory());
    try {
      assert.equal(two.host.tryImproveRoute('guest-mbb'), true);
      // Send frames continuously across the whole migration window.
      for (let index = 0; index < 12; index += 1) {
        two.guest.sendTo('host-mbb', 'probePing', {}, Buffer.from(`frame-${index}`));
        await sleep(400);
      }
      const ids = two.receivedAtHost
        .filter((frame) => frame.type === 'probePing')
        .map((frame) => frame.id);
      assert.equal(new Set(ids).size, ids.length, 'duplicate frame delivery after migration');
      assert.ok(ids.length >= 10, `frames were lost at the boundary: ${ids.length}/12`);
    } finally {
      await two.stop();
    }
  });

  it('refuses to optimize an already-direct route', async () => {
    const two = await connectTwoPeersOverRelay(supportModule.createInMemoryTrysteroFactory());
    try {
      assert.equal(two.host.tryImproveRoute('host-mbb'), false);
      assert.equal(two.host.improvablePeerIds().includes('guest-mbb'), true);
      // After a successful promotion there is nothing left to improve.
      const promoted = new Promise<void>((resolve) => two.host.once('routeChanged', resolve));
      two.host.tryImproveRoute('guest-mbb');
      await promoted;
      assert.equal(two.host.tryImproveRoute('guest-mbb'), false);
      assert.deepEqual(two.host.improvablePeerIds(), []);
    } finally {
      await two.stop();
    }
  });

  it('propagates remote migration status with rate limiting', async () => {
    const two = await connectTwoPeersOverRelay(supportModule.createInMemoryTrysteroFactory());
    try {
      const remoteStatuses: string[] = [];
      two.guest.on('remoteRouteStatus', (_peerId: string, status: string) => remoteStatuses.push(status));
      const sawChecking = new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          if (remoteStatuses.includes('checking-better-route')) { clearInterval(poll); resolve(); }
        }, 50);
      });
      assert.equal(two.host.tryImproveRoute('guest-mbb'), true);
      await sawChecking;
      // The sender rate-limits presence updates to one per few seconds.
      assert.ok(remoteStatuses.length <= 2, `too many presence updates: ${remoteStatuses.length}`);
      const migrated = new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          if (remoteStatuses.some((status) => ['switching-path', 'switched-path'].includes(status))) {
            clearInterval(poll);
            resolve();
          }
        }, 50);
      });
      await Promise.race([migrated, sleep(20_000)]);
      assert.ok(remoteStatuses.some((status) => ['switching-path', 'switched-path'].includes(status)),
        `migration status never reached the peer: ${remoteStatuses.join(',')}`);
    } finally {
      await two.stop();
    }
  });
});
