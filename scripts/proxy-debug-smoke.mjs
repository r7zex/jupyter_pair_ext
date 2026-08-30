import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.DEBUG = '*';
process.env.DEBUG_SHOW_HIDDEN = 'true';

const captured = [];
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk) => {
  captured.push(String(chunk));
  return true;
};

const marker = 'sec012-debug-canary';
const encodedMarker = Buffer.from('alice:' + marker).toString('base64');

try {
  const debug = require('debug');
  const { inspectExplicitProxyUrl } = require('../out/src/runtime/proxy.js');
  const { createProxyAgent } = require('../out/src/runtime/proxyWebSocket.js');

  const explicit = inspectExplicitProxyUrl('http://alice@proxy.local:3128');
  if (!explicit) throw new Error('could not prepare explicit proxy fixture');
  const httpsAgent = createProxyAgent('wss://nos.lol', {
    explicitProxy: explicit.proxyUrl,
    explicitProxyPassword: { binding: explicit.binding, password: marker },
    env: {},
  });
  const httpAgent = createProxyAgent('ws://relay.example', {
    env: { HTTP_PROXY: 'http://alice:' + marker + '@proxy.local:3128' },
  });
  const socksAgent = createProxyAgent('wss://nos.lol', {
    env: { ALL_PROXY: 'socks5h://alice:' + marker + '@127.0.0.1:1' },
  });
  if (!httpsAgent || !httpAgent || !socksAgent) throw new Error('could not create proxy fixtures');

  for (const resolved of [httpsAgent, httpAgent]) {
    const href = resolved.agent.proxy?.href ?? '';
    if (href.includes(marker) || href.includes('alice@')) {
      throw new Error('HTTP proxy agent retained credentials in its URL');
    }
  }

  try {
    await socksAgent.agent.connect(
      { destroy() {} },
      { host: 'example.test', port: 443, secureEndpoint: false },
    );
  } catch {
    // The local port is intentionally closed; only the dependency debug path matters.
  }

  const output = captured.join('');
  if (output.includes(marker) || output.includes(encodedMarker)) {
    throw new Error('proxy credential reached dependency DEBUG output');
  }
  for (const namespace of ['http-proxy-agent', 'https-proxy-agent', 'socks-proxy-agent']) {
    if (debug.enabled(namespace)) throw new Error('sensitive DEBUG namespace remains enabled: ' + namespace);
  }
} finally {
  process.stderr.write = originalStderrWrite;
}

console.log('proxy DEBUG redaction: passed');
