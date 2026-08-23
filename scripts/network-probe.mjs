#!/usr/bin/env node
/**
 * Real-network reachability probe for every external service Pair Notebook
 * depends on. Run from any machine whose network situation matters, e.g.:
 *
 *   node scripts/network-probe.mjs
 *
 * Checks per Nostr relay: DNS resolution, TCP connect, TLS handshake,
 * WebSocket upgrade. Also performs a real STUN Binding over UDP against
 * Google/Cloudflare and a real TURN Allocate over UDP/TCP/TLS.
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

const TURN_USERNAME = process.env.TURN_USERNAME ?? 'openrelayproject';
const TURN_PASSWORD = process.env.TURN_PASSWORD ?? 'openrelayproject';
const TURN_ENDPOINTS = [
  { label: 'TURN-UDP-80', host: 'openrelay.metered.ca', port: 80, transport: 'udp' },
  { label: 'TURN-TCP-443', host: 'openrelay.metered.ca', port: 443, transport: 'tcp' },
  { label: 'TURN-TLS-443', host: 'openrelay.metered.ca', port: 443, transport: 'tls' },
];
const STUN_SERVERS = [
  { label: 'Google STUN 1', host: 'stun.l.google.com', port: 19302 },
  { label: 'Google STUN 2', host: 'stun1.l.google.com', port: 19302 },
  { label: 'Cloudflare STUN', host: 'stun.cloudflare.com', port: 3478 },
];

const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 8000);

// werift's TURN client can surface socket resets as library-internal
// unhandled rejections when a relay is unreachable; report them, don't crash.
process.on('unhandledRejection', (reason) => {
  console.log(`BACKGROUND-ERROR ${(reason as Error)?.stack ?? String(reason)}`);
});

function withTimeout(promise, ms, label) {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      // Prevent an unhandled rejection if the underlying op settles later.
      promise.catch(() => {});
      reject(new Error(`${label}: timeout after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]);
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
    const finish = (ok, error) => {
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
    const finish = (ok, error) => {
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
    // STUN Binding Request: type 0x0001, length 0, magic cookie, 12-byte id.
    const transactionId = crypto.randomBytes(12);
    const message = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x00, 0x00]),
      Buffer.from([0x21, 0x12, 0xa4, 0x42]),
      transactionId,
    ]);
    const finish = (ok, detail) => {
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
  try {
    const { createTurnClient } = await import('werift');
    const started = performance.now();
    await withTimeout((async () => {
      const client = await createTurnClient(
        { address: [host, port], username: TURN_USERNAME, password: TURN_PASSWORD },
        { transport, lifetime: 600 },
      );
      await client.connectionMade();
      if (!client.relayedAddress) throw new Error('no relayed address');
      await client.close();
    })(), TIMEOUT_MS, label);
    return { label, ok: true, detail: 'Allocate + auth OK', ms: Math.round(performance.now() - started) };
  } catch (error) {
    const code = error?.code ? ` [${error.code}]` : '';
    return { label, ok: false, detail: `${error?.name ?? 'Error'}${code}: ${error?.message ?? String(error)}` };
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
for (const endpoint of TURN_ENDPOINTS) {
  const result = await checkTurnAllocate(endpoint);
  console.log(`${result.label} ${endpoint.host}:${endpoint.port}: ${result.ok ? 'OK' : 'FAIL'} ${result.detail}${result.ms ? ` (${result.ms}ms)` : ''}`);
}
