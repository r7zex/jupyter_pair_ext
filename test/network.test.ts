import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'mocha';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import NodeWebSocket from 'ws';

import {
  DEFAULT_TURN_URLS,
  orderTurnEndpoints,
  parseTurnEndpoint,
  parseTurnEndpoints,
  probeTurnEndpoints,
  selectTurnEndpoints,
  type TurnEndpoint,
  type TurnTransport,
} from '../src/runtime/turn';
import {
  describeProxy,
  isHostExcluded,
  parseProxyUrl,
  redactProxyUrl,
  resolveProxy,
} from '../src/runtime/proxy';
import { createProxyAgent } from '../src/runtime/proxyWebSocket';

describe('TURN endpoint configuration', () => {
  it('parses turn and turns URLs with explicit transports', () => {
    const udp = parseTurnEndpoint('turn:relay.example.com:3478');
    assert.equal(udp?.transport, 'udp');
    assert.equal(udp?.url, 'turn:relay.example.com:3478');

    const tcp = parseTurnEndpoint('turn:relay.example.com:443?transport=tcp');
    assert.equal(tcp?.transport, 'tcp');

    const tls = parseTurnEndpoint('turns:relay.example.com:5349');
    assert.equal(tls?.transport, 'tls');

    // turns never downgrades to plain UDP even with a transport parameter.
    const turnsTcp = parseTurnEndpoint('turns:relay.example.com:443?transport=tcp');
    assert.equal(turnsTcp?.transport, 'tls');
  });

  it('applies default ports per scheme', () => {
    assert.equal(parseTurnEndpoint('turn:relay.example.com')?.port, 3478);
    assert.equal(parseTurnEndpoint('turns:relay.example.com')?.port, 5349);
  });

  it('rejects invalid URLs', () => {
    for (const url of [
      'http://relay.example.com',
      'stun:stun.example.com:19302',
      'turn:relay.example.com:notaport',
      'turn:relay.example.com:70000',
      'turn:relay.example.com:443?transport=quic',
      '',
    ]) {
      assert.equal(parseTurnEndpoint(url), undefined, url);
    }
  });

  it('drops duplicates and keeps order stable otherwise', () => {
    const endpoints = parseTurnEndpoints([
      'turn:a.example.com:3478',
      'turn:a.example.com:3478',
      'turns:b.example.com',
    ]);
    assert.deepEqual(endpoints.map((endpoint) => endpoint.url), [
      'turn:a.example.com:3478',
      // Canonical form keeps the implicit default port explicit.
      'turns:b.example.com:5349',
    ]);
  });

  it('orders UDP before TCP before TLS regardless of input order', () => {
    const endpoints = parseTurnEndpoints(DEFAULT_TURN_URLS);
    const ordered = orderTurnEndpoints(endpoints);
    assert.deepEqual(ordered.map((endpoint) => endpoint.transport), ['udp', 'tcp', 'tls']);
  });
});

