import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { after, before, describe, it } from 'mocha';
import NodeWebSocket, { WebSocketServer } from 'ws';
import { NostrFrameRelay, type RelaySocketFactory } from '../src/runtime/nostrRelay';
import { createProxyAgent, type ProxyWebSocketRuntimeOptions } from '../src/runtime/proxyWebSocket';

interface NetworkProfile {
  name: string;
  proxy: ProxyWebSocketRuntimeOptions;
  expected: 'direct' | 'proxy';
}

const profiles: NetworkProfile[] = [
  { name: 'direct', proxy: { env: {} }, expected: 'direct' },
  // Flowseal/zapret and Karing TUN are transparent below the application.
  { name: 'flowseal-zapret', proxy: { env: {} }, expected: 'direct' },
  { name: 'karing-tun', proxy: { env: {} }, expected: 'direct' },
  { name: 'karing-system-proxy', proxy: { env: {} }, expected: 'proxy' },
  { name: 'explicit-http-proxy', proxy: { env: {} }, expected: 'proxy' },
  { name: 'environment-http-proxy', proxy: {}, expected: 'proxy' },
];

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error('network matrix condition timed out'));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

describe('Russia-oriented network compatibility matrix', function () {
  this.timeout(30_000);

  let relayServer: Server;
  let relayHub: WebSocketServer;
  let relayUrl = '';
  let proxyServer: Server;
  let proxyUrl = '';

  before(async () => {
    relayServer = createServer();
    relayHub = new WebSocketServer({ server: relayServer });
    relayHub.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as unknown[];
        if (message[0] !== 'EVENT') return;
        for (const client of relayHub.clients) {
          if (client.readyState === NodeWebSocket.OPEN) client.send(JSON.stringify(['EVENT', 'sub', message[1]]));
        }
      });
    });
    relayUrl = `ws://127.0.0.1:${await listen(relayServer)}`;

    proxyServer = createServer((_request, response) => response.writeHead(400).end());
    // HttpProxyAgent forwards ws:// upgrade requests with an absolute target
    // URL. Relay the raw upgraded stream while preserving target headers.
    proxyServer.on('upgrade', (request, client, head) => {
      let target: URL;
      try {
        target = new URL(request.url ?? '', `http://${request.headers.host ?? ''}`);
      } catch {
        client.destroy();
        return;
      }
      const upstream = connect(Number(target.port || 80), target.hostname, () => {
        const requestPath = `${target.pathname || '/'}${target.search}`;
        upstream.write(`${request.method ?? 'GET'} ${requestPath} HTTP/${request.httpVersion}\r\n`);
        upstream.write(`host: ${target.host}\r\n`);
        for (const [name, value] of Object.entries(request.headers)) {
          if (name === 'host' || name === 'proxy-connection' || value === undefined) continue;
          upstream.write(`${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`);
        }
        upstream.write('\r\n');
        if (head.byteLength) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
    proxyUrl = `http://127.0.0.1:${await listen(proxyServer)}`;
  });

  after(async () => {
    for (const client of relayHub.clients) client.terminate();
    await Promise.all([closeServer(proxyServer), closeServer(relayServer)]);
  });

  function optionsFor(profile: NetworkProfile): ProxyWebSocketRuntimeOptions {
    if (profile.name === 'karing-system-proxy') return { systemProxy: proxyUrl, env: {} };
    if (profile.name === 'explicit-http-proxy') return { explicitProxy: proxyUrl, env: {} };
    if (profile.name === 'environment-http-proxy') return { env: { HTTP_PROXY: proxyUrl } };
    return profile.proxy;
  }

  function socketFactory(profile: NetworkProfile): RelaySocketFactory {
    const options = optionsFor(profile);
    return (url) => {
      const resolved = createProxyAgent(url, options);
      assert.equal(resolved ? 'proxy' : 'direct', profile.expected, `${profile.name} route`);
      return new NodeWebSocket(url, resolved ? { agent: resolved.agent } : undefined);
    };
  }

  for (let leftIndex = 0; leftIndex < profiles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex; rightIndex < profiles.length; rightIndex += 1) {
      const left = profiles[leftIndex]!;
      const right = profiles[rightIndex]!;
      it(`${left.name} connects to ${right.name} when WebRTC/UDP is unavailable`, async () => {
        const sessionId = `matrix-${leftIndex}-${rightIndex}`;
        const token = `matrix-token-${leftIndex}-${rightIndex}-abcdefghijklmnopqrstuvwxyz`;
        const first = new NostrFrameRelay({
          token,
          sessionId,
          localPeerId: `left-${leftIndex}`,
          relays: [relayUrl],
          socketFactory: socketFactory(left),
        });
        const second = new NostrFrameRelay({
          token,
          sessionId,
          localPeerId: `right-${rightIndex}`,
          relays: [relayUrl],
          socketFactory: socketFactory(right),
        });
        const payload = Buffer.from(`${left.name}->${right.name}`);
        const received: Buffer[] = [];
        second.onFrame = (_peerId, bytes) => received.push(Buffer.from(bytes));
        try {
          first.start();
          second.start();
          await waitFor(() => first.connectedRelayCount === 1 && second.connectedRelayCount === 1);
          first.send(payload, `right-${rightIndex}`);
          await waitFor(() => received.length === 1);
          assert.ok(received[0]!.equals(payload));
        } finally {
          first.stop();
          second.stop();
        }
      });
    }
  }
});
