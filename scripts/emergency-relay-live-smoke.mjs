#!/usr/bin/env node
// Public acceptance test for the full data path when WebRTC and both normal
// signalling rooms are unavailable. For each relay family, the host connects
// directly while the peer uses the active Windows/Karing system proxy.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const currentFile = fileURLToPath(import.meta.url);
const modes = ['nostr', 'mqtt', 'redundant'];

function deadRoom() {
  return {
    makeAction: () => ({ onMessage: () => undefined, send: async () => undefined }),
    onPeerJoin: () => undefined,
    onPeerLeave: () => undefined,
    ping: async () => -1,
    leave: async () => undefined,
    getPeers: () => ({}),
  };
}

if (process.argv.includes('--worker')) {
  const { MeshTransport, configureMeshNetwork } = require('../out/src/runtime/mesh.js');
  const { MqttFrameRelay } = require('../out/src/runtime/mqttFrameRelay.js');
  const { NostrFrameRelay } = require('../out/src/runtime/nostrRelay.js');
  const { RedundantFrameRelay } = require('../out/src/runtime/redundantFrameRelay.js');
  const { readWindowsSystemProxy } = require('../out/src/runtime/systemProxy.js');
  const role = process.env.PAIR_NOTEBOOK_RELAY_ROLE;
  const mode = process.env.PAIR_NOTEBOOK_RELAY_MODE;
  const sessionId = process.env.PAIR_NOTEBOOK_RELAY_SESSION;
  const token = process.env.PAIR_NOTEBOOK_RELAY_TOKEN;
  if (!role || !modes.includes(mode) || !sessionId || !token) {
    throw new Error('Emergency relay smoke worker environment is incomplete.');
  }
  const isHost = role === 'host';
  const systemProxy = isHost ? undefined : await readWindowsSystemProxy();
  const Relay = mode === 'nostr' ? NostrFrameRelay
    : mode === 'mqtt' ? MqttFrameRelay
      : RedundantFrameRelay;
  configureMeshNetwork({
    proxy: isHost
      ? { env: {} }
      : { systemProxy: systemProxy?.proxyUrl, systemNoProxy: systemProxy?.noProxy, env: {} },
    relayFactory: (options) => new Relay(options),
  });
  const localPeer = {
    peerId: isHost ? 'relay-live-host' : 'relay-live-peer',
    displayName: isHost ? 'Relay Live Host' : 'Relay Live Peer',
    joinOrder: isHost ? 0 : 1,
  };
  const transport = new MeshTransport({
    sessionId,
    token,
    localPeer,
    hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: 'relay-live-host' }),
    isHost: () => isHost,
    roomFactory: () => deadRoom(),
    disableSecondarySignalling: true,
  });
  const payload = Buffer.alloc(64 * 1024, 0x5a);
  const finish = async (label) => {
    process.stdout.write(`${label}\n`);
    await transport.stop().catch(() => undefined);
    process.exit(0);
  };
  transport.on('connectionError', (_peer, error) => process.stderr.write(`connection: ${error.message}\n`));
  transport.on('protocolError', (error) => process.stderr.write(`protocol: ${error.message}\n`));
  transport.on('message', (frame, sourceId) => {
    if (isHost && frame.type === 'relayLiveProbe' && Buffer.from(frame.payload).equals(payload)) {
      transport.sendTo(sourceId, 'relayLiveAck', {}, frame.payload);
      setTimeout(() => void finish('PAIR_NOTEBOOK_RELAY_HOST_OK'), 500);
    } else if (!isHost && frame.type === 'relayLiveAck' && Buffer.from(frame.payload).equals(payload)) {
      void finish('PAIR_NOTEBOOK_RELAY_PEER_OK');
    }
  });
  transport.on('peerConnected', () => {
    if (!isHost) transport.sendTo('relay-live-host', 'relayLiveProbe', {}, payload);
  });
  await transport.start();
  setTimeout(() => {
    process.stderr.write(`Emergency ${mode} relay smoke timed out\n`);
    process.exit(2);
  }, 75_000).unref();
} else {
  for (const mode of modes) {
    const sessionId = `relay-${mode}-${randomBytes(12).toString('hex')}`;
    const token = randomBytes(32).toString('base64url');
    const baseEnvironment = {
      ...process.env,
      PAIR_NOTEBOOK_RELAY_MODE: mode,
      PAIR_NOTEBOOK_RELAY_SESSION: sessionId,
      PAIR_NOTEBOOK_RELAY_TOKEN: token,
    };
    const start = (role) => spawn(process.execPath, [currentFile, '--worker'], {
      env: { ...baseEnvironment, PAIR_NOTEBOOK_RELAY_ROLE: role },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const host = start('host');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const peer = start('peer');
    const children = [host, peer];
    let output = '';
    let diagnostics = '';
    for (const child of children) {
      child.stdout.on('data', (chunk) => { output = (output + chunk.toString()).slice(-1024 * 1024); });
      child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-1024 * 1024); });
    }
    const deadline = Date.now() + 80_000;
    while (Date.now() < deadline
      && (!output.includes('PAIR_NOTEBOOK_RELAY_HOST_OK')
        || !output.includes('PAIR_NOTEBOOK_RELAY_PEER_OK'))) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    for (const child of children) if (!child.killed) child.kill();
    const completed = output.includes('PAIR_NOTEBOOK_RELAY_HOST_OK')
      && output.includes('PAIR_NOTEBOOK_RELAY_PEER_OK');
    if (!completed || /failed the identity proof/i.test(diagnostics)) {
      throw new Error(`Public ${mode} emergency relay smoke failed. ${diagnostics.trim()}`);
    }
    process.stdout.write(`Public ${mode} emergency relay 64 KiB round-trip passed (direct -> system proxy).\n`);
  }
}
