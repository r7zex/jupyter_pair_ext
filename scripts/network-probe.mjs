#!/usr/bin/env node
/**
 * Real-network reachability probe for every external service Pair Notebook
 * depends on. Run from any machine whose network situation matters, e.g.:
 *
 *   node scripts/network-probe.mjs
 *
 * Checks per Nostr relay: DNS resolution, TCP connect, TLS handshake,
 * WebSocket upgrade. Also performs a real STUN Binding over UDP against
 * Google/Cloudflare. When TURN_URLS is explicitly configured, it also runs a
 * real TURN Allocate over the requested UDP/TCP/TLS endpoints, for example:
 *
 *   TURN_URLS=turn:relay.example.com:3478,turns:relay.example.com:5349 \
 *   TURN_USERNAME=user TURN_PASSWORD=secret node scripts/network-probe.mjs
 * Results are printed per endpoint; never report a category as working
 * because one endpoint responded.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

const RELAYS = process.env.PAIR_NOTEBOOK_RELAYS?.split(',') ?? [
  'wss://nos.lol',
  'wss://relay.sigit.io',
  'wss://nostr.mom',
  'wss://relay.damus.io',
  'wss://nostr.data.haus',
  'wss://nostr.sathoarder.com',
  'wss://relay.primal.net',
  'wss://nostr.oxtr.dev',
  'wss://relay.orangepill.dev',
  'wss://offchain.pub',
];

const TURN_USERNAME = process.env.TURN_USERNAME ?? '';
const TURN_PASSWORD = process.env.TURN_PASSWORD ?? '';
const TURN_ENDPOINTS = (process.env.TURN_URLS ?? '')
  .split(',')
  .map((value) => parseTurnEndpoint(value))
  .filter(Boolean);
const STUN_SERVERS = [
  { label: 'Google STUN 1', host: 'stun.l.google.com', port: 19302 },
  { label: 'Google STUN 2', host: 'stun1.l.google.com', port: 19302 },
  { label: 'Cloudflare STUN', host: 'stun.cloudflare.com', port: 3478 },
];

const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 8000);

// werift's TURN client can surface socket resets as library-internal
// unhandled rejections when a relay is unreachable; report them, don't crash.
process.on('unhandledRejection', (reason) => {
  const detail = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  console.log(`BACKGROUND-ERROR ${detail}`);
});

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      promise.catch(() => {});
      reject(new Error(`${label}: timeout after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function parseTurnEndpoint(rawValue) {
  const raw = rawValue.trim();
  if (!raw) return undefined;
  const match = /^(turn|turns):(?:\/\/)?(\[[^\]]+\]|[^:/?#]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/i.exec(raw);
  if (!match) throw new Error(`Invalid TURN_URLS endpoint: ${raw}`);
  const scheme = match[1].toLowerCase();
  const host = match[2].replace(/^\[|\]$/g, '');
  const port = match[3] ? Number(match[3]) : scheme === 'turns' ? 5349 : 3478;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid TURN_URLS port: ${raw}`);
  }
  const transport = scheme === 'turns' ? 'tls' : (match[4]?.toLowerCase() ?? 'udp');
  return {
    label: `TURN-${transport.toUpperCase()}-${port}`,
    host,
    port,
    transport,
  };
}

async function checkDns(host) {
  const started = performance.now();
  const addresses = await withTimeout(dns.lookup(host, { all: true }), TIMEOUT_MS, 'dns');
  const v4 = addresses.filter((a) => a.family === 4).map((a) => a.address);
  const v6 = addresses.filter((a) => a.family === 6).map((a) => a.address);
  return {
    ok: addresses.length > 0,
    detail: `${v4.length} IPv4 (${v4[0] ?? '-'}), ${v6.length} IPv6 (${v6[0] ?? '-'})`,
    ms: Math.round(performance.now() - started),
  };
}

function checkTcp(host, port) {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, error, ms: Math.round(performance.now() - started) });
    };
    socket.setTimeout(TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'tcp connect timeout'));
    socket.once('error', (error) => finish(false, error.message));
  });
}

function checkTls(host, port, servername) {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = tls.connect({ host, port, servername: servername ?? host, rejectUnauthorized: true });
    let settled = false;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, error, ms: Math.round(performance.now() - started) });
    };
    socket.setTimeout(TIMEOUT_MS);
    socket.once('secureConnect', () => finish(true));
    socket.once('timeout', () => finish(false, 'tls handshake timeout'));
    socket.once('error', (error) => finish(false, error.message));
  });
}

async function checkWebSocketUpgrade(url) {
  try {
    const { WebSocket } = await import('ws');
    const started = performance.now();
    const ws = new WebSocket(url);
    const result = await withTimeout(new Promise((resolve) => {
      ws.once('open', () => resolve({ ok: true }));
      ws.once('error', (error) => resolve({ ok: false, error: error.message }));
    }), TIMEOUT_MS, 'websocket');
    ws.close();
    return { ...result, ms: Math.round(performance.now() - started) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function checkStunBinding(host, port) {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = dgram.createSocket('udp4');
    let settled = false;
    // STUN Binding Request: type 0x0001, length 0, magic cookie, 12-byte id.
    const transactionId = crypto.randomBytes(12);
    const message = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x00, 0x00]),
      Buffer.from([0x21, 0x12, 0xa4, 0x42]),
      transactionId,
    ]);
    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      socket.close();
      resolve({ ok, detail, ms: Math.round(performance.now() - started) });
    };
    const timer = setTimeout(() => finish(false, 'STUN binding timeout'), TIMEOUT_MS);
    socket.on('message', (data) => {
      clearTimeout(timer);
      const type = data.readUInt16BE(0);
      const matchesTxid = data.subarray(8, 20).equals(transactionId);
      if (type === 0x0101 && matchesTxid) finish(true, `Binding success, ${data.length} bytes`);
      else finish(false, `unexpected response type ${type.toString(16)}`);
    });
    socket.send(message, port, host, (error) => {
      if (error) { clearTimeout(timer); finish(false, error.message); }
    });
  });
}

async function checkTurnAllocate({ label, host, port, transport }) {
  let client;
  try {
    const { createTurnClient } = await import('werift');
    const started = performance.now();
    await withTimeout((async () => {
      client = await createTurnClient(
        { address: [host, port], username: TURN_USERNAME, password: TURN_PASSWORD },
        { transport, lifetime: 600 },
      );
      await client.connectionMade();
      if (!client.relayedAddress) throw new Error('no relayed address');
    })(), TIMEOUT_MS, label);
    return { label, ok: true, detail: 'Allocate + auth OK', ms: Math.round(performance.now() - started) };
  } catch (error) {
    const code = error?.code ? ` [${error.code}]` : '';
    return { label, ok: false, detail: `${error?.name ?? 'Error'}${code}: ${error?.message ?? String(error)}` };
  } finally {
    try { await client?.close(); } catch { /* best-effort cleanup */ }
  }
}

