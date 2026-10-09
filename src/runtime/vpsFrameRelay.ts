import { createHash, randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { MAX_WIRE_FRAME_BYTES, decodeFrame, encodeFrame } from '../core/wire';
import { normalizeVpsUrl, VPS_ID } from '../vps/protocol';
import { type FrameRelay, type FrameRelayOptions } from './frameRelay';
import { createProxiedNodeWebSocket } from './proxyWebSocket';
import { createRelayAnnounceProof, decryptRelayPacket, deriveRelayFrameKey, encryptRelayPacket,
  encryptRelayReadinessProbe, verifyRelayAnnounceProof, verifyRelayReadinessProbe } from './relayCrypto';

export interface VpsRelayConnection { url: string; token: string }
const MAX_ENVELOPE_HEADER_BYTES = 512;
const PROBE_INTERVAL_MS = 10_000;
const PROBE_TIMEOUT_MS = 10_000;

/** The VPS can route ciphertext; only invitation holders can decrypt session frames. */
export class VpsFrameRelay implements FrameRelay {
  public onFrame: (peer: string, frame: Buffer) => void = () => undefined;
  public onPeerAnnounce: (peer: string) => void = () => undefined;
  private socket: WebSocket | undefined;
  private reconnect: NodeJS.Timeout | undefined;
  private probeTimer: NodeJS.Timeout | undefined;
  private nextProbeTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private ready = false;
  private nonce = '';
  private readonly key: Buffer;
  private readonly url: string;

  public constructor(private readonly options: FrameRelayOptions & { vps: VpsRelayConnection;
    socketFactory?: typeof createProxiedNodeWebSocket }) {
    if (!VPS_ID.test(options.localPeerId)) throw new Error('Invalid VPS peer ID.');
    this.key = deriveRelayFrameKey(options.token, options.sessionId);
    const url = new URL(normalizeVpsUrl(options.vps.url) + '/v1/relay');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('room', createHash('sha256').update(`pair-vps-v1|${options.sessionId}|${options.token}`).digest('hex'));
    url.searchParams.set('peer', options.localPeerId);
    this.url = url.toString();
  }

  public get connectedRelayCount(): number { return this.ready ? 1 : 0; }
  public diagnostics(): Record<string, unknown> { return { transport: 'VPS', ready: this.ready }; }
  public start(): void {
    if (this.stopped || this.socket) return;
    const socket = (this.options.socketFactory ?? createProxiedNodeWebSocket)(this.url, undefined, {
      headers: { authorization: `Bearer ${this.options.vps.token}` },
      handshakeTimeout: 10_000, maxPayload: 96 * 1024 * 1024, followRedirects: false,
    }, true);
    this.socket = socket;
    this.nonce = '';
    socket.on('open', () => {
      if (this.stopped || this.socket !== socket) return;
      this.probe(socket);
    });
    socket.on('message', (raw) => { if (!this.stopped && this.socket === socket) this.receive(raw.toString()); });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.ready = false;
      if (this.probeTimer) clearTimeout(this.probeTimer);
      if (this.nextProbeTimer) clearTimeout(this.nextProbeTimer);
      this.probeTimer = undefined;
      this.nextProbeTimer = undefined;
      this.nonce = '';
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });
  }
  private probe(socket: WebSocket): void {
    if (this.stopped || this.socket !== socket) return;
    this.nextProbeTimer = undefined;
    this.nonce = randomBytes(24).toString('hex');
    // Repeat the encrypted round trip so a half-open VPN/proxy route is
    // replaced within the mesh's logical-peer recovery window.
    this.probeTimer = setTimeout(() => {
      if (this.stopped || this.socket !== socket) return;
      this.ready = false;
      socket.terminate();
    }, PROBE_TIMEOUT_MS);
    this.probeTimer.unref();
    try {
      socket.send(JSON.stringify({ t: 'probe', d: encryptRelayReadinessProbe(this.key, this.nonce) }));
    } catch {
      this.ready = false;
      socket.terminate();
    }
  }
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnect) return;
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      try { this.start(); } catch { this.scheduleReconnect(); }
    }, 2000);
    this.reconnect.unref();
  }
  public stop(): void {
    this.stopped = true;
    this.ready = false;
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    if (this.nextProbeTimer) clearTimeout(this.nextProbeTimer);
    this.socket?.terminate();
    this.socket = undefined;
  }
  public async waitUntilReady(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.ready && !this.stopped && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if (!this.ready) throw new Error('The VPS relay did not complete its encrypted data-path check.');
  }
  public sendAnnounce(): void {
    if (!this.ready) return;
    this.socket?.send(JSON.stringify({ t: 'announce', f: this.options.localPeerId,
      proof: createRelayAnnounceProof(this.key, this.options.sessionId, this.options.localPeerId) }));
  }
  public send(bytes: Buffer, toPeerId?: string): void {
    if (!this.ready || !this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('VPS relay is not connected.');
    if (bytes.length > MAX_WIRE_FRAME_BYTES || (toPeerId && !VPS_ID.test(toPeerId))) throw new Error('Invalid VPS relay frame.');
    if (this.socket.bufferedAmount > 128 * 1024 * 1024) throw new Error('VPS relay is congested.');
    // A mesh frame has already paid its own wire header cost. Bound the small
    // routing header separately so wrapping a maximum-size frame still works.
    const header = encodeFrame('vpsData', { f: this.options.localPeerId, ...(toPeerId ? { to: toPeerId } : {}) });
    const envelope = Buffer.concat([header, bytes]);
    this.socket.send(JSON.stringify({ t: 'data', f: this.options.localPeerId, to: toPeerId,
      d: encryptRelayPacket(this.key, envelope).toString('base64') }));
  }
  private receive(raw: string): void {
    try {
      const message = JSON.parse(raw) as { t: string; f?: string; to?: string; proof?: string; d?: string };
      if (message.t === 'probe') {
        if (this.nonce && typeof message.d === 'string' && verifyRelayReadinessProbe(this.key, this.nonce, message.d)) {
          const wasReady = this.ready;
          this.ready = true;
          if (this.probeTimer) clearTimeout(this.probeTimer);
          this.probeTimer = undefined;
          this.nonce = '';
          const socket = this.socket;
          if (socket) {
            this.nextProbeTimer = setTimeout(() => this.probe(socket), PROBE_INTERVAL_MS);
            this.nextProbeTimer.unref();
          }
          if (!wasReady) this.sendAnnounce();
        }
        return;
      }
      if (!this.ready || !message.f || !VPS_ID.test(message.f) || message.f === this.options.localPeerId) return;
      if (message.t === 'announce') {
        if (verifyRelayAnnounceProof(this.key, this.options.sessionId, message.f, message.proof)) this.onPeerAnnounce(message.f);
        return;
      }
      if (message.t !== 'data' || typeof message.d !== 'string' || (message.to && message.to !== this.options.localPeerId)) return;
      const packet = decryptRelayPacket(this.key, Buffer.from(message.d, 'base64'));
      if (packet.length < 5 || packet.length > MAX_WIRE_FRAME_BYTES + MAX_ENVELOPE_HEADER_BYTES + 5) return;
      const headerLength = packet.readUInt32BE(1);
      if (headerLength > MAX_ENVELOPE_HEADER_BYTES || headerLength + 5 > packet.length) return;
      const envelope = decodeFrame(packet.subarray(0, headerLength + 5));
      if (envelope.type !== 'vpsData' || envelope.meta.f !== message.f || envelope.meta.to !== message.to) return;
      const bytes = packet.subarray(headerLength + 5);
      if (bytes.length <= MAX_WIRE_FRAME_BYTES) this.onFrame(message.f, bytes);
    } catch { /* Invalid ciphertext or another session cannot enter the mesh. */ }
  }
}
