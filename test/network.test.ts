import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { describe, it } from 'mocha';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import NodeWebSocket, { WebSocketServer as NodeWebSocketServer } from 'ws';

import {
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
  inspectExplicitProxyUrl,
  isHostExcluded,
  parseProxyUrl,
  redactProxyUrl,
  resolveProxy,
} from '../src/runtime/proxy';
import {
  createProxyAgent,
  getSignallingSocketHealth,
  installProxyAwareWebSocket,
} from '../src/runtime/proxyWebSocket';
import { proxyAwareMqttOptions } from '../src/runtime/mqttProxy';
import { signallingEndpointIdentity } from '../src/runtime/signallingEndpoint';
import { forceSignallingSocketRefresh } from '../src/runtime/signallingSocketRefresh';
import {
  parseWindowsSystemProxyOutput,
  proxyUrlFromWindowsValue,
  readWindowsSystemProxy,
} from '../src/runtime/systemProxy';

describe('signalling WebSocket health', () => {
  it('keeps same-origin relay identities separate without exposing URL secrets', () => {
    const first = signallingEndpointIdentity(
      'wss://alice:first-secret@relay.example/private-one?token=first-token',
    );
    const second = signallingEndpointIdentity(
      'wss://bob:second-secret@relay.example/private-two?token=second-token',
    );
    assert.equal(first.label, 'wss://relay.example');
    assert.equal(second.label, 'wss://relay.example');
    assert.notEqual(first.id, second.id);
    assert.doesNotMatch(
      JSON.stringify([first, second]),
      /alice|bob|first-secret|second-secret|private-one|private-two|first-token|second-token/,
    );
  });

  it('retains a sanitized endpoint failure without credentials or query data', async () => {
    let acceptUpgrade = false;
    const server = createServer();
    const hub = new NodeWebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      if (!acceptUpgrade) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      hub.handleUpgrade(request, socket, head, (accepted) => hub.emit('connection', accepted, request));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    let socket: NodeWebSocket | undefined;
    let reconnectingSocket: NodeWebSocket | undefined;
    try {
      installProxyAwareWebSocket({ env: {} });
      const WebSocketRuntime = (globalThis as unknown as { WebSocket: typeof NodeWebSocket }).WebSocket;
      socket = new WebSocketRuntime(
        `ws://user:password-secret@127.0.0.1:${address.port}/topic-secret?token=query-secret`,
      );
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 3_000);
        socket!.once('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      const health = getSignallingSocketHealth()
        .find((item) => item.endpoint === `ws://127.0.0.1:${address.port}`);
      assert.equal(health?.state, 'failed');
      assert.equal(health?.lastError?.category, 'authentication');
      assert.equal(health?.lastError?.phase, 'endpoint');
      assert.doesNotMatch(JSON.stringify(health), /password-secret|query-secret|topic-secret/);

      acceptUpgrade = true;
      reconnectingSocket = new WebSocketRuntime(
        `ws://user:password-secret@127.0.0.1:${address.port}/topic-secret?token=query-secret`,
      );
      const reconnecting = getSignallingSocketHealth()
        .find((item) => item.endpoint === `ws://127.0.0.1:${address.port}`);
      assert.equal(reconnecting?.state, 'connecting');
      assert.equal(reconnecting?.lastError?.category, 'authentication');
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WebSocket reconnect timed out.')), 3_000);
        reconnectingSocket!.once('open', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      const connected = getSignallingSocketHealth()
        .find((item) => item.endpoint === `ws://127.0.0.1:${address.port}`);
      assert.equal(connected?.state, 'connected');
      assert.equal(connected?.lastError, undefined);
    } finally {
      socket?.terminate();
      reconnectingSocket?.terminate();
      for (const client of hub.clients) client.terminate();
      hub.close();
      if (descriptor) Object.defineProperty(globalThis, 'WebSocket', descriptor);
      else delete (globalThis as { WebSocket?: unknown }).WebSocket;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

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
    const endpoints = parseTurnEndpoints([
      'turns:relay.example.com:443',
      'turn:relay.example.com:443?transport=tcp',
      'turn:relay.example.com:3478',
    ]);
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
    assert.equal(selectTurnEndpoints(endpoints, probes).ordered[0]?.transport, 'udp');
  });

  it('reports probe failures without leaking credentials', async () => {
    const probes = await probeTurnEndpoints([endpoints[0]!], {
      allocate: async () => { throw new Error('password=hunter2 rejected'); },
      timeoutMs: 100,
    });
    assert.match(probes[0]?.error ?? '', /\[redacted\]/);
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

  it('uses protocol-correct default proxy ports', () => {
    assert.equal(parseProxyUrl('http://proxy.local')?.port, 80);
    assert.equal(parseProxyUrl('https://proxy.local')?.port, 443);
    assert.equal(parseProxyUrl('socks5://proxy.local')?.port, 1080);
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

  it('supports an explicit local VPN proxy and Windows system-proxy fallback', () => {
    const env = { HTTPS_PROXY: 'http://env:8443' };
    assert.equal(resolveProxy('wss://nos.lol', {
      explicitProxy: 'socks5h://karing:10808',
      vscodeProxy: 'http://vscode:3128',
      systemProxy: 'http://system:10809',
      env,
    })?.host, 'karing');
    assert.equal(resolveProxy('wss://nos.lol', { systemProxy: 'http://system:10809', env: {} })?.host, 'system');
    assert.equal(resolveProxy('wss://nos.lol', { systemProxy: 'http://system:10809', env })?.host, 'env');
  });

  it('applies a bound secret only to the exact password-free explicit proxy', () => {
    const details = inspectExplicitProxyUrl('http://alice:p%40ss@proxy.local:3128');
    assert.equal(details?.proxyUrl, 'http://alice@proxy.local:3128/');
    assert.equal(details?.password, 'p@ss');
    const credential = { binding: details!.binding, password: details!.password! };
    const resolved = resolveProxy('wss://nos.lol', {
      explicitProxy: details!.proxyUrl,
      explicitProxyPassword: credential,
      vscodeProxy: 'http://fallback:external@fallback.local:8080',
      env: {},
    });
    assert.equal(resolved?.host, 'proxy.local');
    assert.equal(resolved?.username, 'alice');
    assert.equal(resolved?.password, 'p@ss');

    assert.equal(resolveProxy('wss://nos.lol', {
      explicitProxy: 'http://bob@proxy.local:3128',
      explicitProxyPassword: credential,
      env: {},
    })?.password, undefined);
    assert.equal(resolveProxy('wss://nos.lol', {
      explicitProxy: 'not a proxy URL',
      explicitProxyPassword: credential,
      vscodeProxy: 'http://fallback:external@fallback.local:8080',
      env: {},
    })?.password, 'external');
    assert.throws(
      () => resolveProxy('wss://nos.lol', {
        explicitProxy: 'http://alice:embedded@proxy.local:3128',
        env: {},
      }),
      /Set Proxy Password/,
    );
    assert.throws(
      () => resolveProxy('wss://nos.lol', {
        explicitProxy: 'ftp://alice:embedded@proxy.local:21',
        env: {},
      }),
      /Set Proxy Password/,
    );
    assert.throws(
      () => resolveProxy('wss://nos.lol', {
        explicitProxy: 'http://alice:%E0%A4%A@proxy.local:3128',
        env: {},
      }),
      /Set Proxy Password/,
    );
    assert.throws(
      () => resolveProxy('wss://nos.lol', {
        explicitProxy: 'http://alice:embedded@',
        env: {},
      }),
      /Set Proxy Password/,
    );
    assert.throws(
      () => resolveProxy('wss://nos.lol', {
        explicitProxy: '//alice:embedded@proxy.local:3128',
        env: {},
      }),
      /Set Proxy Password/,
    );
    assert.throws(
      () => resolveProxy('wss://nos.lol', {
        explicitProxy: 'opaque:/alice:embedded@proxy.local:3128',
        env: {},
      }),
      /Set Proxy Password/,
    );
    assert.throws(
      () => resolveProxy('wss://nos.lol', {
        explicitProxy: 'opaque:/decoy@alice:embedded@proxy.local:3128',
        env: {},
      }),
      /Set Proxy Password/,
    );
    assert.throws(
      () => resolveProxy('wss://nos.lol', {
        explicitProxy: 'alice:/embedded@proxy.local:3128',
        env: {},
      }),
      /Set Proxy Password/,
    );
  });

  it('uses HTTP_PROXY for secure CONNECT when HTTPS_PROXY is absent', () => {
    assert.equal(resolveProxy('wss://nos.lol', {
      env: { HTTP_PROXY: 'http://karing:10809' },
    })?.host, 'karing');
  });

  it('honours http.proxySupport=off for the VS Code proxy only', () => {
    const env = { HTTPS_PROXY: 'http://env-https:8443' };
    assert.equal(
      resolveProxy('wss://nos.lol', { vscodeProxy: 'http://vscode:3128', vscodeProxySupport: 'off', env })?.host,
      'env-https',
    );
    assert.equal(resolveProxy('wss://nos.lol', {
      systemProxy: 'http://system:10809', vscodeProxySupport: 'off', env: {},
    })?.host, 'system');
  });

  it('honours NO_PROXY exclusions', () => {
    const env = { HTTPS_PROXY: 'http://env-https:8443', NO_PROXY: 'nos.lol,.internal' };
    assert.equal(resolveProxy('wss://nos.lol', { env }), undefined);
    assert.equal(resolveProxy('wss://box.internal', { env }), undefined);
    assert.equal(resolveProxy('wss://nostr.data.haus', { env })?.host, 'env-https');
  });

  it('honours port-qualified, VS Code and Windows bypass lists', () => {
    assert.equal(isHostExcluded('nos.lol', 'nos.lol:443', '443'), true);
    assert.equal(isHostExcluded('nos.lol', 'nos.lol:80', '443'), false);
    assert.equal(isHostExcluded('127.0.0.1', 'localhost;127.*;<local>', '443'), true);
    assert.equal(resolveProxy('wss://nos.lol', {
      systemProxy: 'http://system:10809',
      systemNoProxy: 'nos.lol;localhost',
      env: {},
    }), undefined);
    assert.equal(resolveProxy('wss://box.internal', {
      vscodeProxy: 'http://vscode:3128',
      vscodeNoProxy: ['.internal'],
      env: {},
    }), undefined);
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
    assert.equal(httpsThroughHttps.agent.proxy.username, '');
    assert.equal(httpsThroughHttps.agent.proxy.password, '');
    const httpsHeaders = typeof httpsThroughHttps.agent.proxyHeaders === 'function'
      ? httpsThroughHttps.agent.proxyHeaders()
      : httpsThroughHttps.agent.proxyHeaders;
    assert.equal(
      httpsHeaders['Proxy-Authorization'],
      'Basic ' + Buffer.from('user:p@ss').toString('base64'),
    );

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

    const passwordOnlyDetails = inspectExplicitProxyUrl('http://password-only.local:3128')!;
    const passwordOnly = createProxyAgent('wss://nos.lol', {
      explicitProxy: passwordOnlyDetails.proxyUrl,
      explicitProxyPassword: { binding: passwordOnlyDetails.binding, password: 'secret' },
      env: {},
    });
    assert.equal(passwordOnly?.proxy.username, undefined);
    assert.equal(passwordOnly?.proxy.password, 'secret');
    const passwordOnlyAgent = passwordOnly!.agent as HttpsProxyAgent<string>;
    assert.equal(passwordOnlyAgent.proxy.username, '');
    assert.equal(passwordOnlyAgent.proxy.password, '');
    const passwordOnlyHeaders = typeof passwordOnlyAgent.proxyHeaders === 'function'
      ? passwordOnlyAgent.proxyHeaders()
      : passwordOnlyAgent.proxyHeaders;
    assert.equal(
      passwordOnlyHeaders['Proxy-Authorization'],
      'Basic ' + Buffer.from(':secret').toString('base64'),
    );

    assert.equal(createProxyAgent('wss://nos.lol', { env: { NO_PROXY: 'nos.lol' } }), undefined);
  });

  it('keeps proxy credentials out of dependency DEBUG output', () => {
    const result = spawnSync(
      process.execPath,
      [path.resolve(__dirname, '../../scripts/proxy-debug-smoke.mjs')],
      {
        cwd: path.resolve(__dirname, '../..'),
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /proxy DEBUG redaction: passed/);
    assert.ok(!result.stderr.includes('sec012-debug-canary'));
  });

  it('uses HTTP CONNECT for a secure WebSocket through an HTTP proxy', async () => {
    const connectTargets: string[] = [];
    let proxyAuthorization: string | undefined;
    let forwardedRequestCount = 0;
    const proxyServer = createServer((_request, response) => {
      forwardedRequestCount += 1;
      response.writeHead(400).end();
    });
    proxyServer.on('connect', (request, socket) => {
      connectTargets.push(request.url ?? '');
      proxyAuthorization = request.headers['proxy-authorization'];
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    await new Promise<void>((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));

    try {
      const proxyAddress = proxyServer.address();
      assert.ok(proxyAddress && typeof proxyAddress !== 'string');
      const explicit = inspectExplicitProxyUrl(`http://alice@127.0.0.1:${proxyAddress.port}`)!;
      const resolved = createProxyAgent('wss://127.0.0.1:65534', {
        explicitProxy: explicit.proxyUrl,
        explicitProxyPassword: { binding: explicit.binding, password: 'connect-secret' },
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
      assert.equal(
        proxyAuthorization,
        'Basic ' + Buffer.from('alice:connect-secret').toString('base64'),
      );
      assert.equal(forwardedRequestCount, 0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        proxyServer.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});

describe('MQTT proxy integration', () => {
  it('injects a proxy-aware WebSocket hook into MQTT.js options', () => {
    const calls: Array<{ url: string; protocols: string[] }> = [];
    const expectedSocket = {};
    const options = proxyAwareMqttOptions({}, (url, protocols) => {
      calls.push({ url, protocols });
      return expectedSocket;
    });
    const created = options.createWebsocket?.('wss://broker.example/mqtt', ['mqtt'], options);
    assert.equal(created, expectedSocket);
    assert.deepEqual(calls, [{ url: 'wss://broker.example/mqtt', protocols: ['mqtt'] }]);
  });

  it('preserves an explicit MQTT WebSocket hook', () => {
    const explicit = (): object => ({ explicit: true });
    const options = proxyAwareMqttOptions({ createWebsocket: explicit });
    assert.equal(options.createWebsocket, explicit);
  });
});

describe('Windows system proxy discovery', () => {
  it('normalizes single and per-protocol WinINet ProxyServer values', () => {
    assert.equal(proxyUrlFromWindowsValue('127.0.0.1:10809'), 'http://127.0.0.1:10809');
    assert.equal(
      proxyUrlFromWindowsValue('http=127.0.0.1:8080;https=127.0.0.1:10809;socks=127.0.0.1:10808'),
      'http://127.0.0.1:10809',
    );
    assert.equal(proxyUrlFromWindowsValue('socks=127.0.0.1:10808'), 'socks5://127.0.0.1:10808');
  });

  it('parses enabled WinINet registry settings and bypasses', () => {
    const parsed = parseWindowsSystemProxyOutput(`
      ProxyEnable    REG_DWORD    0x1
      ProxyServer    REG_SZ       127.0.0.1:10809
      ProxyOverride  REG_SZ       localhost;*.internal;<local>
    `);
    assert.equal(parsed?.proxyUrl, 'http://127.0.0.1:10809');
    assert.equal(parsed?.noProxy, 'localhost,*.internal,<local>');
  });

  it('does not use a disabled manual proxy and reports PAC-only configuration', () => {
    assert.equal(parseWindowsSystemProxyOutput(`
      ProxyEnable    REG_DWORD    0x0
      ProxyServer    REG_SZ       127.0.0.1:10809
    `), undefined);
    assert.equal(parseWindowsSystemProxyOutput(`
      ProxyEnable    REG_DWORD    0x0
      AutoConfigURL  REG_SZ       http://127.0.0.1/proxy.pac
    `)?.autoConfigUrl, 'http://127.0.0.1/proxy.pac');
  });

  it('is read-only, Windows-only and accepts an injected registry query', async () => {
    assert.equal(await readWindowsSystemProxy({ platform: 'linux', queryRegistry: async () => {
      throw new Error('must not run');
    } }), undefined);
    const parsed = await readWindowsSystemProxy({
      platform: 'win32',
      queryRegistry: async () => 'ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ 127.0.0.1:10809',
    });
    assert.equal(parsed?.proxyUrl, 'http://127.0.0.1:10809');
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
      assert.ok(diagnostics.includes(TRYSTERO_RELAY_URLS[0] ?? ''));
      assert.ok(diagnostics.includes('cotton.example.com'));
      assert.equal((transport.networkDiagnostics() as { turnStatus?: string }).turnStatus, 'configured');
    } finally {
      await transport.stop();
      resetInMemoryTrystero();
      // Restore the unconfigured default so unrelated tests do not inherit credentials.
      configureMeshNetwork({});
    }
  });
});

describe('signalling socket refresh', () => {
  it('prefers termination, falls back to close, and ignores closed sockets', () => {
    let beforeRefreshCalls = 0;
    let terminateCalls = 0;
    let closeCalls = 0;
    assert.equal(forceSignallingSocketRefresh({
      readyState: 1,
      terminate: () => { terminateCalls += 1; },
      close: () => { closeCalls += 1; },
    }, () => { beforeRefreshCalls += 1; }), true);
    assert.equal(terminateCalls, 1);
    assert.equal(closeCalls, 0);
    assert.equal(beforeRefreshCalls, 1);

    assert.equal(forceSignallingSocketRefresh({
      readyState: 0,
      terminate: () => { throw new Error('termination unavailable'); },
      close: () => { closeCalls += 1; },
    }, () => { beforeRefreshCalls += 1; }), true);
    assert.equal(closeCalls, 1);
    assert.equal(beforeRefreshCalls, 2);

    assert.equal(forceSignallingSocketRefresh({
      readyState: 3,
      close: () => { closeCalls += 1; },
    }, () => { beforeRefreshCalls += 1; }), false);
    assert.equal(closeCalls, 1);
    assert.equal(beforeRefreshCalls, 2);
  });
});

describe('mesh relay fallback integration', function () {
  it('retires a half-open direct route after repeated failed VPN-era probes', async () => {
    const { MeshTransport } = await import('../src/runtime/mesh.js');
    const clock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'host' };
    const transport = new MeshTransport({
      sessionId: 'half-open-route', token: 'half-open-route-token-that-is-long-enough',
      localPeer: { peerId: 'host', displayName: 'Host', joinOrder: 0 },
      hostClock: () => clock, isHost: () => true, logicalPeerRecoveryMs: 60_000,
    });
    const peer = { peerId: 'guest', displayName: 'Guest', joinOrder: 1 };
    let recovering = 0;
    transport.on('peerRecovering', () => { recovering += 1; });
    const fakeRoom = {
      getPeers: () => ({ guest: { close: () => undefined } }),
      ping: async () => { throw new Error('stale DataChannel'); },
      leave: async () => undefined,
    };
    const internals = transport as any;
    internals.room = fakeRoom;
    internals.directory.set('guest', peer);
    internals.connections.set('guest', {
      transportPeerId: 'guest', identity: peer, purpose: 'runtime',
      connectedAt: Date.now() - 10_000, lastSeen: Date.now() - 10_000,
      pingFailures: 0, snapshotRequested: false,
    });
    internals.identityToTransport.set('guest', 'guest');
    try {
      await internals.pingTick();
      await internals.pingTick();
      assert.equal(transport.hasRoute('guest'), true, 'one or two probe failures do not tear down a route');
      await internals.pingTick();
      assert.equal(transport.hasRoute('guest'), false);
      assert.equal(transport.isPeerRecovering('guest'), true, 'logical identity remains recoverable');
      assert.equal(recovering, 1);
    } finally {
      await transport.stop();
    }
  });

  this.timeout(30_000);

  it('does not call allocated signalling rooms active without endpoint or peer evidence', async () => {
    const { MeshTransport } = await import('../src/runtime/mesh.js');
    let primaryCallbacks: { onJoinError?: (details: {
      error: string;
      appId: string;
      roomId: string;
      peerId: string;
    }) => void } | undefined;
    let roomLeaveCalls = 0;
    const deadRoom = {
      makeAction: () => ({ onMessage: () => undefined, send: async () => undefined }),
      onPeerJoin: () => undefined,
      onPeerLeave: () => undefined,
      getPeers: () => ({}),
      ping: async () => -1,
      leave: async () => { roomLeaveCalls += 1; },
    };
    const transport = new MeshTransport({
      sessionId: 'signalling-health', token: 'signalling-health-token-is-long-enough',
      localPeer: { peerId: 'health-host', displayName: 'Health Host', joinOrder: 0 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'health-host' }),
      isHost: () => true,
      roomFactory: (_config, _roomId, callbacks) => {
        primaryCallbacks = callbacks;
        return deadRoom as never;
      },
      secondaryRoomFactory: () => {
        throw new Error('authentication failed for wss://user:super-secret@broker.example/private-topic');
      },
    });

    try {
      await transport.start();
      assert.deepEqual(transport.activeSignallingFamilies(), []);
      primaryCallbacks?.onJoinError?.({
        error: 'WebSocket failed for token=another-super-secret',
        appId: 'private-app',
        roomId: 'private-room-topic',
        peerId: 'unknown-peer',
      });
      const diagnostics = transport.networkDiagnostics() as {
        signalling: Array<{
          family: string;
          active: boolean;
          stage: string;
          lastError?: { category: string; phase: string };
        }>;
      };
      const nostr = diagnostics.signalling.find((family) => family.family === 'nostr');
      const mqtt = diagnostics.signalling.find((family) => family.family === 'mqtt');
      assert.equal(nostr?.active, false);
      assert.equal(nostr?.stage, 'failed');
      assert.equal(nostr?.lastError?.category, 'socket');
      assert.equal(nostr?.lastError?.phase, 'handshake');
      assert.equal(mqtt?.active, false);
      assert.equal(mqtt?.stage, 'failed');
      assert.equal(mqtt?.lastError?.category, 'startup');
      assert.equal(mqtt?.lastError?.phase, 'startup');
      const serialized = JSON.stringify(diagnostics);
      assert.doesNotMatch(serialized, /super-secret|private-topic|private-room-topic|another-super-secret/);
      const noteHistoricalRoute = transport as unknown as {
        noteSignallingPeerStage: (
          family: 'nostr',
          stage: 'peer-discovered' | 'identity-authenticated' | 'route-established',
        ) => void;
      };
      noteHistoricalRoute.noteSignallingPeerStage('nostr', 'peer-discovered');
      noteHistoricalRoute.noteSignallingPeerStage('nostr', 'identity-authenticated');
      noteHistoricalRoute.noteSignallingPeerStage('nostr', 'route-established');
      assert.deepEqual(
        transport.activeSignallingFamilies(),
        [],
        'historical peer/route timestamps are not current capability',
      );
      const routeInternals = transport as unknown as {
        connections: Map<string, {
          transportPeerId: string;
          identity: { peerId: string; displayName: string; joinOrder: number };
          purpose: 'runtime' | 'bootstrap';
          connectedAt: number;
          lastSeen: number;
          snapshotRequested: boolean;
        }>;
        identityToTransport: Map<string, string>;
        onPeerLeave: (transportPeerId: string) => void;
      };
      const now = Date.now();
      routeInternals.connections.set('runtime-route', {
        transportPeerId: 'runtime-route',
        identity: { peerId: 'runtime-peer', displayName: 'Runtime Peer', joinOrder: 1 },
        purpose: 'runtime', connectedAt: now, lastSeen: now, snapshotRequested: false,
      });
      routeInternals.identityToTransport.set('runtime-peer', 'runtime-route');
      assert.equal(transport.hasRoute('runtime-peer'), true);
      const selectedRouteDiagnostic = transport.signallingDiagnostics()
        .find((family) => family.family === 'nostr');
      assert.equal(selectedRouteDiagnostic?.stage, 'route-established');
      assert.deepEqual(selectedRouteDiagnostic?.routes, [{ purpose: 'runtime', count: 1 }]);
      assert.equal(selectedRouteDiagnostic?.active, false, 'a route does not prove current rendezvous health');
      const selectedConnection = routeInternals.connections.get('runtime-route');
      let refreshDisconnects = 0;
      let refreshEvents = 0;
      transport.on('peerDisconnected', () => { refreshDisconnects += 1; });
      transport.on('signallingRefreshed', () => { refreshEvents += 1; });
      const firstRefresh = transport.refreshSignalling();
      const coalescedRefresh = transport.refreshSignalling();
      assert.strictEqual(coalescedRefresh, firstRefresh, 'concurrent refreshes were not coalesced');
      const refreshResult = await firstRefresh;
      assert.equal(refreshResult.status, 'no-sockets');
      assert.strictEqual(routeInternals.connections.get('runtime-route'), selectedConnection);
      assert.equal(routeInternals.identityToTransport.get('runtime-peer'), 'runtime-route');
      assert.equal(transport.hasRoute('runtime-peer'), true);
      assert.equal(roomLeaveCalls, 0, 'refresh tore down the allocated Trystero room');
      assert.equal(refreshDisconnects, 0, 'refresh disconnected an authenticated data route');
      assert.equal(refreshEvents, 1);
      assert.equal(
        transport.signallingDiagnostics().find((family) => family.family === 'nostr')?.lastRefresh?.status,
        'no-sockets',
      );
      const nextRefresh = transport.refreshSignalling();
      assert.notStrictEqual(nextRefresh, firstRefresh, 'completed refresh remained permanently cached');
      await nextRefresh;
      assert.equal(refreshEvents, 2);
      assert.equal(roomLeaveCalls, 0);
      assert.equal(transport.hasRoute('runtime-peer'), true);
      routeInternals.onPeerLeave('runtime-route');
      assert.equal(
        transport.signallingDiagnostics().find((family) => family.family === 'nostr')?.lastError?.phase,
        'route',
      );
      routeInternals.connections.set('bootstrap-route', {
        transportPeerId: 'bootstrap-route',
        identity: { peerId: 'bootstrap-peer', displayName: 'Bootstrap Peer', joinOrder: 2 },
        purpose: 'bootstrap', connectedAt: now, lastSeen: now, snapshotRequested: false,
      });
      routeInternals.identityToTransport.set('bootstrap-peer', 'bootstrap-route');
      routeInternals.onPeerLeave('bootstrap-route');
      assert.equal(
        transport.signallingDiagnostics().find((family) => family.family === 'nostr')?.lastError?.phase,
        'bootstrap',
      );
    } finally {
      await transport.stop();
    }
  });

  it('keeps recovery timing separate from heartbeat freshness and reconnects before the deadline', async () => {
    const { MeshTransport } = await import('../src/runtime/mesh.js');
    const identity = { peerId: 'recovering-host', displayName: 'Recovering Host', joinOrder: 0 };
    const transport = new MeshTransport({
      sessionId: 'logical-route-recovery', token: 'logical-route-recovery-token-is-long-enough',
      localPeer: { peerId: 'recovery-guest', displayName: 'Guest', joinOrder: 1 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: identity.peerId }),
      isHost: () => false,
      logicalPeerRecoveryMs: 100,
    });
    type Internals = {
      connections: Map<string, {
        transportPeerId: string;
        identity: typeof identity;
        purpose: 'runtime';
        connectedAt: number;
        lastSeen: number;
        snapshotRequested: boolean;
      }>;
      identityToTransport: Map<string, string>;
      recoveringPeers: Map<string, {
        startedAt: number;
        deadlineAt: number;
        lastHeartbeat: number;
        timer: NodeJS.Timeout;
      }>;
      relay: {
        connectedRelayCount: number;
        onFrame: () => void;
        onPeerAnnounce: () => void;
        start: () => void;
        stop: () => void;
        sendAnnounce: () => void;
        send: () => void;
      };
      onPeerLeave: (transportPeerId: string) => void;
      finishLogicalRecovery: (peerId: string) => void;
    };
    const internals = transport as unknown as Internals;
    let relaySends = 0;
    let disconnects = 0;
    transport.connect(identity);
    internals.relay = {
      connectedRelayCount: 1,
      onFrame: () => undefined,
      onPeerAnnounce: () => undefined,
      start: () => undefined,
      stop: () => undefined,
      sendAnnounce: () => { relaySends += 1; },
      send: () => { relaySends += 1; },
    };
    const lastSeen = Date.now() - 5_000;
    internals.connections.set('direct-route', {
      transportPeerId: 'direct-route', identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen, snapshotRequested: false,
    });
    internals.identityToTransport.set(identity.peerId, 'direct-route');
    transport.on('peerDisconnected', () => { disconnects += 1; });

    try {
      internals.onPeerLeave('direct-route');
      assert.equal(disconnects, 0, 'physical leave became an immediate logical disconnect');
      assert.equal(transport.isPeerRecovering(identity.peerId), true);
      const recovery = internals.recoveringPeers.get(identity.peerId);
      assert.ok(recovery);
      assert.equal(recovery.deadlineAt - recovery.startedAt, 100, 'recovery owns one explicit bounded deadline');
      assert.equal(recovery.lastHeartbeat, lastSeen, 'recovery keeps the last real route evidence');
      const recoveringPeer = transport.peerRuntime().find((peer) => peer.peerId === identity.peerId);
      assert.equal(recoveringPeer?.online, false, 'a recovering route is not displayed as online');
      assert.equal(recoveringPeer?.connectionState, 'recovering');
      assert.equal(recoveringPeer?.lastHeartbeat, lastSeen, 'recovery must not fabricate heartbeat freshness');
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(
        transport.peerRuntime().find((peer) => peer.peerId === identity.peerId)?.lastHeartbeat,
        lastSeen,
        'wall-clock time must not advance a disconnected peer heartbeat',
      );
      assert.ok(relaySends >= 2, 'relay fallback was not started immediately');

      const routed = transport.waitForRoute(identity.peerId, 100);
      internals.connections.set('relay:recovering-host', {
        transportPeerId: 'relay:recovering-host', identity, purpose: 'runtime',
        connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
      });
      internals.identityToTransport.set(identity.peerId, 'relay:recovering-host');
      internals.finishLogicalRecovery(identity.peerId);
      await routed;
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(disconnects, 0);
      assert.equal(transport.hasRoute(identity.peerId), true);
      assert.equal(transport.isPeerRecovering(identity.peerId), false);
      const logicalParticipants = transport.peerRuntime().filter((peer) => peer.peerId === identity.peerId);
      assert.equal(logicalParticipants.length, 1, 'route replacement must not duplicate the logical participant');
      assert.equal(logicalParticipants[0]?.connectionState, 'connected');
    } finally {
      await transport.stop();
    }
  });

  it('cancels terminal disconnect when authenticated recovery completes near the deadline', async () => {
    const { MeshTransport } = await import('../src/runtime/mesh.js');
    const identity = { peerId: 'near-deadline-host', displayName: 'Near Deadline Host', joinOrder: 0 };
    const transport = new MeshTransport({
      sessionId: 'logical-route-near-deadline', token: 'logical-route-near-deadline-token-is-long-enough',
      localPeer: { peerId: 'near-deadline-guest', displayName: 'Guest', joinOrder: 1 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: identity.peerId }),
      isHost: () => false,
      logicalPeerRecoveryMs: 200,
    });
    type Internals = {
      connections: Map<string, {
        transportPeerId: string; identity: typeof identity; purpose: 'runtime';
        connectedAt: number; lastSeen: number; snapshotRequested: boolean;
      }>;
      identityToTransport: Map<string, string>;
      recoveringPeers: Map<string, { deadlineAt: number }>;
      onPeerLeave: (transportPeerId: string) => void;
      finishLogicalRecovery: (peerId: string) => void;
    };
    const internals = transport as unknown as Internals;
    transport.connect(identity);
    const lastSeen = Date.now();
    internals.connections.set('near-old-route', {
      transportPeerId: 'near-old-route', identity, purpose: 'runtime',
      connectedAt: lastSeen, lastSeen, snapshotRequested: false,
    });
    internals.identityToTransport.set(identity.peerId, 'near-old-route');
    let disconnects = 0;
    transport.on('peerDisconnected', () => { disconnects += 1; });

    try {
      internals.onPeerLeave('near-old-route');
      const cycle = internals.recoveringPeers.get(identity.peerId);
      assert.ok(cycle);
      const waitMs = Math.max(0, cycle.deadlineAt - Date.now() - 50);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      internals.connections.set('near-new-route', {
        transportPeerId: 'near-new-route', identity, purpose: 'runtime',
        connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
      });
      internals.identityToTransport.set(identity.peerId, 'near-new-route');
      internals.finishLogicalRecovery(identity.peerId);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(disconnects, 0);
      assert.equal(transport.hasRoute(identity.peerId), true);
      assert.equal(transport.isPeerRecovering(identity.peerId), false);
    } finally {
      await transport.stop();
    }
  });

  it('ignores a late leave event from the retired route after replacement admission', async () => {
    const { MeshTransport } = await import('../src/runtime/mesh.js');
    const identity = { peerId: 'late-route-host', displayName: 'Late Route Host', joinOrder: 0 };
    const transport = new MeshTransport({
      sessionId: 'logical-route-late-old-event', token: 'logical-route-late-old-event-token-is-long-enough',
      localPeer: { peerId: 'late-route-guest', displayName: 'Guest', joinOrder: 1 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: identity.peerId }),
      isHost: () => false,
      logicalPeerRecoveryMs: 100,
    });
    type Internals = {
      connections: Map<string, {
        transportPeerId: string; identity: typeof identity; purpose: 'runtime';
        connectedAt: number; lastSeen: number; snapshotRequested: boolean;
      }>;
      identityToTransport: Map<string, string>;
      onPeerLeave: (transportPeerId: string) => void;
      finishLogicalRecovery: (peerId: string) => void;
    };
    const internals = transport as unknown as Internals;
    transport.connect(identity);
    internals.connections.set('late-old-route', {
      transportPeerId: 'late-old-route', identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    });
    internals.identityToTransport.set(identity.peerId, 'late-old-route');
    let disconnects = 0;
    transport.on('peerDisconnected', () => { disconnects += 1; });

    try {
      internals.onPeerLeave('late-old-route');
      internals.connections.set('late-new-route', {
        transportPeerId: 'late-new-route', identity, purpose: 'runtime',
        connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
      });
      internals.identityToTransport.set(identity.peerId, 'late-new-route');
      internals.finishLogicalRecovery(identity.peerId);

      internals.onPeerLeave('late-old-route');
      assert.equal(internals.identityToTransport.get(identity.peerId), 'late-new-route');
      assert.equal(transport.hasRoute(identity.peerId), true);
      assert.equal(transport.isPeerRecovering(identity.peerId), false);
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(disconnects, 0);
    } finally {
      await transport.stop();
    }
  });

  it('starts a fresh recovery cycle after a successful previous recovery', async () => {
    const { MeshTransport } = await import('../src/runtime/mesh.js');
    const identity = { peerId: 'repeat-recovery-host', displayName: 'Repeat Recovery Host', joinOrder: 0 };
    const transport = new MeshTransport({
      sessionId: 'logical-route-repeat-cycle', token: 'logical-route-repeat-cycle-token-is-long-enough',
      localPeer: { peerId: 'repeat-recovery-guest', displayName: 'Guest', joinOrder: 1 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: identity.peerId }),
      isHost: () => false,
      logicalPeerRecoveryMs: 40,
    });
    type Cycle = { startedAt: number; deadlineAt: number; timer: NodeJS.Timeout };
    type Internals = {
      connections: Map<string, {
        transportPeerId: string; identity: typeof identity; purpose: 'runtime';
        connectedAt: number; lastSeen: number; snapshotRequested: boolean;
      }>;
      identityToTransport: Map<string, string>;
      recoveringPeers: Map<string, Cycle>;
      onPeerLeave: (transportPeerId: string) => void;
      finishLogicalRecovery: (peerId: string) => void;
    };
    const internals = transport as unknown as Internals;
    transport.connect(identity);
    internals.connections.set('cycle-route-1', {
      transportPeerId: 'cycle-route-1', identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    });
    internals.identityToTransport.set(identity.peerId, 'cycle-route-1');
    let disconnects = 0;
    transport.on('peerDisconnected', () => { disconnects += 1; });

    try {
      internals.onPeerLeave('cycle-route-1');
      const firstCycle = internals.recoveringPeers.get(identity.peerId);
      assert.ok(firstCycle);
      internals.connections.set('cycle-route-2', {
        transportPeerId: 'cycle-route-2', identity, purpose: 'runtime',
        connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
      });
      internals.identityToTransport.set(identity.peerId, 'cycle-route-2');
      internals.finishLogicalRecovery(identity.peerId);
      assert.equal(transport.isPeerRecovering(identity.peerId), false);

      await new Promise((resolve) => setTimeout(resolve, 2));
      internals.onPeerLeave('cycle-route-2');
      const secondCycle = internals.recoveringPeers.get(identity.peerId);
      assert.ok(secondCycle);
      assert.notStrictEqual(secondCycle, firstCycle, 'a new route loss must create a fresh recovery cycle');
      assert.ok(secondCycle.deadlineAt > firstCycle.startedAt);
      await new Promise((resolve) => setTimeout(resolve, 70));
      assert.equal(disconnects, 1, 'only the second exhausted cycle becomes terminal');
      assert.equal(transport.isPeerRecovering(identity.peerId), false);
    } finally {
      await transport.stop();
    }
  });

  it('emits one logical disconnect only after every route misses the recovery lease', async () => {
    const { MeshTransport } = await import('../src/runtime/mesh.js');
    const identity = { peerId: 'lost-host', displayName: 'Lost Host', joinOrder: 0 };
    const transport = new MeshTransport({
      sessionId: 'logical-route-expiry', token: 'logical-route-expiry-token-is-long-enough',
      localPeer: { peerId: 'expiry-guest', displayName: 'Guest', joinOrder: 1 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: identity.peerId }),
      isHost: () => false,
      logicalPeerRecoveryMs: 20,
    });
    type Internals = {
      connections: Map<string, {
        transportPeerId: string;
        identity: typeof identity;
        purpose: 'runtime';
        connectedAt: number;
        lastSeen: number;
        snapshotRequested: boolean;
      }>;
      identityToTransport: Map<string, string>;
      onPeerLeave: (transportPeerId: string) => void;
    };
    const internals = transport as unknown as Internals;
    transport.connect(identity);
    internals.connections.set('direct-route', {
      transportPeerId: 'direct-route', identity, purpose: 'runtime',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: false,
    });
    internals.identityToTransport.set(identity.peerId, 'direct-route');
    let disconnects = 0;
    transport.on('peerDisconnected', () => { disconnects += 1; });

    try {
      internals.onPeerLeave('direct-route');
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(disconnects, 1);
      assert.equal(transport.isPeerRecovering(identity.peerId), false);
      assert.equal(transport.peerRuntime().some((peer) => peer.peerId === identity.peerId), false);
    } finally {
      await transport.stop();
    }
  });

  it('retires every authenticated route on an explicit peer departure', async () => {
    const { MeshTransport } = await import('../src/runtime/mesh.js');
    const { encodeFrame } = await import('../src/core/wire.js');
    const identity = { peerId: 'departing-peer', displayName: 'Departing Peer', joinOrder: 1 };
    const transport = new MeshTransport({
      sessionId: 'explicit-peer-departure', token: 'explicit-peer-departure-token-is-long-enough',
      localPeer: { peerId: 'remaining-peer', displayName: 'Remaining Peer', joinOrder: 0 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'remaining-peer' }),
      isHost: () => true,
    });
    type Internals = {
      connections: Map<string, {
        transportPeerId: string;
        identity: typeof identity;
        purpose: 'runtime';
        connectedAt: number;
        lastSeen: number;
        pingFailures: number;
        snapshotRequested: boolean;
      }>;
      identityToTransport: Map<string, string>;
      handleAction: (data: ArrayBuffer, transportPeerId: string) => void;
    };
    const internals = transport as unknown as Internals;
    const now = Date.now();
    transport.connect(identity);
    for (const transportPeerId of ['relay:departing-peer', 'direct-departing-peer']) {
      internals.connections.set(transportPeerId, {
        transportPeerId,
        identity,
        purpose: 'runtime',
        connectedAt: now,
        lastSeen: now,
        pingFailures: 0,
        snapshotRequested: false,
      });
    }
    internals.identityToTransport.set(identity.peerId, 'relay:departing-peer');
    let disconnects = 0;
    transport.on('peerDisconnected', () => { disconnects += 1; });

    try {
      const frame = encodeFrame('peerLeaving', {
        sourceId: identity.peerId,
        messageId: 'departure-frame',
        sentAt: now,
        clock: { sessionEpoch: 1, hostEpoch: 0, hostId: 'remaining-peer' },
      });
      internals.handleAction(
        frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer,
        'relay:departing-peer',
      );
      assert.equal(disconnects, 1);
      assert.equal(transport.peerRuntime().some((peer) => peer.peerId === identity.peerId), false);
      assert.equal(internals.connections.size, 0);
      assert.equal(internals.identityToTransport.has(identity.peerId), false);
    } finally {
      await transport.stop();
    }
  });

  it('publishes departure before clearing local transport routes', async () => {
    const { MeshTransport } = await import('../src/runtime/mesh.js');
    const identity = { peerId: 'stopping-peer', displayName: 'Stopping Peer', joinOrder: 1 };
    const transport = new MeshTransport({
      sessionId: 'departure-order', token: 'departure-order-token-is-long-enough',
      localPeer: { peerId: 'local-peer', displayName: 'Local Peer', joinOrder: 0 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'local-peer' }),
      isHost: () => true,
    });
    type Internals = {
      broadcast: (type: string) => string;
      awaitDrainAll: () => Promise<void>;
      connections: Map<string, unknown>;
    };
    const internals = transport as unknown as Internals;
    const observed: string[] = [];
    internals.connections.set('relay:stopping-peer', identity);
    internals.broadcast = (type) => {
      observed.push(`${type}:${internals.connections.size}`);
      return 'departure-order-frame';
    };
    internals.awaitDrainAll = async () => undefined;

    await transport.stop();

    assert.deepEqual(observed, ['peerLeaving:1']);
    assert.equal(internals.connections.size, 0);
  });

  it('leases bootstrap route recovery without exposing the joiner as a runtime participant', async () => {
    const { MeshTransport } = await import('../src/runtime/mesh.js');
    const identity = { peerId: 'joining-peer', displayName: 'Joining Peer', joinOrder: 1 };
    const transport = new MeshTransport({
      sessionId: 'bootstrap-route-expiry', token: 'bootstrap-route-expiry-token-is-long-enough',
      localPeer: { peerId: 'host', displayName: 'Host', joinOrder: 0 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'host' }),
      isHost: () => true,
      logicalPeerRecoveryMs: 20,
    });
    type Internals = {
      connections: Map<string, {
        transportPeerId: string;
        identity: typeof identity;
        purpose: 'bootstrap';
        connectedAt: number;
        lastSeen: number;
        snapshotRequested: boolean;
      }>;
      identityToTransport: Map<string, string>;
      onPeerLeave: (transportPeerId: string) => void;
    };
    const internals = transport as unknown as Internals;
    transport.connect(identity);
    internals.connections.set('bootstrap-route', {
      transportPeerId: 'bootstrap-route', identity, purpose: 'bootstrap',
      connectedAt: Date.now(), lastSeen: Date.now(), snapshotRequested: true,
    });
    internals.identityToTransport.set(identity.peerId, 'bootstrap-route');
    let bootstrapDisconnects = 0;
    let runtimeDisconnects = 0;
    transport.on('bootstrapDisconnected', () => { bootstrapDisconnects += 1; });
    transport.on('peerDisconnected', () => { runtimeDisconnects += 1; });

    try {
      internals.onPeerLeave('bootstrap-route');
      assert.equal(transport.isPeerRecovering(identity.peerId), true);
      assert.equal(bootstrapDisconnects, 0);
      assert.equal(transport.peerRuntime().some((peer) => peer.peerId === identity.peerId), false);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(bootstrapDisconnects, 1);
      assert.equal(runtimeDisconnects, 0);
      assert.equal(transport.isPeerRecovering(identity.peerId), false);
    } finally {
      await transport.stop();
    }
  });

  it('refuses to advertise a session when the guaranteed relay readiness barrier fails', async () => {
    const { MeshTransport, configureMeshNetwork } = await import('../src/runtime/mesh.js');
    const deadRoom = {
      makeAction: () => ({ onMessage: () => undefined, send: async () => undefined }),
      onPeerJoin: () => undefined,
      onPeerLeave: () => undefined,
      ping: async () => -1,
      leave: async () => undefined,
    };
    configureMeshNetwork({
      relayFactory: () => ({
        connectedRelayCount: 0,
        onFrame: () => undefined,
        onPeerAnnounce: () => undefined,
        start: () => undefined,
        stop: () => undefined,
        waitUntilReady: async () => { throw new Error('no common WSS path'); },
        sendAnnounce: () => undefined,
        send: () => undefined,
      }),
    });
    const transport = new MeshTransport({
      sessionId: 'relay-readiness', token: 'relay-readiness-token-that-is-long-enough',
      localPeer: { peerId: 'ready-host', displayName: 'Host', joinOrder: 0 },
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'ready-host' }),
      isHost: () => true,
      roomFactory: () => deadRoom as never,
    });
    try {
      await assert.rejects(
        transport.start(),
        /Guaranteed emergency relay readiness failed: no common WSS path/,
      );
    } finally {
      await transport.stop();
      configureMeshNetwork({});
    }
  });

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

  it('replays the local relay proof after one-sided admission', async () => {
    const { MeshTransport } = await import('../src/runtime/mesh.js');
    const clock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'a-host' };
    const host = new MeshTransport({
      sessionId: 'relay-proof-replay', token: 'relay-proof-replay-token-that-is-long-enough',
      localPeer: { peerId: 'a-host', displayName: 'Host', joinOrder: 0 },
      hostClock: () => clock, isHost: () => true,
    });
    const guest = new MeshTransport({
      sessionId: 'relay-proof-replay', token: 'relay-proof-replay-token-that-is-long-enough',
      localPeer: { peerId: 'z-guest', displayName: 'Guest', joinOrder: 1 },
      hostClock: () => clock, isHost: () => false,
    });
    type Handshake = {
      peer: { peerId: string; displayName: string; joinOrder: number; identityKey?: string | undefined };
    };
    type Negotiation = { localHs: Handshake; localProof?: unknown; timeout: NodeJS.Timeout };
    type RelayInternals = {
      relay: unknown;
      localHandshake: () => Handshake;
      considerRelayFallback: (peerId: string) => void;
      createSignedRelayEnvelope: (peerId: string, payload: Record<string, unknown>) => Buffer;
      handleRelayData: (peerId: string, bytes: Buffer) => void;
      relayNegotiations: Map<string, Negotiation>;
    };
    const hostInternals = host as unknown as RelayInternals;
    const guestInternals = guest as unknown as RelayInternals;
    const hostSends: Buffer[] = [];
    const fakeRelay = (sends: Buffer[]) => ({
      connectedRelayCount: 1,
      onFrame: () => undefined,
      onPeerAnnounce: () => undefined,
      start: () => undefined,
      stop: () => undefined,
      sendAnnounce: () => undefined,
      send: (bytes: Buffer) => sends.push(Buffer.from(bytes)),
    });
    const relayKind = (bytes: Buffer): string | undefined => {
      const envelope = JSON.parse(bytes.toString('utf8')) as { payload?: { k?: string } };
      return envelope.payload?.k;
    };
    hostInternals.relay = fakeRelay(hostSends);
    guestInternals.relay = fakeRelay([]);
    host.connect(guestInternals.localHandshake().peer);
    guest.connect(hostInternals.localHandshake().peer);

    try {
      hostInternals.considerRelayFallback('z-guest');
      guestInternals.considerRelayFallback('a-host');
      const hostNegotiation = hostInternals.relayNegotiations.get('z-guest');
      const guestNegotiation = guestInternals.relayNegotiations.get('a-host');
      assert.ok(hostNegotiation);
      assert.ok(guestNegotiation);
      hostInternals.handleRelayData('z-guest', guestInternals.createSignedRelayEnvelope('a-host', {
        k: 'hs', hs: guestNegotiation.localHs,
      }));
      guestInternals.handleRelayData('a-host', hostInternals.createSignedRelayEnvelope('z-guest', {
        k: 'hs', hs: hostNegotiation.localHs,
      }));
      assert.ok(hostNegotiation?.localProof);
      assert.ok(guestNegotiation?.localProof);
      const proofsBeforeAdmission = hostSends.filter((bytes) => relayKind(bytes) === 'pr').length;

      // Guest's proof reaches Host, but Host's first proof is deliberately not
      // delivered. Host admission must emit one authenticated replay.
      hostInternals.handleRelayData('z-guest', guestInternals.createSignedRelayEnvelope('a-host', {
        k: 'pr', pr: guestNegotiation.localProof,
      }));
      assert.equal(host.hasRoute('z-guest'), true);
      const proofSends = hostSends.filter((bytes) => relayKind(bytes) === 'pr');
      assert.equal(proofSends.length, proofsBeforeAdmission + 1);

      const replay = proofSends.at(-1);
      assert.ok(replay);
      guestInternals.handleRelayData('a-host', replay);
      assert.equal(guest.hasRoute('a-host'), true);
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

  it('bounds unknown relay candidates without blocking a known friend', async () => {
    const { MeshTransport } = await import('../src/runtime/mesh.js');
    const clock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'a-host' };
    const transport = new MeshTransport({
      sessionId: 'bounded-relay-candidates', token: 'bounded-relay-token-that-is-long-enough',
      localPeer: { peerId: 'a-host', displayName: 'Host', joinOrder: 0 },
      hostClock: () => clock, isHost: () => true,
    });
    type RelayInternals = {
      relay: unknown;
      relayAttempts: Map<string, number>;
      relayNegotiations: Map<string, unknown>;
      considerRelayFallback: (peerId: string) => void;
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

    try {
      for (let index = 0; index < 300; index += 1) {
        internals.considerRelayFallback(`unknown-${index}`);
      }
      const unknownAttempts = [...internals.relayAttempts.keys()]
        .filter((peerId) => peerId.startsWith('unknown-'));
      assert.equal(unknownAttempts.length, 256);
      assert.equal(internals.relayNegotiations.size, 256);

      transport.connect({ peerId: 'known-friend', displayName: 'Known Friend', joinOrder: 1 });
      internals.considerRelayFallback('known-friend');
      assert.equal(internals.relayAttempts.has('known-friend'), true);
      assert.equal(internals.relayNegotiations.has('known-friend'), true);
      assert.equal(sends, 257);
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
      createSignedRelayEnvelope: (peerId: string, payload: Record<string, unknown>) => Buffer;
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
      localInternals.handleRelayData('z-guest', remoteInternals.createSignedRelayEnvelope('a-host', {
        k: 'hs', hs: remoteInternals.localHandshake(),
      }));
      const failedNonce = localInternals.relayNegotiations.get('z-guest')?.localHs.nonce;
      assert.ok(failedNonce);
      localInternals.handleRelayData('z-guest', remoteInternals.createSignedRelayEnvelope('a-host', {
        k: 'pr', pr: { version: 5, signature: Buffer.alloc(64).toString('base64') },
      }));
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

  it('ignores a delayed proof from an older relay transcript without rejecting the peer', async () => {
    const { MeshTransport } = await import('../src/runtime/mesh.js');
    const clock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'a-host' };
    const local = new MeshTransport({
      sessionId: 'relay-stale-proof', token: 'relay-stale-proof-token-that-is-long-enough',
      localPeer: { peerId: 'a-host', displayName: 'Host', joinOrder: 0 },
      hostClock: () => clock, isHost: () => true,
    });
    const remote = new MeshTransport({
      sessionId: 'relay-stale-proof', token: 'relay-stale-proof-token-that-is-long-enough',
      localPeer: { peerId: 'z-guest', displayName: 'Guest', joinOrder: 1 },
      hostClock: () => clock, isHost: () => false,
    });
    type Negotiation = { localHs: { nonce: string }; remoteProof?: unknown; timeout: NodeJS.Timeout };
    type RelayInternals = {
      relay: unknown;
      localHandshake: () => unknown;
      createSignedRelayEnvelope: (peerId: string, payload: Record<string, unknown>) => Buffer;
      handleRelayData: (peerId: string, bytes: Buffer) => void;
      relayNegotiations: Map<string, Negotiation>;
    };
    const localInternals = local as unknown as RelayInternals;
    const remoteInternals = remote as unknown as RelayInternals;
    localInternals.relay = {
      connectedRelayCount: 1,
      onFrame: () => undefined,
      onPeerAnnounce: () => undefined,
      start: () => undefined,
      stop: () => undefined,
      sendAnnounce: () => undefined,
      send: () => undefined,
    };
    local.connect({ peerId: 'z-guest', displayName: 'Guest', joinOrder: 1 });
    const errors: Error[] = [];
    local.on('connectionError', (_peer, error: Error) => errors.push(error));

    try {
      localInternals.handleRelayData('z-guest', remoteInternals.createSignedRelayEnvelope('a-host', {
        k: 'hs', hs: remoteInternals.localHandshake(),
      }));
      const negotiation = localInternals.relayNegotiations.get('z-guest');
      assert.ok(negotiation);
      localInternals.handleRelayData('z-guest', remoteInternals.createSignedRelayEnvelope('a-host', {
        k: 'pr',
        pr: {
          version: 5,
          signature: Buffer.alloc(64).toString('base64'),
          transcriptId: '0'.repeat(64),
        },
      }));

      assert.equal(errors.length, 0);
      assert.equal(localInternals.relayNegotiations.get('z-guest'), negotiation);
      assert.equal(negotiation.remoteProof, undefined);
    } finally {
      await local.stop();
      await remote.stop();
    }
  });

  it('authenticates and deduplicates every emergency relay envelope', async () => {
    const { MeshTransport } = await import('../src/runtime/mesh.js');
    const clock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'a-host' };
    const local = new MeshTransport({
      sessionId: 'signed-relay', token: 'signed-relay-token-that-is-long-enough',
      localPeer: { peerId: 'a-host', displayName: 'Host', joinOrder: 0 },
      hostClock: () => clock, isHost: () => true,
    });
    const remote = new MeshTransport({
      sessionId: 'signed-relay', token: 'signed-relay-token-that-is-long-enough',
      localPeer: { peerId: 'z-guest', displayName: 'Guest', joinOrder: 1 },
      hostClock: () => clock, isHost: () => false,
    });
    type Handshake = { peer: { peerId: string; displayName: string; joinOrder: number; identityKey?: string } };
    type RelayInternals = {
      localHandshake: () => Handshake;
      createFrame: (type: string, meta: Record<string, unknown>, payload: Uint8Array) => Buffer;
      createSignedRelayEnvelope: (
        peerId: string,
        payload: Record<string, unknown>,
        sentAt?: number,
      ) => Buffer;
      handleRelayData: (peerId: string, bytes: Buffer) => void;
      connections: Map<string, unknown>;
      identityToTransport: Map<string, string>;
      seenRelayEnvelopes: Map<string, number>;
    };
    const localInternals = local as unknown as RelayInternals;
    const remoteInternals = remote as unknown as RelayInternals;
    const remoteIdentity = remoteInternals.localHandshake().peer;
    local.connect(remoteIdentity);
    localInternals.connections.set('relay:z-guest', {
      transportPeerId: 'relay:z-guest',
      identity: remoteIdentity,
      purpose: 'runtime',
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      snapshotRequested: false,
    });
    localInternals.identityToTransport.set('z-guest', 'relay:z-guest');

    const received: Buffer[] = [];
    local.on('message', (frame: { type: string; payload: Uint8Array }) => {
      if (frame.type === 'probePing') received.push(Buffer.from(frame.payload));
    });
    const frame = remoteInternals.createFrame(
      'probePing',
      { messageId: 'signed-relay-frame' },
      Buffer.from('authenticated'),
    );
    const payload = { k: 'fr', d: frame.toString('base64') };

    try {
      const valid = remoteInternals.createSignedRelayEnvelope('a-host', payload);
      localInternals.handleRelayData('z-guest', valid);
      assert.deepEqual(received.map((item) => item.toString('utf8')), ['authenticated']);
      assert.equal(localInternals.seenRelayEnvelopes.size, 1);

      localInternals.handleRelayData('z-guest', valid);
      assert.equal(localInternals.seenRelayEnvelopes.size, 1, 'a captured signed envelope is deduplicated');
      assert.equal(received.length, 1);

      localInternals.handleRelayData('z-guest', Buffer.from(JSON.stringify(payload)));
      assert.equal(localInternals.seenRelayEnvelopes.size, 1, 'unsigned relay input is ignored');

      const modified = JSON.parse(valid.toString('utf8')) as { payload: Record<string, unknown> };
      modified.payload = { k: 'up' };
      localInternals.handleRelayData('z-guest', Buffer.from(JSON.stringify(modified)));
      assert.equal(localInternals.seenRelayEnvelopes.size, 1, 'modified signed content is ignored');

      const wrongTarget = remoteInternals.createSignedRelayEnvelope('another-peer', payload);
      localInternals.handleRelayData('z-guest', wrongTarget);
      assert.equal(localInternals.seenRelayEnvelopes.size, 1, 'an envelope for another identity is ignored');

      const stale = remoteInternals.createSignedRelayEnvelope('a-host', payload, Date.now() - 11 * 60_000);
      localInternals.handleRelayData('z-guest', stale);
      const future = remoteInternals.createSignedRelayEnvelope('a-host', payload, Date.now() + 3 * 60_000);
      localInternals.handleRelayData('z-guest', future);
      assert.equal(localInternals.seenRelayEnvelopes.size, 1, 'stale and future envelopes are ignored');
      assert.equal(received.length, 1);
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
            if (client.readyState === 1) client.send(JSON.stringify(['EVENT', 'sub', message[1]]));
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
