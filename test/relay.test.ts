import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it, before, after } from 'mocha';

describe('emergency Nostr data relay', function () {
  this.timeout(20_000);

  let hub: import('ws').WebSocketServer;
  let hubPort = 0;
  let seenEvents: unknown[][] = [];
  let NostrFrameRelayCtor: typeof import('../src/runtime/nostrRelay.js').NostrFrameRelay;

  before(async () => {
    const { WebSocketServer } = await import('ws');
    ({ NostrFrameRelay: NostrFrameRelayCtor } = await import('../src/runtime/nostrRelay.js'));
    hub = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => hub.on('listening', resolve));
    hubPort = (hub.address() as { port: number }).port;
    hub.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as unknown[];
        if (message[0] === 'EVENT') {
          seenEvents.push(message);
          for (const client of hub.clients) {
            if (client !== socket && client.readyState === 1) client.send(JSON.stringify(message));
          }
        }
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => hub.close(() => resolve()));
  });

  function buildRelay(localPeerId: string): import('../src/runtime/nostrRelay.js').NostrFrameRelay {
    return new NostrFrameRelayCtor({
      token: 'shared-token-that-is-long-enough',
      sessionId: 'relay-test',
      localPeerId,
      relays: [`ws://127.0.0.1:${hubPort}`],
    });
  }

  it('delivers frames between two peers through a Nostr-style hub', async () => {
    const a = buildRelay('peer-a');
    const b = buildRelay('peer-b');
    const receivedAtB: Buffer[] = [];
    b.onFrame = (_from, bytes) => receivedAtB.push(Buffer.from(bytes));
    a.start();
    b.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const payload = Buffer.from('hello-over-nostr');
    a.send(payload, 'peer-b');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(receivedAtB.length, 1);
    assert.ok(receivedAtB[0].equals(payload));
    a.stop();
    b.stop();
  });

  it('chunks and reassembles large payloads', async () => {
    const a = buildRelay('big-a');
    const b = buildRelay('big-b');
    const received: Buffer[] = [];
    b.onFrame = (_from, bytes) => received.push(Buffer.from(bytes));
    a.start();
    b.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const payload = randomBytes(100_000); // spans several 32 KiB chunks
    a.send(payload);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(received.length, 1);
    assert.ok(received[0].equals(payload));
    a.stop();
    b.stop();
  });

  it('keeps payloads opaque: the hub never sees plaintext', async () => {
    seenEvents = [];
    const needle = 'TOPSECRET-PLAINTEXT-MARKER';
    const a = buildRelay('sec-a');
    a.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    a.send(Buffer.from(needle), 'someone');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(seenEvents.length > 0, 'hub should have observed events');
    assert.ok(!JSON.stringify(seenEvents).includes(needle));
    a.stop();
  });

  it('drops packets encrypted with a different session key', async () => {
    const a = buildRelay('key-a');
    // Same ids but a different token -> different derived key.
    const b = new NostrFrameRelayCtor({
      token: 'a-totally-different-token-value!!',
      sessionId: 'relay-test',
      localPeerId: 'key-b',
      relays: [`ws://127.0.0.1:${hubPort}`],
    });
    const received: Buffer[] = [];
    b.onFrame = (_from, bytes) => received.push(Buffer.from(bytes));
    a.start();
    b.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    a.send(Buffer.from('must-not-arrive'), 'key-b');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(received.length, 0);
    a.stop();
    b.stop();
  });
});
