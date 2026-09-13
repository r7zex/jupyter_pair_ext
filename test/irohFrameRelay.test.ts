import assert from 'node:assert/strict';
import { createPublicKey } from 'node:crypto';
import type { Endpoint } from '@number0/iroh/index';
import { generateIdentityCredentials } from '../src/core/identity';
import { IrohFrameRelay, irohIdentityBytes } from '../src/runtime/irohFrameRelay';
import type { PeerIdentity } from '../src/core/types';

const token = 'iroh-test-session-token-that-is-long-enough';

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(check(), 'Iroh test did not reach the expected state');
}

function fixture() {
  const endpoints = new Map<string, Endpoint>();
  const hostIdentity = generateIdentityCredentials();
  const guestIdentity = generateIdentityCredentials();
  const host: PeerIdentity = { peerId: 'host', displayName: 'Host', joinOrder: 0, identityKey: hostIdentity.publicKey };
  const guest: PeerIdentity = { peerId: 'guest', displayName: 'Guest', joinOrder: 1, identityKey: guestIdentity.publicKey };
  const make = (peer: PeerIdentity, privateKey: string, selectedToken = token, peers: PeerIdentity[] = []) => new IrohFrameRelay({
    token: selectedToken, sessionId: 'iroh-test', localPeerId: peer.peerId, identityPrivateKey: privateKey, peers,
    bindEndpoint: async (iroh, key, alpn) => {
      const builder = iroh.Endpoint.builder();
      builder.applyMinimal();
      builder.secretKey(key);
      builder.alpns([alpn]);
      builder.bindAddr('127.0.0.1:0');
      const endpoint = await builder.bind();
      endpoints.set(peer.peerId, endpoint);
      return endpoint;
    },
    resolveAddress: (remote, iroh) => {
      const endpoint = endpoints.get(remote.peerId);
      if (!endpoint) throw new Error('Remote test endpoint has not bound yet.');
      return new iroh.EndpointAddr(iroh.EndpointId.fromBytes([...irohIdentityBytes(remote.identityKey!)]), undefined, endpoint.boundSockets());
    },
  });
  return { endpoints, hostIdentity, guestIdentity, host, guest, make };
}

describe('independent Iroh frame transport', () => {
  it('maps the existing authenticated Ed25519 identity without changing invitations', () => {
    const identity = generateIdentityCredentials();
    const jwk = createPublicKey({ key: Buffer.from(identity.publicKey, 'base64url'), format: 'der', type: 'spki' }).export({ format: 'jwk' });
    assert.equal(irohIdentityBytes(identity.publicKey).toString('base64url'), jwk.x);
    assert.throws(() => irohIdentityBytes('invalid'), /Invalid/);
  });

  it('exchanges ordered frames without Nostr, MQTT, public relays or WebRTC', async function () {
    this.timeout(15000);
    const f = fixture();
    const host = f.make(f.host, f.hostIdentity.privateKey);
    const guest = f.make(f.guest, f.guestIdentity.privateKey, token, [f.host]);
    const received: Buffer[] = [];
    host.onFrame = (peerId, bytes) => host.send(bytes, peerId);
    guest.onFrame = (_peerId, bytes) => received.push(bytes);
    try {
      host.start();
      guest.start();
      await waitFor(() => host.connectedRelayCount > 0 && guest.connectedRelayCount > 0);
      const frames = [Buffer.from('first'), Buffer.alloc(512 * 1024, 7), Buffer.from('last')];
      for (const frame of frames) guest.send(frame, f.host.peerId);
      await waitFor(() => received.length === frames.length);
      assert.deepEqual(received, frames);
      host.stop();
      guest.stop();
      assert.throws(() => guest.send(Buffer.from('late'), f.host.peerId), /stopped/);
    } finally {
      host.stop();
      guest.stop();
      await Promise.all([...f.endpoints.values()].map((endpoint) => endpoint.close()));
    }
  });

  it('rejects a different session token before any application frame is accepted', async function () {
    this.timeout(15000);
    const f = fixture();
    const host = f.make(f.host, f.hostIdentity.privateKey);
    const guest = f.make(f.guest, f.guestIdentity.privateKey, 'different-session-token-that-is-long-enough', [f.host]);
    let announced = 0;
    host.onPeerAnnounce = () => { announced += 1; };
    try {
      host.start();
      guest.start();
      await waitFor(() => f.endpoints.size === 2);
      guest.sendAnnounce();
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(announced, 0);
      assert.equal(host.connectedRelayCount, 0);
      assert.throws(() => guest.send(Buffer.from('untrusted'), f.host.peerId), /No authenticated/);
    } finally {
      host.stop();
      guest.stop();
      await Promise.all([...f.endpoints.values()].map((endpoint) => endpoint.close()));
    }
  });

  it('rejects a participant using a pinned peer id with a different identity key', async function () {
    this.timeout(15000);
    const f = fixture();
    const impostor = generateIdentityCredentials();
    const host = f.make(f.host, f.hostIdentity.privateKey, token, [f.guest]);
    const guest = f.make(f.guest, impostor.privateKey, token, [f.host]);
    let announced = 0;
    host.onPeerAnnounce = () => { announced += 1; };
    try {
      host.start(); guest.start();
      await waitFor(() => f.endpoints.size === 2);
      guest.sendAnnounce();
      await new Promise((resolve) => setTimeout(resolve, 750));
      assert.equal(announced, 0);
      assert.equal(host.connectedRelayCount, 0);
    } finally {
      host.stop(); guest.stop();
      await Promise.all([...f.endpoints.values()].map((endpoint) => endpoint.close()));
    }
  });

  it('reconnects after endpoint replacement and rejects an oversized incoming packet', async function () {
    this.timeout(20000);
    const f = fixture();
    let host = f.make(f.host, f.hostIdentity.privateKey);
    const guest = f.make(f.guest, f.guestIdentity.privateKey, token, [f.host]);
    let received = '';
    try {
      host.start(); guest.start();
      await waitFor(() => host.connectedRelayCount > 0 && guest.connectedRelayCount > 0);
      host.stop();
      await f.endpoints.get('host')!.close();
      await waitFor(() => guest.connectedRelayCount === 0);
      host = f.make(f.host, f.hostIdentity.privateKey);
      host.onFrame = (_peer, bytes) => { received = bytes.toString(); };
      host.start();
      await waitFor(() => host.connectedRelayCount > 0 && guest.connectedRelayCount > 0);
      guest.send(Buffer.from('after-reconnect'), 'host');
      await waitFor(() => received === 'after-reconnect');
      const stream = (guest as any).connections.get('host').stream;
      await stream.send.writeAll([255, 255, 255, 255]);
      await waitFor(() => host.connectedRelayCount === 0);
    } finally {
      host.stop(); guest.stop();
      await Promise.all([...f.endpoints.values()].map((endpoint) => endpoint.close()));
    }
  });
});
