// Independent public discovery and encrypted mesh data path in two processes.
// Nostr, MQTT and WebRTC are unavailable in this test by construction.
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { generateIdentityCredentials } = require('../out/src/core/identity.js');
const currentFile = fileURLToPath(import.meta.url);

function deadRoom() {
  return { makeAction: () => ({ send: async () => undefined }), getPeers: () => ({}),
    leave: async () => undefined, ping: async () => -1 };
}

if (process.argv.includes('--worker')) {
  process.once('message', async ({ role, sessionId, token, identity, hostKey }) => {
    const { MeshTransport, configureMeshNetwork } = require('../out/src/runtime/mesh.js');
    const { IrohFrameRelay } = require('../out/src/runtime/irohFrameRelay.js');
    const host = { peerId: 'iroh-host', displayName: 'Host', joinOrder: 0, identityKey: hostKey };
    const localPeer = role === 'host' ? host : { peerId: 'iroh-guest', displayName: 'Guest', joinOrder: 1, identityKey: identity.publicKey };
    configureMeshNetwork({ proxy: { env: {} }, relayFactory: (options) => new IrohFrameRelay({
      ...options, identityPrivateKey: identity.privateKey,
    }) });
    const mesh = new MeshTransport({ sessionId, token, localPeer, identityPrivateKey: identity.privateKey,
      hostClock: () => ({ sessionEpoch: 1, hostEpoch: 0, hostId: host.peerId }), isHost: () => role === 'host',
      roomFactory: deadRoom, secondaryRoomFactory: deadRoom,
    });
    let received = 0;
    let sent = false;
    const payloads = [Buffer.from('first'), Buffer.alloc(512 * 1024, 23), Buffer.from('last')];
    mesh.on('message', (frame, source) => {
      if (role === 'host' && frame.type === 'irohProbe') mesh.sendTo(source, 'irohAck', {}, frame.payload);
      if (role === 'guest' && frame.type === 'irohAck') {
        if (!Buffer.from(frame.payload).equals(payloads[received] ?? Buffer.alloc(0))) {
          process.send({ error: 'Iroh mesh payload or ordering mismatch.' });
          return;
        }
        received += 1;
        if (received === payloads.length) process.send({ ok: true, frames: received, bytes: payloads.reduce((sum, item) => sum + item.length, 0) });
      }
    });
    mesh.on('peerConnected', () => {
      if (role === 'guest' && !sent) {
        sent = true;
        for (const payload of payloads) mesh.sendTo(host.peerId, 'irohProbe', {}, payload);
      }
    });
    mesh.on('protocolError', (error) => process.send({ error: error.message }));
    process.on('message', async (message) => {
      if (message.stop) { await mesh.stop(); process.exit(0); }
    });
    await mesh.start();
    if (role !== 'host') mesh.connect(host);
    const diagnostics = setInterval(() => process.stderr.write(`${role}: ${JSON.stringify(mesh.networkDiagnostics().relayFallback)}\n`), 20000);
    diagnostics.unref();
    if (role === 'host') process.send({ listening: true });
  });
} else {
  const sessionId = `iroh-smoke-${randomBytes(12).toString('hex')}`;
  const token = randomBytes(32).toString('base64url');
  const hostIdentity = generateIdentityCredentials();
  const children = [];
  let deadline;
  try {
    await new Promise((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error('Independent Iroh public smoke timed out after 90 seconds.')), 90000);
      const start = (role, identity) => {
        const child = fork(currentFile, ['--worker'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
        children.push(child);
        child.stderr.on('data', (bytes) => process.stderr.write(bytes));
        child.on('error', reject);
        child.on('exit', (code) => { if (code !== 0) reject(new Error(`${role} exited with ${code}`)); });
        child.on('message', (message) => {
          if (message.error) reject(new Error(message.error));
          if (message.listening) start('guest', generateIdentityCredentials());
          if (message.ok) { console.log(`Independent Iroh mesh OK: ${message.frames} ordered frames, ${message.bytes} bytes.`); resolve(); }
        });
        child.send({ role, sessionId, token, identity, hostKey: hostIdentity.publicKey });
      };
      start('host', hostIdentity);
    });
  } finally {
    clearTimeout(deadline);
    await Promise.all(children.map((child) => new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => child.kill(), 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.connected) child.send({ stop: true });
      else child.kill();
    })));
  }
}
