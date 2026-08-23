import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { MeshTransport, configureMeshNetwork } from '../out/src/runtime/mesh.js';
import { NostrFrameRelay } from '../out/src/runtime/nostrRelay.js';

process.on('unhandledRejection', (r) => console.log('UNHANDLED', r && r.stack));

const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    if (message[0] === 'EVENT') {
      for (const client of wss.clients) {
        if (client !== socket && client.readyState === 1) client.send(JSON.stringify(message));
      }
    }
  });
});

const deadRoom = () => ({
  makeAction: () => ({ onMessage: () => undefined, send: async () => undefined }),
  onPeerJoin: () => undefined,
  onPeerLeave: () => undefined,
  ping: async () => -1,
  leave: async () => undefined,
});

httpServer.listen(0, async () => {
  const port = httpServer.address().port;
  const LIVE = process.argv.includes('--live');
  if (!LIVE) {
    configureMeshNetwork({
      disableRelayFallback: false,
      relayFactory: ({ token, sessionId, localPeerId }) =>
        new NostrFrameRelay({ token, sessionId, localPeerId, relays: [`ws://127.0.0.1:${port}`] }),
    });
    console.log('MODE: local hub');
  } else {
    configureMeshNetwork({ disableRelayFallback: false });
    console.log('MODE: LIVE public Nostr relays');
  }
  configureMeshNetwork({
    disableRelayFallback: false,
    relayFactory: ({ token, sessionId, localPeerId }) =>
      new NostrFrameRelay({ token, sessionId, localPeerId, relays: [`ws://127.0.0.1:${port}`] }),
  });

  const clock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'host-r' };
  const identityA = { peerId: 'host-r', displayName: 'Host R', joinOrder: 0 };
  const identityB = { peerId: 'guest-r', displayName: 'Guest R', joinOrder: 1 };
  const token = 'relay-mesh-token-that-is-long-enough';

  const host = new MeshTransport({ sessionId: 'rm', token, localPeer: identityA, hostClock: () => clock, isHost: () => true, roomFactory: deadRoom });
  const guest = new MeshTransport({ sessionId: 'rm', token, localPeer: identityB, hostClock: () => clock, isHost: () => false, purpose: 'bootstrap', roomFactory: deadRoom });

  for (const [name, t] of [['host', host], ['guest', guest]]) {
    t.on('peerConnected', (p) => console.log(name, 'peerConnected', p.peerId));
    t.on('bootstrapConnected', (p) => console.log(name, 'bootstrapConnected', p.peerId));
    t.on('connectionError', (p, e) => console.log(name, 'connectionError', e.message));
    t.on('message', (f) => console.log(name, 'frame', f.type));
  }

  await host.start();
  await guest.start();
  guest.connect(identityA);

  const dump = (label) => {
    for (const [name, t] of [['host', host], ['guest', guest]]) {
      const anyT = t;
      const negs = [...anyT.relayNegotiations.keys()];
      const conns = [...anyT.connections.keys()];
      console.log(`${label} ${name}: relays=${anyT.relay ? anyT.relay.connectedRelayCount : 'n/a'} negs=[${negs}] conns=[${conns.map(c => c.slice(0, 12)).join(',')}] attempts=${JSON.stringify([...anyT.relayAttempts.entries()])}`);
    }
  };

  dump('t0');
  (guest).considerRelayFallback('host-r');
  setTimeout(() => dump('t+1s'), 1000);
  setTimeout(() => dump('t+3s'), 3000);
  setTimeout(() => {
    dump(LIVE ? 't+15s (LIVE)' : 't+8s');
    console.log(LIVE ? 'LIVE-RELAY-TEST-DONE (see Connected above)' : 'LOCAL-DONE');
    process.exit(0);
  }, LIVE ? 15_000 : 8_000);
});
