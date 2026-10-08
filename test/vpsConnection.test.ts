import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { VpsClient, VpsHttpError } from '../src/vps/client';
import { VpsFrameRelay } from '../src/runtime/vpsFrameRelay';
import { installProxyAwareWebSocket } from '../src/runtime/proxyWebSocket';

describe('VPS connection deadlines, redirects and proxy failure regressions', () => {
  const servers: http.Server[] = [];
  beforeEach(() => installProxyAwareWebSocket({ env: {} }));
  afterEach(async () => {
    installProxyAwareWebSocket({ env: {} });
    for (const server of servers.splice(0)) {
      server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  async function serve(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  it('bounds the whole response even when a server keeps sending bytes', async () => {
    const endpoint = await serve((_request, response) => {
      response.writeHead(200); response.write('[');
      const timer = setInterval(() => response.write(' '), 10);
      response.once('close', () => clearInterval(timer));
    });
    const started = Date.now();
    await assert.rejects(new VpsClient(endpoint, 'a'.repeat(32), 150).jobs(), /timed out/);
    assert.ok(Date.now() - started < 1000, 'An inactivity timeout alone would hang on the drip');
  });
  it('never follows a redirect or forwards the team credential to its target', async () => {
    let redirected = 0;
    const target = await serve((_request, response) => { redirected++; response.end('[]'); });
    const endpoint = await serve((_request, response) => { response.writeHead(302, { location: target }); response.end('redirect'); });
    await assert.rejects(new VpsClient(endpoint, 'a'.repeat(32)).jobs(), (error: Error) => error instanceof VpsHttpError && error.status === 302);
    assert.equal(redirected, 0);
  });
  it('rejects interrupted and malformed responses without reporting private transport details', async () => {
    const malformed = await serve((_request, response) => response.end('invalid-json'));
    await assert.rejects(new VpsClient(malformed, 'a'.repeat(32)).jobs(), /invalid JSON/);
    const interrupted = await serve((_request, response) => { response.writeHead(200, { 'content-length': 999 }); response.write('['); response.flushHeaders(); setImmediate(() => response.destroy()); });
    await assert.rejects(new VpsClient(interrupted, 'a'.repeat(32)).jobs());
  });
  it('does not bypass a configured proxy when its credential configuration is invalid', async () => {
    let requests = 0;
    const endpoint = await serve((_request, response) => { requests++; response.end('[]'); });
    installProxyAwareWebSocket({ explicitProxy: 'http://private-user:private-secret@proxy.example:8080', env: {} });
    await assert.rejects(new VpsClient(endpoint, 'a'.repeat(32)).jobs(), (error: Error) => {
      assert.doesNotMatch(error.message, /private-user|private-secret/); return true;
    });
    const relay = new VpsFrameRelay({ sessionId: 'proxy-test', token: 'invite', localPeerId: 'peer', vps: { url: endpoint, token: 'a'.repeat(32) } });
    try { assert.throws(() => relay.start()); } finally { relay.stop(); }
    assert.equal(requests, 0);
  });
  it('retries a socket-factory error during reconnect without throwing from the timer', async () => {
    class Socket extends EventEmitter {
      public readyState = WebSocket.OPEN; public bufferedAmount = 0;
      public send(bytes: string): void { if (JSON.parse(bytes).t === 'probe') setImmediate(() => this.emit('message', bytes)); }
      public terminate(): void { this.emit('close'); }
    }
    let calls = 0; const initial = new Socket();
    const relay = new VpsFrameRelay({ sessionId: 'reconnect', token: 'invite', localPeerId: 'peer', vps: { url: 'http://localhost:9999', token: 'a'.repeat(32) },
      socketFactory: () => {
        calls++; if (calls === 1) return initial as unknown as WebSocket;
        if (calls === 2) throw new Error('Transient proxy configuration failure');
        const socket = new Socket(); setImmediate(() => socket.emit('open')); return socket as unknown as WebSocket;
      } });
    try { relay.start(); initial.emit('close'); await relay.waitUntilReady(5500); assert.equal(calls, 3); }
    finally { relay.stop(); }
  });
});