describe('TURN reachability selection', () => {
  const endpoints: TurnEndpoint[] = [
    { url: 'turn:u.example.com:80', host: 'u.example.com', port: 80, transport: 'udp' },
    { url: 'turn:t.example.com:443?transport=tcp', host: 't.example.com', port: 443, transport: 'tcp' },
    { url: 'turns:s.example.com:443', host: 's.example.com', port: 443, transport: 'tls' },
  ];

  function fakeAllocate(
    results: Partial<Record<TurnTransport, number>>,
  ): (endpoint: TurnEndpoint) => Promise<number> {
    return async (endpoint) => {
      const latency = results[endpoint.transport];
      if (latency === undefined) throw new Error(`blocked ${endpoint.transport}`);
      return latency;
    };
  }

  it('keeps the static fallback chain when probing is unavailable', async () => {
    const probes = await probeTurnEndpoints(endpoints, {
      allocate: fakeAllocate({}),
      timeoutMs: 100,
    });
    assert.ok(probes.every((probe) => !probe.ok));
    // Nothing reachable: fall back to the configured UDP->TCP->TLS order.
    assert.deepEqual(selectTurnEndpoints(endpoints, probes).ordered.map((e) => e.transport), [
      'udp', 'tcp', 'tls',
    ]);
  });

  it('puts reachable transports first, transport class before latency', async () => {
    // UDP is blocked; TCP and TLS are reachable with TLS faster. Transport
    // priority (UDP -> TCP -> TLS) still beats raw latency across classes.
    const probes = await probeTurnEndpoints(endpoints, {
      allocate: fakeAllocate({ tcp: 90, tls: 40 }),
      timeoutMs: 100,
    });
    const selection = selectTurnEndpoints(endpoints, probes);
    assert.deepEqual(selection.ordered.map((endpoint) => endpoint.transport), ['tcp', 'tls', 'udp']);
    assert.ok(selection.probes.find((probe) => probe.endpoint.transport === 'udp')?.error);
  });

  it('prefers UDP when it works, preserving direct-first semantics', async () => {
    const probes = await probeTurnEndpoints(endpoints, {
      allocate: fakeAllocate({ udp: 30, tcp: 10, tls: 5 }),
      timeoutMs: 100,
    });
    assert.equal(selectTurnEndpoints(endpoints, probes).ordered[0].transport, 'udp');
  });

  it('reports probe failures without leaking credentials', async () => {
    const probes = await probeTurnEndpoints([endpoints[0]], {
      allocate: async () => { throw new Error('password=hunter2 rejected'); },
      timeoutMs: 100,
    });
    assert.match(probes[0].error ?? '', /\[redacted\]/);
  });
});

