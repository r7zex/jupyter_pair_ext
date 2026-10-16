import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { decryptRelayPacket, encryptRelayPacket } from '../runtime/relayCrypto';
import { systemTlsOptions } from '../runtime/systemTls';

async function check(): Promise<void> {
  const origin = new URL(process.argv[2] ?? '');
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('Supply an HTTPS server origin.');
  if (origin.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname)) throw new Error('HTTP checks are restricted to loopback.');
  origin.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
  origin.pathname = '/v1/temporary-relay'; origin.search = '';
  const room = randomBytes(32).toString('hex'), key = randomBytes(32);
  const peers = [randomUUID(), randomUUID()]; const sockets = new Set<WebSocket>();
  const connect = async (peer: string): Promise<WebSocket> => {
    const url = new URL(origin); url.searchParams.set('room', room); url.searchParams.set('peer', peer);
    const socket = new WebSocket(url, { handshakeTimeout: 10_000, ...systemTlsOptions() }); sockets.add(socket);
    await once(socket, 'open'); return socket;
  };
  try {
    const first = await connect(peers[0]!); let second = await connect(peers[1]!);
    for (let round = 0; round < 2; round++) {
      const plaintext = Buffer.from(`Pair Notebook encrypted relay check ${randomUUID()}`);
      const received = once(second, 'message');
      first.send(JSON.stringify({ t: 'data', f: peers[0], to: peers[1], d: encryptRelayPacket(key, plaintext).toString('base64') }));
      const [packet] = await received;
      const decoded = decryptRelayPacket(key, Buffer.from(JSON.parse(String(packet)).d, 'base64'));
      if (!decoded.equals(plaintext)) throw new Error('Relay ciphertext did not match.');
      if (round === 0) {
        const closed = once(second, 'close'); second.close(); await closed;
        // Wait for server-side close processing before reusing the peer identity.
        await new Promise(resolve => setTimeout(resolve, 100)); second = await connect(peers[1]!);
      }
    }
    console.log('PASS: WebSocket 101, AES-256-GCM exchange, reconnect and second exchange.');
  } finally { for (const socket of sockets) socket.terminate(); }
}
const timeout = setTimeout(() => { console.error('Relay check timed out.'); process.exit(1); }, 25_000);
void check().then(() => clearTimeout(timeout), () => { clearTimeout(timeout); console.error('Relay check failed. Check TLS, proxy WebSocket routing and reachability.'); process.exitCode = 1; });
