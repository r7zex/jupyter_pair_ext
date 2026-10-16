import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VpsServer } from '../src/vps/server';
import { VpsFrameRelay } from '../src/runtime/vpsFrameRelay';
import { installProxyAwareWebSocket } from '../src/runtime/proxyWebSocket';
import { encodeFrame } from '../src/core/wire';
import { normalizeRelayEndpoint } from '../src/core/relayEndpoint';

describe('temporary session invitation relay', () => {
  it('accepts only credential-free HTTPS origins and loopback test origins', () => {
    assert.equal(normalizeRelayEndpoint('https://relay.example/'), 'https://relay.example');
    for (const value of ['http://relay.example', 'https://user:password@relay.example', 'https://relay.example/path', 'https://relay.example?token=secret']) assert.throws(() => normalizeRelayEndpoint(value));
  });

  it('exchanges encrypted session frames without a team token or WebRTC', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-temporary-relay-'));
    const server = new VpsServer({ dataDirectory: root, clientToken: 'a'.repeat(40), agentTokens: { vps: 'b'.repeat(40) } });
    installProxyAwareWebSocket({ env: {} });
    const relays: VpsFrameRelay[] = [];
    try {
      const url = `http://127.0.0.1:${await server.start()}`;
      for (const localPeerId of ['owner', 'member']) relays.push(new VpsFrameRelay({ sessionId: 'temporary', token: 'invite-secret', localPeerId, vps: { url, token: '', temporary: true } }));
      await Promise.all(relays.map(relay => { relay.start(); return relay.waitUntilReady(3000); }));
      const frame = encodeFrame('yUpdate', { key: 'work.py' }, Buffer.from('local typing'));
      const received = new Promise<Buffer>((resolve) => { relays[1]!.onFrame = (peer, bytes) => { assert.equal(peer, 'owner'); resolve(bytes); }; });
      relays[0]!.send(frame, 'member');
      assert.deepEqual(await received, frame);
      const outsider = new VpsFrameRelay({ sessionId: 'temporary', token: 'different-invitation', localPeerId: 'outsider', vps: { url, token: '', temporary: true } });
      relays.push(outsider); outsider.start(); await outsider.waitUntilReady(3000);
      let leaked = false; outsider.onFrame = () => { leaked = true; };
      relays[0]!.send(frame); await new Promise(resolve => setTimeout(resolve, 40));
      assert.equal(leaked, false);
    } finally {
      relays.forEach(relay => relay.stop()); await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});
