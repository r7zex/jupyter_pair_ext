import { createHmac, createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto';
import type { BiStream, Connection, Endpoint, EndpointAddr } from '@number0/iroh/index';
import { validateIdentityPublicKey } from '../core/identity';
import type { PeerIdentity } from '../core/types';
import { MAX_WIRE_FRAME_BYTES } from '../core/wire';
import type { FrameRelay, FrameRelayOptions } from './frameRelay';
import { loadIroh, type IrohModule } from './irohNative';
import { lookupIrohAddress } from './irohAddressLookup';

const MAX_PEERS = 32;
const MAX_PACKET_BYTES = Math.ceil(MAX_WIRE_FRAME_BYTES * 4 / 3) + 8192;
const MAX_BUFFERED_BYTES = 128 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const NEGOTIATION_MS = 10_000;

export interface IrohFrameRelayOptions extends FrameRelayOptions {
  identityPrivateKey: string;
  peers?: readonly PeerIdentity[];
  /** Test hook for a real local endpoint without public discovery. */
  bindEndpoint?: (iroh: IrohModule, key: number[], alpn: number[]) => Promise<Endpoint>;
  resolveAddress?: (peer: PeerIdentity, iroh: IrohModule) => EndpointAddr;
}

interface PeerStream {
  connection: Connection;
  stream: BiStream;
  tail: Promise<void>;
}

export function irohIdentityBytes(identityKey: string): Buffer {
  if (validateIdentityPublicKey(identityKey)) throw new Error('Invalid Iroh participant identity.');
  const jwk = createPublicKey({ key: Buffer.from(identityKey, 'base64url'), type: 'spki', format: 'der' }).export({ format: 'jwk' });
  return Buffer.from(jwk.x!, 'base64url');
}

/** Carries the existing signed mesh frames over independent authenticated QUIC. */
export class IrohFrameRelay implements FrameRelay {
  onFrame: (peerId: string, bytes: Buffer) => void = () => undefined;
  onPeerAnnounce: (peerId: string) => void = () => undefined;
  private readonly peers = new Map<string, PeerIdentity>();
  private readonly connections = new Map<string, PeerStream>();
  private readonly pending = new Set<string>();
  private endpoint: Endpoint | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private started = false;
  private online = false;
  private startupError: Error | undefined;
  private lastConnectionError: string | undefined;
  private incomingCount = 0;
  private sendingBytes = 0;
  private receivingBytes = 0;
  private readonly alpn: number[];
  private iroh: IrohModule | undefined;

  constructor(private readonly options: IrohFrameRelayOptions) {
    this.alpn = [...Buffer.from(`pair-notebook/1/${this.mac('alpn', options.sessionId)}`)];
    this.updateDirectory(options.peers ?? []);
  }

  get connectedRelayCount(): number { return this.online || this.connections.size > 0 ? 1 : 0; }

  diagnostics(): Record<string, unknown> {
    return { transport: 'iroh', started: this.started, ready: this.connectedRelayCount > 0,
      peers: this.connections.size, pending: this.pending.size,
      ...(this.lastConnectionError ? { lastConnectionError: this.lastConnectionError } : {}),
      ...(this.startupError ? { error: this.startupError.message } : {}) };
  }

  updateDirectory(peers: readonly PeerIdentity[]): void {
    for (const peer of peers.slice(0, MAX_PEERS)) {
      if (peer.peerId === this.options.localPeerId || !peer.identityKey || validateIdentityPublicKey(peer.identityKey)) continue;
      const previous = this.peers.get(peer.peerId);
      if (previous?.identityKey !== undefined && previous.identityKey !== peer.identityKey) continue;
      if (this.peers.size < MAX_PEERS || previous) this.peers.set(peer.peerId, { ...peer });
    }
    if (this.endpoint) this.sendAnnounce();
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.bind().catch(() => { this.startupError = new Error('Iroh endpoint could not start; other transports remain available.'); });
  }

  private async bind(): Promise<void> {
    const iroh = loadIroh();
    this.iroh = iroh;
    const privateKey = createPrivateKey({ key: Buffer.from(this.options.identityPrivateKey, 'base64url'), type: 'pkcs8', format: 'der' });
    const key = [...Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url')];
    const endpoint = await (this.options.bindEndpoint?.(iroh, key, this.alpn)
      ?? iroh.Endpoint.bind({ secretKey: key, alpns: [this.alpn] }));
    key.fill(0);
    if (this.stopped) { await endpoint.close(); return; }
    this.endpoint = endpoint;
    // The 1.1.0 synchronous watcher starts Tokio work outside its runtime.
    // Use the asynchronous readiness API to avoid a native process panic.
    void endpoint.online().then(() => { if (!this.stopped) this.online = true; }).catch(() => undefined);
    void this.acceptConnections(endpoint).catch(() => { if (!this.stopped) this.online = false; });
    this.timer = setInterval(() => this.sendAnnounce(), 3000);
    this.timer.unref?.();
    this.sendAnnounce();
  }

  async waitUntilReady(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.stopped && !this.startupError && !this.connectedRelayCount && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (this.startupError) throw this.startupError;
    if (!this.connectedRelayCount) throw new Error('No Iroh relay or peer route became ready.');
  }

  stop(): void {
    this.stopped = true;
    this.online = false;
    if (this.timer) clearInterval(this.timer);
    for (const peer of this.connections.values()) peer.connection.close(0n, []);
    this.connections.clear();
    const endpoint = this.endpoint;
    this.endpoint = undefined;
    if (endpoint) void endpoint.close().catch(() => undefined);
  }

  sendAnnounce(): void {
    if (!this.endpoint || this.stopped) return;
    for (const peer of this.peers.values()) {
      if (this.connections.has(peer.peerId)) this.onPeerAnnounce(peer.peerId);
      else if (!this.pending.has(peer.peerId)) void this.connectPeer(peer);
    }
  }

  private async connectPeer(peer: PeerIdentity): Promise<void> {
    const endpoint = this.endpoint;
    const iroh = this.iroh;
    if (!endpoint || !iroh || !peer.identityKey || this.pending.size >= MAX_PEERS) return;
    this.pending.add(peer.peerId);
    let nativeAttempt: Promise<Connection> | undefined;
    try {
      let addr = this.options.resolveAddress?.(peer, iroh);
      if (!addr) {
        const id = iroh.EndpointId.fromBytes([...irohIdentityBytes(peer.identityKey)]);
        try {
          const hint = await lookupIrohAddress(peer.identityKey);
          addr = new iroh.EndpointAddr(id, hint.relay, hint.addresses);
        } catch { addr = new iroh.EndpointAddr(id); }
      }
      if (this.stopped) return;
      const connecting = endpoint.connect(addr, this.alpn);
      nativeAttempt = connecting;
      let expired = false;
      void connecting.then((connection) => { if (expired || this.stopped) connection.close(0n, []); }).catch(() => undefined);
      let connection: Connection;
      try { connection = await bounded(connecting, NEGOTIATION_MS); }
      catch (error) { expired = true; throw error; }
      await this.establish(connection, true, peer);
    } catch (error) {
      this.lastConnectionError = String(error).replaceAll(this.options.token, '[redacted]')
        .replaceAll(this.options.identityPrivateKey, '[redacted]').slice(0, 512);
      // Retry with independent discovery on the next announce.
    }
    finally {
      if (nativeAttempt) void nativeAttempt.finally(() => this.pending.delete(peer.peerId)).catch(() => undefined);
      else this.pending.delete(peer.peerId);
    }
  }

  private async acceptConnections(endpoint: Endpoint): Promise<void> {
    while (!this.stopped) {
      const incoming = await endpoint.acceptNext();
      if (!incoming) return;
      if (this.stopped || this.incomingCount + this.connections.size >= MAX_PEERS) {
        await incoming.refuse();
        continue;
      }
      this.incomingCount += 1;
      void (async () => {
        let connection: Connection | undefined;
        try {
          const accepting = await incoming.accept();
          const pending = accepting.connect();
          let expired = false;
          void pending.then((late) => { if (expired || this.stopped) late.close(0n, []); }).catch(() => undefined);
          try { connection = await bounded(pending, NEGOTIATION_MS); }
          catch (error) { expired = true; throw error; }
          await this.establish(connection, false);
        } catch { connection?.close(0n, []); }
        finally { this.incomingCount -= 1; }
      })();
    }
  }

  private mac(...parts: string[]): string {
    return createHmac('sha256', this.options.token).update(JSON.stringify(['pair-notebook-iroh-v1', ...parts])).digest('hex');
  }

  private async establish(connection: Connection, outgoing: boolean, expected?: PeerIdentity): Promise<void> {
    if (this.stopped || !this.endpoint) { connection.close(0n, []); return; }
    connection.setMaxConcurrentBiStreams(1n);
    connection.setMaxConcurrentUniStreams(0n);
    const localId = Buffer.from(this.endpoint.id().toBytes()).toString('hex');
    const remoteId = Buffer.from(connection.remoteId().toBytes()).toString('hex');
    let peerId: string;
    let stream: BiStream;
    try {
      const negotiate = async () => {
        const bi = await (outgoing ? connection.openBi() : connection.acceptBi());
        const hello = Buffer.from(JSON.stringify({ peerId: this.options.localPeerId,
          proof: this.mac(this.options.sessionId, this.options.localPeerId, localId, remoteId) }));
        await this.writePacket(bi, hello);
        const remote = JSON.parse((await this.readPacket(bi, 1024)).toString('utf8')) as { peerId?: unknown; proof?: unknown };
        if (typeof remote.peerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(remote.peerId)
          || remote.peerId === this.options.localPeerId || typeof remote.proof !== 'string' || !/^[a-f0-9]{64}$/.test(remote.proof)) {
          throw new Error('Invalid Iroh session greeting.');
        }
        const proof = this.mac(this.options.sessionId, remote.peerId, remoteId, localId);
        if (!timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(remote.proof, 'hex'))) throw new Error('Iroh session authentication failed.');
        const pinned = expected ?? this.peers.get(remote.peerId);
        if (pinned && (pinned.peerId !== remote.peerId || irohIdentityBytes(pinned.identityKey!).toString('hex') !== remoteId)) {
          throw new Error('Iroh endpoint does not match the pinned participant.');
        }
        return { bi, peerId: remote.peerId };
      };
      ({ bi: stream, peerId } = await bounded(negotiate(), NEGOTIATION_MS));
    } catch (error) { connection.close(0n, []); throw error; }
    if (this.stopped) { connection.close(0n, []); return; }
    const previous = this.connections.get(peerId);
    if (previous && !previous.connection.closeReason()) {
      if (outgoing !== (this.options.localPeerId < peerId)) { connection.close(0n, []); return; }
      previous.connection.close(0n, []);
    }
    const peer: PeerStream = { connection, stream, tail: Promise.resolve() };
    this.connections.set(peerId, peer);
    this.lastConnectionError = undefined;
    this.onPeerAnnounce(peerId);
    void this.readFrames(peerId, peer).catch(() => undefined).finally(() => {
      connection.close(0n, []);
      if (this.connections.get(peerId) === peer) this.connections.delete(peerId);
    });
  }

  send(bytes: Buffer, toPeerId?: string): void {
    if (this.stopped) throw new Error('Iroh transport is stopped.');
    if (!bytes.length || bytes.length > MAX_PACKET_BYTES) throw new Error('Iroh frame exceeds the packet limit.');
    const recipients = toPeerId ? [this.connections.get(toPeerId)].filter((peer): peer is PeerStream => !!peer) : [...this.connections.values()];
    if (!recipients.length) throw new Error('No authenticated Iroh connection to this participant.');
    if (this.sendingBytes + bytes.length * recipients.length > MAX_BUFFERED_BYTES) throw new Error('Iroh send queue is full.');
    for (const peer of recipients) {
      this.sendingBytes += bytes.length;
      peer.tail = peer.tail.then(() => this.writePacket(peer.stream, bytes))
        .catch(() => { peer.connection.close(0n, []); })
        .finally(() => { this.sendingBytes -= bytes.length; });
    }
  }

  private async writePacket(stream: BiStream, bytes: Buffer): Promise<void> {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(bytes.length);
    await stream.send.writeAll([...prefix]);
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      await stream.send.writeAll([...bytes.subarray(offset, offset + CHUNK_BYTES)]);
    }
  }

  private async readPacket(stream: BiStream, maximum: number): Promise<Buffer> {
    const size = Buffer.from(await stream.recv.readExact(4)).readUInt32BE();
    if (!size || size > maximum || this.receivingBytes + size > MAX_BUFFERED_BYTES) throw new Error('Iroh receive limit exceeded.');
    this.receivingBytes += size;
    try {
      const bytes = Buffer.allocUnsafe(size);
      for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
        const chunk = await stream.recv.readExact(Math.min(CHUNK_BYTES, size - offset));
        bytes.set(chunk, offset);
      }
      return bytes;
    } finally { this.receivingBytes -= size; }
  }

  private async readFrames(peerId: string, peer: PeerStream): Promise<void> {
    while (!this.stopped && this.connections.get(peerId) === peer) {
      const bytes = await this.readPacket(peer.stream, MAX_PACKET_BYTES);
      if (!this.stopped && this.connections.get(peerId) === peer) this.onFrame(peerId, bytes);
    }
  }
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Iroh negotiation timed out.')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
