import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import { DUPLICATE_HANDSHAKE_WINDOW_MS, MeshTransport } from '../src/runtime/mesh';

function relayPair() {
  const clock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'relay-host' };
  const host = new MeshTransport({
    sessionId: 'relay-handshake-regression', token: 'relay-handshake-regression-token',
    localPeer: { peerId: 'relay-host', displayName: 'Host', joinOrder: 0 },
    hostClock: () => clock, isHost: () => true,
  });
  const guest = new MeshTransport({
    sessionId: 'relay-handshake-regression', token: 'relay-handshake-regression-token',
    localPeer: { peerId: 'relay-guest', displayName: 'Guest', joinOrder: 1 },
    hostClock: () => clock, isHost: () => false,
  });
  // Drive signed envelopes through the real receiver while controlling delivery.
  const h = host as any;
  const g = guest as any;
  const queued: Array<() => void> = [];
  const sent: Array<{ from: string; payload: any }> = [];
  for (const [local, remote, from] of [[h, g, 'relay-host'], [g, h, 'relay-guest']] as const) {
    local.room = { getPeers: () => ({}), leave: async () => undefined };
    local.action = { send: async () => undefined };
    local.relay = {
      connectedRelayCount: 1, stop: () => undefined,
      send: (bytes: Buffer) => {
        sent.push({ from, payload: JSON.parse(bytes.toString()).payload });
        queued.push(() => remote.handleRelayData(from, bytes));
      },
    };
  }
  host.connect(g.localHandshake().peer);
  guest.connect(h.localHandshake().peer);
  return {
    host, guest, h, g, sent,
    pump() {
      let delivered = 0;
      while (queued.length) {
        assert.ok(++delivered <= 100, 'relay handshake did not quiesce');
        queued.shift()!();
      }
    },
    async stop() { await host.stop(); await guest.stop(); },
  };
}

describe('relay handshake recovery and duplicate suppression', () => {
  for (const stale of [false, true]) {
    it(`recovers an incumbent direct route that is ${stale ? 'stale' : 'locally unavailable'}`, async () => {
      const pair = relayPair();
      const { host, guest, h, g } = pair;
      const identity = g.localHandshake().peer;
      const incumbent = {
        transportPeerId: 'old-direct', identity, purpose: 'runtime',
        connectedAt: Date.now(),
        lastSeen: Date.now() - (stale ? DUPLICATE_HANDSHAKE_WINDOW_MS + 1 : 0),
        pingFailures: 0, snapshotRequested: false,
      };
      h.connections.set('old-direct', incumbent);
      h.identityToTransport.set(identity.peerId, 'old-direct');
      if (stale) h.room.getPeers = () => ({ 'old-direct': { close: () => undefined } });
      try {
        g.considerRelayFallback('relay-host');
        pair.pump();
        assert.equal(h.identityToTransport.get(identity.peerId), 'relay:relay-guest');
        assert.equal(guest.hasRoute('relay-host'), true);
        const received: string[] = [];
        host.on('message', (frame) => received.push(Buffer.from(frame.payload).toString()));
        guest.sendTo('relay-host', 'probePing', {}, Buffer.from('recovered'));
        pair.pump();
        assert.ok(received.includes('recovered'));
      } finally { await pair.stop(); }
    });
  }

  it('accepts a fresh relay negotiation when only the remote side lost its route', async () => {
    const pair = relayPair();
    const { h, g } = pair;
    try {
      g.considerRelayFallback('relay-host');
      pair.pump();
      const incumbent = h.connections.get('relay:relay-guest');
      assert.ok(incumbent);
      g.connections.clear();
      g.identityToTransport.clear();
      g.considerRelayFallback('relay-host');
      pair.pump();
      assert.equal(pair.guest.hasRoute('relay-host'), true);
      assert.notStrictEqual(h.connections.get('relay:relay-guest'), incumbent);
    } finally { await pair.stop(); }
  });

  it('answers repeated handshakes once and ignores their late copies after admission', async () => {
    const pair = relayPair();
    const { h, g, sent } = pair;
    try {
      g.considerRelayFallback('relay-host');
      const handshake = g.relayNegotiations.get('relay-host').localHs;
      const repeat = () => h.handleRelayData('relay-guest', g.createSignedRelayEnvelope('relay-host', {
        k: 'hs', hs: handshake,
      }));
      for (let index = 0; index < 20; index += 1) repeat();
      assert.equal(sent.filter((entry) => entry.from === 'relay-host' && entry.payload.k === 'hs').length, 1);
      pair.pump();
      const incumbent = h.connections.get('relay:relay-guest');
      const before = sent.length;
      for (let index = 0; index < 20; index += 1) repeat();
      pair.pump();
      assert.strictEqual(h.connections.get('relay:relay-guest'), incumbent);
      assert.equal(h.relayNegotiations.size, 0);
      assert.equal(sent.length, before);
    } finally { await pair.stop(); }
  });

  it('keeps the live relay connection until the replacement proof is verified', async () => {
    const pair = relayPair();
    const { h, g } = pair;
    try {
      g.considerRelayFallback('relay-host');
      pair.pump();
      const incumbent = h.connections.get('relay:relay-guest');
      const handshake = g.localHandshake();
      h.handleRelayData('relay-guest', g.createSignedRelayEnvelope('relay-host', { k: 'hs', hs: handshake }));
      assert.strictEqual(h.connections.get('relay:relay-guest'), incumbent);
      assert.ok(h.relayNegotiations.has('relay-guest'));
      h.handleRelayData('relay-guest', g.createSignedRelayEnvelope('relay-host', {
        k: 'pr', pr: { version: handshake.version, signature: Buffer.alloc(64).toString('base64url') },
      }));
      assert.strictEqual(h.connections.get('relay:relay-guest'), incumbent);
      assert.equal(h.relayNegotiations.size, 0);
      assert.equal(pair.host.hasRoute('relay-guest'), true);
    } finally { await pair.stop(); }
  });
});
