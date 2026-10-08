import { createHash, randomBytes } from 'node:crypto';
import { WebSocket } from 'ws';
import { MAX_WIRE_FRAME_BYTES, decodeFrame, encodeFrame } from '../core/wire';
import { normalizeVpsUrl, VPS_ID } from '../vps/protocol';
import { type FrameRelay, type FrameRelayOptions } from './frameRelay';
import { createProxiedNodeWebSocket } from './proxyWebSocket';
import { createRelayAnnounceProof, decryptRelayPacket, deriveRelayFrameKey, encryptRelayPacket,
  encryptRelayReadinessProbe, verifyRelayAnnounceProof, verifyRelayReadinessProbe } from './relayCrypto';

export interface VpsRelayConnection { url: string; token: string }

/** The VPS can route ciphertext; only invitation holders can decrypt session frames. */
export class VpsFrameRelay implements FrameRelay {
  public onFrame: (peer: string, frame: Buffer) => void = () => undefined;
  public onPeerAnnounce: (peer: string) => void = () => undefined;
  private socket: WebSocket | undefined;
  private reconnect: NodeJS.Timeout | undefined;
  private probeTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private ready = false;
  private nonce = '';
  private readonly key: Buffer;
  private readonly url: string;

  public constructor(private readonly options: FrameRelayOptions & { vps: VpsRelayConnection;
    socketFactory?: typeof createProxiedNodeWebSocket }) {
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
      this.nonce = randomBytes(24).toString('hex');
      socket.send(JSON.stringify({ t: 'probe', d: encryptRelayReadinessProbe(this.key, this.nonce) }));
      this.probeTimer = setTimeout(() => socket.terminate(), 10_000);
      this.probeTimer.unref();
    });
    socket.on('message', (raw) => { if (!this.stopped && this.socket === socket) this.receive(raw.toString()); });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.ready = false;
      if (this.probeTimer) clearTimeout(this.probeTimer);
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });
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
    const envelope = encodeFrame('vpsData', { f: this.options.localPeerId, ...(toPeerId ? { to: toPeerId } : {}) }, bytes);
    this.socket.send(JSON.stringify({ t: 'data', f: this.options.localPeerId, to: toPeerId,
      d: encryptRelayPacket(this.key, envelope).toString('base64') }));
  }
  private receive(raw: string): void {
    try {
      const message = JSON.parse(raw) as { t: string; f?: string; to?: string; proof?: string; d?: string };
      if (message.t === 'probe') {
        if (!this.ready && this.nonce && typeof message.d === 'string' && verifyRelayReadinessProbe(this.key, this.nonce, message.d)) {
          this.ready = true;
          if (this.probeTimer) clearTimeout(this.probeTimer);
          this.sendAnnounce();
        }
        return;
      }
      if (!this.ready || !message.f || !VPS_ID.test(message.f) || message.f === this.options.localPeerId) return;
      if (message.t === 'announce') {
        if (verifyRelayAnnounceProof(this.key, this.options.sessionId, message.f, message.proof)) this.onPeerAnnounce(message.f);
        return;
      }
      if (message.t !== 'data' || typeof message.d !== 'string' || (message.to && message.to !== this.options.localPeerId)) return;
      const envelope = decodeFrame(decryptRelayPacket(this.key, Buffer.from(message.d, 'base64')));
      if (envelope.type !== 'vpsData' || envelope.meta.f !== message.f || envelope.meta.to !== message.to) return;
      const bytes = Buffer.from(envelope.payload);
      if (bytes.length <= MAX_WIRE_FRAME_BYTES) this.onFrame(message.f, bytes);
    } catch { /* Invalid ciphertext or another session cannot enter the mesh. */ }
  }
}