console.log(`Pair Notebook network probe @ ${new Date().toISOString()}`);
for (const relay of RELAYS) {
  const url = new URL(relay);
  const host = url.hostname;
  const port = Number(url.port || 443);
  const dnsResult = await checkDns(host).catch((error) => ({ ok: false, detail: error.message }));
  if (!dnsResult.ok) {
    console.log(`RELAY ${relay}\n  DNS: FAIL ${dnsResult.detail ?? ''}`);
    continue;
  }
  const tcpResult = await checkTcp(host, port);
  const tlsResult = tcpResult.ok ? await checkTls(host, port) : { ok: false, error: 'skipped (tcp failed)' };
  const wsResult = tlsResult.ok ? await checkWebSocketUpgrade(relay) : { ok: false, error: 'skipped (tls failed)' };
  console.log(
    `RELAY ${relay}\n`
    + `  DNS: OK ${dnsResult.detail} (${dnsResult.ms}ms)\n`
    + `  TCP ${port}: ${tcpResult.ok ? 'OK' : 'FAIL'}${tcpResult.error ? ` ${tcpResult.error}` : ''}${tcpResult.ms ? ` (${tcpResult.ms}ms)` : ''}\n`
    + `  TLS: ${tlsResult.ok ? 'OK' : 'FAIL'}${tlsResult.error ? ` ${tlsResult.error}` : ''}${tlsResult.ms ? ` (${tlsResult.ms}ms)` : ''}\n`
    + `  WSS upgrade: ${wsResult.ok ? 'OK' : 'FAIL'}${wsResult.error ? ` ${wsResult.error}` : ''}${wsResult.ms ? ` (${wsResult.ms}ms)` : ''}`,
  );
}
for (const stun of STUN_SERVERS) {
  const result = await checkStunBinding(stun.host, stun.port);
  console.log(`STUN ${stun.label} ${stun.host}:${stun.port}: ${result.ok ? 'OK' : 'FAIL'} ${result.detail ?? result.error ?? ''} (${result.ms}ms)`);
}
if (TURN_ENDPOINTS.length === 0) {
  console.log('TURN: SKIPPED (not configured; set TURN_URLS and credentials to probe a trusted service)');
} else {
  for (const endpoint of TURN_ENDPOINTS) {
    const result = await checkTurnAllocate(endpoint);
    console.log(`${result.label} ${endpoint.host}:${endpoint.port}: ${result.ok ? 'OK' : 'FAIL'} ${result.detail}${result.ms ? ` (${result.ms}ms)` : ''}`);
  }
}
