import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const currentFile = fileURLToPath(import.meta.url);

if (process.argv.includes('--worker')) {
  const { MeshTransport } = require('../out/src/runtime/mesh.js');
  const role = process.env.PAIR_NOTEBOOK_SMOKE_ROLE;
  const sessionId = process.env.PAIR_NOTEBOOK_SMOKE_SESSION;
  const token = process.env.PAIR_NOTEBOOK_SMOKE_TOKEN;
  if (!role || !sessionId || !token) throw new Error('Live smoke worker environment is incomplete.');
  const isHost = role === 'host';
  const localPeer = {
    peerId: isHost ? 'live-host' : 'live-peer',
    displayName: isHost ? 'Live Host' : 'Live Peer',
    joinOrder: isHost ? 0 : 1,
  };
  const clock = { sessionEpoch: 1, hostEpoch: 0, hostId: 'live-host' };
  const transport = new MeshTransport({
    sessionId,
    token,
    localPeer,
    hostClock: () => clock,
    isHost: () => isHost,
  });
  const finish = async (label) => {
    process.stdout.write(`${label}\n`);
    await transport.stop().catch(() => undefined);
    process.exit(0);
  };
  transport.on('connectionError', (_peer, error) => process.stderr.write(`connection: ${error.message}\n`));
  transport.on('protocolError', (error) => process.stderr.write(`protocol: ${error.message}\n`));
  transport.on('message', (frame, sourceId) => {
    if (isHost && frame.type === 'liveProbe') {
      transport.sendTo(sourceId, 'liveAck', {}, frame.payload);
      setTimeout(() => void finish('PAIR_NOTEBOOK_LIVE_HOST_OK'), 500);
    } else if (!isHost && frame.type === 'liveAck' && Buffer.from(frame.payload).toString('utf8') === 'p2p-ok') {
      void finish('PAIR_NOTEBOOK_LIVE_PEER_OK');
    }
  });
  transport.on('peerConnected', () => {
    if (!isHost) transport.sendTo('live-host', 'liveProbe', {}, Buffer.from('p2p-ok'));
  });
  await transport.start();
  setTimeout(() => {
    process.stderr.write('live smoke timed out\n');
    process.exit(2);
  }, 90_000).unref();
} else {
  const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
  const sessionId = `smoke-${randomBytes(12).toString('hex')}`;
  const token = randomBytes(32).toString('base64url');
  const baseEnvironment = {
    ...process.env,
    PAIR_NOTEBOOK_SMOKE_SESSION: sessionId,
    PAIR_NOTEBOOK_SMOKE_TOKEN: token,
  };
  const start = (role) => spawn(process.execPath, [currentFile, '--worker'], {
    env: { ...baseEnvironment, PAIR_NOTEBOOK_SMOKE_ROLE: role },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const host = start('host');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const peer = start('peer');
  const children = [host, peer];
  let output = '';
  let diagnostics = '';
  let spawnFailure;
  for (const child of children) {
    child.stdout.on('data', (chunk) => {
      output = (output + chunk.toString()).slice(-MAX_DIAGNOSTIC_BYTES);
    });
    child.stderr.on('data', (chunk) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-MAX_DIAGNOSTIC_BYTES);
    });
    child.once('error', (error) => { spawnFailure ??= error; });
  }
  const deadline = Date.now() + 95_000;
  while (Date.now() < deadline
    && (!output.includes('PAIR_NOTEBOOK_LIVE_HOST_OK') || !output.includes('PAIR_NOTEBOOK_LIVE_PEER_OK'))) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  for (const child of children) if (!child.killed) child.kill();
  if (spawnFailure) throw new Error(`Could not start public Trystero smoke worker: ${spawnFailure.message}`);
  if (!output.includes('PAIR_NOTEBOOK_LIVE_HOST_OK') || !output.includes('PAIR_NOTEBOOK_LIVE_PEER_OK')) {
    throw new Error(`Public Trystero smoke failed. ${diagnostics.trim()}`);
  }
  process.stdout.write('Public Trystero/Nostr/WebRTC smoke passed between two Node processes.\n');
}
