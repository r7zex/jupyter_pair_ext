// Live MQTT signalling smoke: connects two independent trystero MQTT rooms
// against public brokers and verifies discovery + handshake. Bounded by
// timeouts; failure here does not fail the unit suite (public infrastructure).
import { randomBytes } from 'node:crypto';
import { joinRoom } from '@trystero-p2p/mqtt';
import { RTCPeerConnection as WeriftPeerConnection } from 'werift';

const appId = 'dev.pair-notebook.vscode.v2.smoke';
const suffix = process.argv[2] && !process.argv[2].startsWith('-')
  ? process.argv[2]
  : randomBytes(6).toString('hex');
const roomId = `mqtt-live-smoke-${suffix}`;
const password = 'smoke-token-0123456789-abcdef';

const config = {
  appId,
  password,
  rtcPolyfill: /** @type {never} */ (WeriftPeerConnection),
};

const roomA = joinRoom(config, roomId, { handshakeTimeoutMs: 8000 });
const roomB = joinRoom(config, roomId, { handshakeTimeoutMs: 8000 });

const done = Promise.race([
  new Promise((resolve) => {
    let aJoined = false;
    let bJoined = false;
    const check = () => { if (aJoined && bJoined) resolve('both'); };
    roomA.onPeerJoin = () => { aJoined = true; check(); };
    roomB.onPeerJoin = () => { bJoined = true; check(); };
  }),
  new Promise((resolve) => setTimeout(() => resolve('timeout'), 20_000)),
]);

const result = await done;
console.log(`[mqtt-live] ${result}`);
await roomA.leave().catch(() => undefined);
await roomB.leave().catch(() => undefined);
process.exit(result === 'both' ? 0 : 1);
