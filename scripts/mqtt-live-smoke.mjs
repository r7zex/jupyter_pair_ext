#!/usr/bin/env node
// Two-process production smoke for the secondary MQTT signalling family.
// The primary room and emergency relay are disabled, so success proves MQTT
// discovery plus a real WebRTC data channel through the proxy-aware adapter.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const currentFile = fileURLToPath(import.meta.url);

function deadRoom() {
  return {
    makeAction: () => ({ onMessage: () => undefined, send: async () => undefined }),
    onPeerJoin: () => undefined,
    onPeerLeave: () => undefined,
    ping: async () => -1,
    leave: async () => undefined,
  };
}

if (process.argv.includes('--worker')) {
  const { MeshTransport, configureMeshNetwork } = require('../out/src/runtime/mesh.js');
  const { getRelaySockets, joinRoom: joinMqttRoom } = require('../out/src/runtime/mqttRoom.js');
  const { readWindowsSystemProxy } = require('../out/src/runtime/systemProxy.js');
  const role = process.env.PAIR_NOTEBOOK_SMOKE_ROLE;
  const sessionId = process.env.PAIR_NOTEBOOK_SMOKE_SESSION;
  const token = process.env.PAIR_NOTEBOOK_SMOKE_TOKEN;
  if (!role || !sessionId || !token) throw new Error('MQTT smoke worker environment is incomplete.');
  const systemProxy = await readWindowsSystemProxy();
  configureMeshNetwork({
    disableRelayFallback: true,
    proxy: {
      systemProxy: systemProxy?.proxyUrl,
      systemNoProxy: systemProxy?.noProxy,
    },
  });
  const isHost = role === 'host';
  const localPeer = {
    peerId: isHost ? 'mqtt-host' : 'mqtt-peer',
    displayName: isHost ? 'MQTT Host' : 'MQTT Peer',
    joinOrder: isHost ? 0 : 1,
  };
  const clock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'mqtt-host' };
  const transport = new MeshTransport({
    sessionId,
    token,
    localPeer,
    hostClock: () => clock,
    isHost: () => isHost,
    roomFactory: () => deadRoom(),
    secondaryRoomFactory: joinMqttRoom,
  });
  const finish = async (label) => {
    process.stdout.write(`${label}\n`);
    await transport.stop().catch(() => undefined);
    process.exit(0);
  };
  transport.on('connectionError', (_peer, error) => process.stderr.write(`connection: ${error.message}\n`));
  transport.on('message', (frame, sourceId) => {
    if (isHost && frame.type === 'liveProbe') {
      transport.sendTo(sourceId, 'liveAck', {}, frame.payload);
      setTimeout(() => void finish('PAIR_NOTEBOOK_MQTT_HOST_OK'), 500);
    } else if (!isHost && frame.type === 'liveAck'
      && Buffer.from(frame.payload).toString('utf8') === 'mqtt-ok') {
      void finish('PAIR_NOTEBOOK_MQTT_PEER_OK');
    }
  });
  transport.on('peerConnected', () => {
    if (!isHost) transport.sendTo('mqtt-host', 'liveProbe', {}, Buffer.from('mqtt-ok'));
  });
  await transport.start();
  setTimeout(() => {
    const sockets = Object.entries(getRelaySockets()).map(([url, socket]) => `${url}:${socket?.readyState ?? 'none'}`);
    process.stderr.write(`MQTT status proxy=${systemProxy?.proxyUrl ? 'configured' : 'direct'} families=${transport.activeSignallingFamilies().join(',')} sockets=${sockets.join('|')}\n`);
  }, 10_000).unref();
  setTimeout(() => {
    process.stderr.write('MQTT live smoke timed out\n');
    process.exit(2);
  }, 60_000).unref();
} else {
  const sessionId = `mqtt-smoke-${randomBytes(12).toString('hex')}`;
  const token = randomBytes(32).toString('base64url');
  const environment = {
    ...process.env,
    PAIR_NOTEBOOK_SMOKE_SESSION: sessionId,
    PAIR_NOTEBOOK_SMOKE_TOKEN: token,
  };
  const start = (role) => spawn(process.execPath, [currentFile, '--worker'], {
    env: { ...environment, PAIR_NOTEBOOK_SMOKE_ROLE: role },
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
  const deadline = Date.now() + 65_000;
  while (Date.now() < deadline
    && (!output.includes('PAIR_NOTEBOOK_MQTT_HOST_OK') || !output.includes('PAIR_NOTEBOOK_MQTT_PEER_OK'))) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  for (const child of children) if (!child.killed) child.kill();
  if (!output.includes('PAIR_NOTEBOOK_MQTT_HOST_OK') || !output.includes('PAIR_NOTEBOOK_MQTT_PEER_OK')) {
    throw new Error(`Public MQTT/WebRTC smoke failed. ${diagnostics.trim()}`);
  }
  process.stdout.write('Public MQTT/WebRTC smoke passed between two Node processes.\n');
}