describe('proxy resolution', () => {
  it('parses HTTP, HTTPS, SOCKS5, SOCKS5H, SOCKS4 and authenticated proxies', () => {
    assert.equal(parseProxyUrl('http://proxy.local:3128')?.kind, 'http');
    assert.equal(parseProxyUrl('https://secure.proxy:443')?.kind, 'https');
    assert.equal(parseProxyUrl('socks5://proxy.local:1080')?.kind, 'socks5');
    assert.equal(parseProxyUrl('socks5h://proxy.local:1080')?.kind, 'socks5h');
    assert.equal(parseProxyUrl('socks4://proxy.local:1080')?.kind, 'socks4');
    const auth = parseProxyUrl('http://user:p%40ss@proxy.local:3128');
    assert.equal(auth?.username, 'user');
    assert.equal(auth?.password, 'p@ss');
    assert.equal(parseProxyUrl('ftp://proxy.local'), undefined);
    assert.equal(parseProxyUrl('not a url'), undefined);
  });

  it('redacts credentials from proxy URLs', () => {
    const redacted = redactProxyUrl('http://user:hunter2@proxy.local:3128');
    assert.ok(!redacted.includes('hunter2'));
    assert.ok(redacted.includes('proxy.local:3128'));
  });

  it('resolves VS Code proxy first, then environment variables by specificity', () => {
    const env = { HTTPS_PROXY: 'http://env-https:8443', ALL_PROXY: 'socks5://env-all:1080' };
    assert.equal(resolveProxy('wss://nos.lol', { vscodeProxy: 'http://vscode:3128', env })?.host, 'vscode');
    assert.equal(resolveProxy('wss://nos.lol', { env })?.host, 'env-https');
    assert.equal(resolveProxy('ws://nos.lol', { env: { HTTP_PROXY: 'http://env-http:8080' } })?.host, 'env-http');
    assert.equal(resolveProxy('wss://nos.lol', { env: { ALL_PROXY: 'socks5h://env-all:1080' } })?.kind, 'socks5h');
  });

  it('honours http.proxySupport=off for the VS Code proxy only', () => {
    const env = { HTTPS_PROXY: 'http://env-https:8443' };
    assert.equal(
      resolveProxy('wss://nos.lol', { vscodeProxy: 'http://vscode:3128', vscodeProxySupport: 'off', env })?.host,
      'env-https',
    );
  });

  it('honours NO_PROXY exclusions', () => {
    const env = { HTTPS_PROXY: 'http://env-https:8443', NO_PROXY: 'nos.lol,.internal' };
    assert.equal(resolveProxy('wss://nos.lol', { env }), undefined);
    assert.equal(resolveProxy('wss://box.internal', { env }), undefined);
    assert.equal(resolveProxy('wss://relay.damus.io', { env })?.host, 'env-https');
  });

  it('never matches a NO_PROXY suffix without a dot boundary', () => {
    assert.equal(isHostExcluded('notexample.com', 'example.com'), false);
    assert.equal(isHostExcluded('a.example.com', 'example.com'), true);
  });

  it('describes proxies without credentials', () => {
    assert.equal(describeProxy(undefined), 'Direct');
    assert.equal(describeProxy({ kind: 'socks5', host: 'p', port: 1080 }), 'SOCKS5 p:1080');
    assert.equal(describeProxy({ kind: 'https', host: 'p', port: 443, username: 'u', password: 'x' }),
      'authenticated HTTPS CONNECT p:443');
    assert.equal(describeProxy({ kind: 'socks5h', host: 'p', port: 1080 }), 'SOCKS5 (remote DNS) p:1080');
  });

  it('builds matching agents for proxy kinds and target schemes', () => {
    const httpsThroughHttp = createProxyAgent('wss://nos.lol', {
      env: { HTTPS_PROXY: 'http://corporate:3128' },
    });
    assert.equal(httpsThroughHttp?.proxy.kind, 'http');
    assert.ok(httpsThroughHttp?.agent instanceof HttpsProxyAgent);
    assert.equal(httpsThroughHttp.agent.proxy.protocol, 'http:');

    const httpsThroughHttps = createProxyAgent('wss://nos.lol', {
      env: { HTTPS_PROXY: 'https://user:p%40ss@corporate:8443' },
    });
    assert.ok(httpsThroughHttps?.agent instanceof HttpsProxyAgent);
    assert.equal(httpsThroughHttps.agent.proxy.protocol, 'https:');
    assert.equal(decodeURIComponent(httpsThroughHttps.agent.proxy.username), 'user');
    assert.equal(decodeURIComponent(httpsThroughHttps.agent.proxy.password), 'p@ss');

    const wsThroughHttp = createProxyAgent('ws://relay.example.com', {
      env: { HTTP_PROXY: 'http://corporate:3128' },
    });
    assert.ok(wsThroughHttp?.agent instanceof HttpProxyAgent);
    assert.equal(wsThroughHttp.agent.proxy.protocol, 'http:');

    const wsThroughHttps = createProxyAgent('ws://relay.example.com', {
      env: { HTTP_PROXY: 'https://corporate:8443' },
    });
    assert.ok(wsThroughHttps?.agent instanceof HttpProxyAgent);
    assert.equal(wsThroughHttps.agent.proxy.protocol, 'https:');

    const socks = createProxyAgent('wss://nos.lol', {
      env: { ALL_PROXY: 'socks5h://torified:9050' },
    });
    assert.equal(socks?.proxy.kind, 'socks5h');

    assert.equal(createProxyAgent('wss://nos.lol', { env: { NO_PROXY: 'nos.lol' } }), undefined);
  });

  it('uses HTTP CONNECT for a secure WebSocket through an HTTP proxy', async () => {
    const connectTargets: string[] = [];
    let forwardedRequestCount = 0;
    const proxyServer = createServer((_request, response) => {
      forwardedRequestCount += 1;
      response.writeHead(400).end();
    });
    proxyServer.on('connect', (request, socket) => {
      connectTargets.push(request.url ?? '');
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));

    try {
      const proxyAddress = proxyServer.address();
      assert.ok(proxyAddress && typeof proxyAddress !== 'string');
      const resolved = createProxyAgent('wss://127.0.0.1:65534', {
        vscodeProxy: `http://127.0.0.1:${proxyAddress.port}`,
        env: {},
      });
      assert.ok(resolved);

      const socket = new NodeWebSocket('wss://127.0.0.1:65534', { agent: resolved.agent });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('proxy request timed out')), 2_000);
        socket.once('error', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      assert.deepEqual(connectTargets, ['127.0.0.1:65534']);
      assert.equal(forwardedRequestCount, 0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        proxyServer.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});

describe('mesh network configuration', () => {
  it('captures custom TURN configuration and exposes sanitized diagnostics', async () => {
    const { MeshTransport, configureMeshNetwork, TRYSTERO_RELAY_URLS } = await import('../src/runtime/mesh');
    const { createInMemoryTrysteroFactory, resetInMemoryTrystero } = await import('./support/in_memory_trystero');
    configureMeshNetwork({
      turnUrls: ['turn:cotton.example.com:3478?transport=tcp', 'bogus'],
      turnUsername: 'custom-user',
      turnPassword: 'custom-secret-password',
    });
    const capturedConfigs: unknown[] = [];
    const inMemoryFactory = createInMemoryTrysteroFactory();
    const transport = new MeshTransport({
      sessionId: 'net-config',
      token: 'net-config-token-that-is-long-enough',
      localPeer: { peerId: 'self', displayName: 'Self', joinOrder: 0 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'self' }),
      isHost: () => true,
      roomFactory: (config, roomId, callbacks) => {
        capturedConfigs.push(config);
        return inMemoryFactory(config, roomId, callbacks);
      },
    });
    try {
      await transport.start();
      const config = capturedConfigs[0] as { turnConfig?: Array<{ urls: string[]; username?: string }> };
      assert.deepEqual(config.turnConfig?.[0]?.urls, ['turn:cotton.example.com:3478?transport=tcp']);
      assert.equal(config.turnConfig?.[0]?.username, 'custom-user');

      const diagnostics = JSON.stringify(transport.networkDiagnostics());
      assert.ok(!diagnostics.includes('custom-secret-password'));
      assert.ok(diagnostics.includes(TRYSTERO_RELAY_URLS[0]));
      assert.ok(diagnostics.includes('cotton.example.com'));
    } finally {
      await transport.stop();
      resetInMemoryTrystero();
      // Restore defaults so unrelated tests keep using the public fallback.
      configureMeshNetwork({});
    }
  });
});

describe('mesh relay fallback integration', function () {
  this.timeout(30_000);

  it('derives complementary relay roles regardless of which side receives first', async () => {
    const { MeshTransport } = await import('../src/runtime/mesh.js');
    const clock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'a-host' };
    const host = new MeshTransport({
      sessionId: 'relay-roles', token: 'relay-role-token-that-is-long-enough',
      localPeer: { peerId: 'a-host', displayName: 'Host', joinOrder: 0 },
      hostClock: () => clock, isHost: () => true,
    });
    const guest = new MeshTransport({
      sessionId: 'relay-roles', token: 'relay-role-token-that-is-long-enough',
      localPeer: { peerId: 'z-guest', displayName: 'Guest', joinOrder: 1 },
      hostClock: () => clock, isHost: () => false,
    });
    type RelayInternals = {
      localHandshake: () => unknown;
      advanceRelayHandshake: (peerId: string, kind: 'hs', hs: unknown, proof: unknown) => void;
      relayNegotiations: Map<string, { role: 'initiator' | 'responder' }>;
    };
    const hostInternals = host as unknown as RelayInternals;
    const guestInternals = guest as unknown as RelayInternals;

    try {
      hostInternals.advanceRelayHandshake('z-guest', 'hs', guestInternals.localHandshake(), undefined);
      guestInternals.advanceRelayHandshake('a-host', 'hs', hostInternals.localHandshake(), undefined);
      assert.equal(hostInternals.relayNegotiations.get('z-guest')?.role, 'initiator');
      assert.equal(guestInternals.relayNegotiations.get('a-host')?.role, 'responder');
    } finally {
      await host.stop();
      await guest.stop();
    }
  });

  it('expires stale relay state after a lost handshake or proof and retries with a fresh nonce', async () => {
    const { MeshTransport } = await import('../src/runtime/mesh.js');
    const clock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'a-host' };
    const transport = new MeshTransport({
      sessionId: 'relay-retry', token: 'relay-retry-token-that-is-long-enough',
      localPeer: { peerId: 'a-host', displayName: 'Host', joinOrder: 0 },
      hostClock: () => clock, isHost: () => true,
    });
    type Negotiation = { localHs: { nonce: string }; timeout: NodeJS.Timeout };
    type RelayInternals = {
      relay: unknown;
      relayNegotiations: Map<string, Negotiation>;
      considerRelayFallback: (peerId: string) => void;
      expireRelayNegotiation: (peerId: string, negotiation: Negotiation) => void;
    };
    const internals = transport as unknown as RelayInternals;
    let sends = 0;
    internals.relay = {
      connectedRelayCount: 1,
      onFrame: () => undefined,
      onPeerAnnounce: () => undefined,
      start: () => undefined,
      stop: () => undefined,
      sendAnnounce: () => undefined,
      send: () => { sends += 1; },
    };
    transport.connect({ peerId: 'z-guest', displayName: 'Guest', joinOrder: 1 });
    const errors: Error[] = [];
    transport.on('connectionError', (_peer, error: Error) => errors.push(error));

    try {
      internals.considerRelayFallback('z-guest');
      const first = internals.relayNegotiations.get('z-guest');
      assert.ok(first);
      internals.expireRelayNegotiation('z-guest', first);
      const second = internals.relayNegotiations.get('z-guest');
      assert.ok(second);
      assert.notEqual(second.localHs.nonce, first.localHs.nonce);
      assert.equal(sends, 2);
      assert.match(errors[0]?.message ?? '', /timed out; retrying/);
    } finally {
      await transport.stop();
    }
  });

  it('surfaces a bad relay proof, releases the negotiation, and retries', async () => {
    const { MeshTransport } = await import('../src/runtime/mesh.js');
    const clock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'a-host' };
    const local = new MeshTransport({
      sessionId: 'relay-proof', token: 'relay-proof-token-that-is-long-enough',
      localPeer: { peerId: 'a-host', displayName: 'Host', joinOrder: 0 },
      hostClock: () => clock, isHost: () => true,
    });
    const remote = new MeshTransport({
      sessionId: 'relay-proof', token: 'relay-proof-token-that-is-long-enough',
      localPeer: { peerId: 'z-guest', displayName: 'Guest', joinOrder: 1 },
      hostClock: () => clock, isHost: () => false,
    });
    type Negotiation = { localHs: { nonce: string }; timeout: NodeJS.Timeout };
    type RelayInternals = {
      relay: unknown;
      localHandshake: () => unknown;
      handleRelayData: (peerId: string, bytes: Buffer) => void;
      relayNegotiations: Map<string, Negotiation>;
    };
    const localInternals = local as unknown as RelayInternals;
    const remoteInternals = remote as unknown as RelayInternals;
    let sends = 0;
    localInternals.relay = {
      connectedRelayCount: 1,
      onFrame: () => undefined,
      onPeerAnnounce: () => undefined,
      start: () => undefined,
      stop: () => undefined,
      sendAnnounce: () => undefined,
      send: () => { sends += 1; },
    };
    local.connect({ peerId: 'z-guest', displayName: 'Guest', joinOrder: 1 });
    const errors: Error[] = [];
    local.on('connectionError', (_peer, error: Error) => errors.push(error));

    try {
      localInternals.handleRelayData('z-guest', Buffer.from(JSON.stringify({
        k: 'hs', hs: remoteInternals.localHandshake(),
      })));
      const failedNonce = localInternals.relayNegotiations.get('z-guest')?.localHs.nonce;
      assert.ok(failedNonce);
      localInternals.handleRelayData('z-guest', Buffer.from(JSON.stringify({
        k: 'pr', pr: { version: 2, signature: Buffer.alloc(64).toString('base64') },
      })));
      await new Promise<void>((resolve) => queueMicrotask(resolve));

      assert.match(errors[0]?.message ?? '', /failed the identity proof/);
      const retry = localInternals.relayNegotiations.get('z-guest');
      assert.ok(retry);
      assert.notEqual(retry.localHs.nonce, failedNonce);
      assert.ok(sends >= 3);
    } finally {
      await local.stop();
      await remote.stop();
    }
  });

  it('joins when only the lexically higher peer starts Nostr relay fallback', async () => {
    const { MeshTransport, configureMeshNetwork } = await import('../src/runtime/mesh.js');
    const { NostrFrameRelay: RelayCtor } = await import('../src/runtime/nostrRelay.js');
    const { WebSocketServer } = await import('ws');

    const hub = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => hub.on('listening', resolve));
    const hubPort = (hub.address() as { port: number }).port;
    hub.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as unknown[];
        if (message[0] === 'EVENT') {
          for (const client of hub.clients) {
            if (client !== socket && client.readyState === 1) client.send(JSON.stringify(message));
          }
        }
      });
    });

    // A room that never introduces peers: the WebRTC path is fully dead, so
    // any connection must come from the emergency relay.
    const deadRoom = {
      makeAction: () => ({ onMessage: () => undefined, send: async () => undefined }),
      onPeerJoin: () => undefined,
      onPeerLeave: () => undefined,
      ping: async () => -1,
      leave: async () => undefined,
    };
    const deadRoomFactory = () => deadRoom as never;

    configureMeshNetwork({
      disableRelayFallback: false,
      relayFactory: ({ token, sessionId, localPeerId }) => new RelayCtor({
        token, sessionId, localPeerId,
        relays: [`ws://127.0.0.1:${hubPort}`],
      }),
    });

    // These are the exact lexical ordering seen in the failing production
    // session: the guest id is higher, so the old inbound-is-responder rule
    // made both sides responders when only the guest started fallback.
    const hostId = '39b992fb-3700-464d-90e3-e07203ec6691';
    const guestId = '836285ae-de7f-4e84-afd5-4f93cd4fb4f5';
    const clock = { sessionEpoch: 1, hostEpoch: 0, hostId };
    const identityA = { peerId: hostId, displayName: 'Host R', joinOrder: 0 };
    const identityB = { peerId: guestId, displayName: 'Guest R', joinOrder: 1 };

    const commonToken = 'relay-mesh-token-that-is-long-enough';
    const host = new MeshTransport({
      sessionId: 'relay-mesh', token: commonToken,
      localPeer: identityA, hostClock: () => clock, isHost: () => true, roomFactory: deadRoomFactory,
    });
    const guest = new MeshTransport({
      sessionId: 'relay-mesh', token: commonToken,
      localPeer: identityB, hostClock: () => clock, isHost: () => false, roomFactory: deadRoomFactory,
    });

    try {
      await host.start();
      await guest.start();
      guest.connect(identityA);

      const connected = Promise.all([
        new Promise<void>((resolve) => host.once('peerConnected', resolve)),
        new Promise<void>((resolve) => guest.once('peerConnected', resolve)),
      ]);
      // Only the lexically higher guest starts. The host must derive its role
      // from both IDs when that inbound handshake is its first relay state.
      (guest as unknown as { considerRelayFallback: (id: string) => void })
        .considerRelayFallback(hostId);
      await connected;

      const gotFrame = new Promise<Buffer>((resolve) => {
        host.on('message', (frame: { type: string; payload: Uint8Array }) => {
          if (frame.type === 'probePing') resolve(Buffer.from(frame.payload));
        });
      });
      guest.sendTo(hostId, 'probePing', {}, Buffer.from('via-relay'));
      assert.equal((await gotFrame).toString('utf8'), 'via-relay');
      const route = host.peerRuntime().find((peer) => peer.peerId === guestId)?.route;
      assert.equal(route, 'Relay');
    } finally {
      await host.stop();
      await guest.stop();
      await new Promise<void>((resolve) => hub.close(() => resolve()));
      configureMeshNetwork({});
    }
  });
});
