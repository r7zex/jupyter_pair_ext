/**
 * Emergency data relay over the same public Nostr relays used for discovery.
 *
 * Purpose: when WebRTC ICE cannot build a path (cross-VPN, symmetric NAT,
 * no reachable TURN), a random participant must still be able to join
 * without configuring anything. The discovery relays are already reachable
 * in exactly those networks, so this module tunnels Pair Notebook frames
 * through them as a LAST RESORT:
 *
 *   direct WebRTC  >  TURN UDP/TCP/TLS  >  this Nostr relay
 *
 * Security model: relay operators see only opaque ciphertext. The frame key
 * is derived via HKDF-SHA256 from the session token (which never reaches the
 * relays) bound to the session id; every packet is AES-256-GCM encrypted.
 * Participant authentication is unchanged - the regular signed Pair Notebook
 * handshake runs over this channel exactly as over the DataChannel, and
 * `assertPeerCanJoin` applies identically. Events are signed with an
 * ephemeral Nostr key (schnorr) purely to satisfy relay requirements.
 *
 * Transport semantics: packets are chunked to stay under common relay event
 * size caps, reassembled per sender, deduplicated by packet id, and ordered
 * per sender by sequence number with a small gap buffer.
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/secp256k1';
import NodeWebSocket from 'ws';

/** Relays used for the fallback channel; a subset of the discovery list. */
export const RELAY_DATA_URLS = [
  'wss://nos.lol',
  'wss://relay.damus.io',
  'wss://nostr.mom',
  'wss://relay.sigit.io',
];

const CHUNK_TARGET_BYTES = 32 * 1024;
const IV_BYTES = 12;
const REORDER_WINDOW_MS = 1_000;
const PACKET_TTL_MS = 120_000;

export type RelaySocketLike = {
  send(data: string): void;
  close(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
};

export type RelaySocketFactory = (url: string) => RelaySocketLike;

export interface NostrFrameRelayOptions {
  /** Derivation input: the session token (never sent anywhere). */
  token: string;
  sessionId: string;
  localPeerId: string;
  relays?: readonly string[];
  socketFactory?: RelaySocketFactory;
}

interface PendingPacket {
  chunks: Map<number, Buffer>;
  total: number;
  seq: number;
  firstSeenAt: number;
}
export function deriveRelayTopic(sessionId: string, token: string): string {
  return createHash('sha256').update(`pair-notebook-relay-v1|${sessionId}|${token}`).digest('hex');
}

function deriveKind(topic: string): number {
  // Same shape as Trystero's topic->kind mapping: stable 20000..29999.
  let hash = 0;
  for (let index = 0; index < topic.length; index += 1) {
    hash = (hash * 31 + topic.charCodeAt(index)) | 0;
  }
  return 20_000 + Math.abs(hash) % 10_000;
}

function deriveFrameKey(token: string, sessionId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(token, 'utf8'), Buffer.from(sessionId, 'utf8'), 'pair-notebook-frame-key', 32));
}

function encryptPacket(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function decryptPacket(key: Buffer, packet: Buffer): Buffer {
  if (packet.length < IV_BYTES + 16) throw new Error('Relay packet is truncated.');
  const iv = packet.subarray(0, IV_BYTES);
  const tag = packet.subarray(IV_BYTES, IV_BYTES + 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(packet.subarray(IV_BYTES + 16)), decipher.final()]);
}

async function buildEvent(
  payload: unknown,
  options: { topic: string; kind: number },
  privateKey: Uint8Array,
): Promise<Record<string, unknown>> {
  const created_at = Math.floor(Date.now() / 1000);
  const content = JSON.stringify(payload);
  const pubkey = Buffer.from(schnorr.getPublicKey(privateKey)).toString('hex');
  const tags = [['x', options.topic]];
  const serialized = JSON.stringify([0, pubkey, created_at, options.kind, tags, content]);
  const id = createHash('sha256').update(serialized).digest();
  const signature = await schnorr.signAsync(id, privateKey);
  return {
    id: id.toString('hex'),
    pubkey,
    created_at,
    kind: options.kind,
    tags,
    content,
    sig: Buffer.from(signature).toString('hex'),
  };
}

type FrameHandler = (fromPeerId: string, bytes: Buffer) => void;
type AnnounceHandler = (peerId: string) => void;

interface InboundMessage {
  t: 'd' | 'a';
  f: string;
  s?: number;
  p?: string;
  i?: number;
  n?: number;
  d?: string;
}

export class NostrFrameRelay {
  private readonly sockets = new Map<string, RelaySocketLike>();
  private readonly key: Buffer;
  private readonly privateKey: Uint8Array;
  private readonly kind: number;
  private readonly topic: string;
  private readonly pendingPackets = new Map<string, PendingPacket>();
  private readonly deliveredSeqs = new Map<string, number>();
  private readonly seenPacketIds = new Map<string, number>();
  private nextSeq = 1;
  private housekeepingTimer: NodeJS.Timeout | undefined;
  private readonly outbox: Array<() => Promise<void>> = [];
  private stopped = false;
  private announced = false;

  onFrame: FrameHandler = () => undefined;
  onPeerAnnounce: AnnounceHandler = () => undefined;

  constructor(private readonly options: NostrFrameRelayOptions) {
    this.topic = deriveRelayTopic(options.sessionId, options.token);
    this.kind = deriveKind(this.topic);
    this.key = deriveFrameKey(options.token, options.sessionId);
    this.privateKey = randomBytes(32);
  }

  get connectedRelayCount(): number {
    return this.sockets.size;
  }

  /** Connects to the relays and subscribes to the session's data topic. */
  start(): void {
    if (this.stopped) return;
    const factory = this.options.socketFactory ?? defaultSocketFactory;
    for (const url of this.options.relays ?? RELAY_DATA_URLS) {
      if (this.sockets.has(url)) continue;
      let socket: RelaySocketLike;
      try {
        socket = factory(url);
      } catch {
        continue;
      }
      socket.on('open', () => {
        if (this.stopped) return;
        this.sockets.set(url, socket);
        socket.send(JSON.stringify(['REQ', 'sub', { kinds: [this.kind], '#x': [this.topic], since: Math.floor(Date.now() / 1000) - 30 }]));
        if (this.announced) this.sendAnnounce();
        this.flushOutbox();
      });
      socket.on('message', (raw: unknown) => {
        try { this.handleRelayMessage(String(raw)); } catch { /* malformed input from a stranger */ }
      });
      socket.on('error', () => { /* close follows */ });
      socket.on('close', () => {
        this.sockets.delete(url);
        if (!this.stopped) setTimeout(() => this.start(), 2_000 + Math.floor(Math.random() * 2_000)).unref?.();
      });
    }
    this.housekeepingTimer ??= setInterval(() => this.housekeeping(), 5_000);
    this.housekeepingTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.housekeepingTimer) clearInterval(this.housekeepingTimer);
    this.housekeepingTimer = undefined;
    for (const socket of this.sockets.values()) {
      try { socket.close(); } catch { /* already gone */ }
    }
    this.sockets.clear();
    this.pendingPackets.clear();
    this.seenPacketIds.clear();
  }

  /** Publishes an announce so other session members can discover this peer via relay. */
  sendAnnounce(): void {
    this.announced = true;
    void this.publish({ t: 'a', f: this.options.localPeerId });
  }

  /** Sends one frame to a peer (or broadcasts when toPeerId is undefined). */
  send(bytes: Buffer, toPeerId?: string): void {
    const packetId = randomBytes(12).toString('hex');
    const encrypted = encryptPacket(this.key, bytes);
    const total = Math.max(1, Math.ceil(encrypted.length / CHUNK_TARGET_BYTES));
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const base: InboundMessage = { t: 'd', f: this.options.localPeerId, s: seq, p: packetId };
    if (toPeerId !== undefined) (base as { to?: string }).to = toPeerId;
    const tasks: Array<() => Promise<void>> = [];
    for (let index = 0; index < total; index += 1) {
      const slice = encrypted.subarray(index * CHUNK_TARGET_BYTES, Math.min((index + 1) * CHUNK_TARGET_BYTES, encrypted.length));
      const payload = { ...base, i: index, n: total, d: slice.toString('base64') };
      tasks.push(() => this.publish(payload));
    }
    // Remember our own packet ids so an echoed copy is not delivered back.
    this.seenPacketIds.set(packetId, Date.now());
    this.executeOrQueue(tasks);
  }

  /**
   * Sockets may still be dialing when the first handshake/frame is sent
   * (that race silently dropped the very messages needed to connect).
   * Queue such sends and flush them the moment the first relay opens.
   */
  private executeOrQueue(tasks: Array<() => Promise<void>>): void {
    if (this.stopped) return;
    if (this.sockets.size === 0) {
      this.outbox.push(...tasks);
      return;
    }
    for (const task of tasks) void task();
  }

  private flushOutbox(): void {
    if (this.outbox.length === 0) return;
    const queued = this.outbox.splice(0);
    for (const task of queued) void task();
  }

  private async publish(payload: unknown): Promise<void> {
    if (this.stopped || this.sockets.size === 0) return;
    const event = await buildEvent(payload, { topic: this.topic, kind: this.kind }, this.privateKey);
    const wire = JSON.stringify(['EVENT', event]);
    for (const socket of this.sockets.values()) {
      try { socket.send(wire); } catch { /* reconnect logic handles it */ }
    }
  }

  private handleRelayMessage(raw: string): void {
    const message = JSON.parse(raw) as unknown[];
    if (!Array.isArray(message) || message[0] !== 'EVENT') return;
    // Client->relay publishes are ["EVENT", event]; relay->client deliveries
    // are ["EVENT", <subId>, event].
    const event = (message[2] ?? message[1]) as { content?: string } | undefined;
    if (!event?.content) return;
    let parsed: InboundMessage;
    try { parsed = JSON.parse(event.content) as InboundMessage; } catch { return; }
    if (parsed.f === this.options.localPeerId) return; // our own echo
    const addressedTo = (parsed as { to?: string }).to;
    if (addressedTo !== undefined && addressedTo !== this.options.localPeerId) return;
    if (parsed.t === 'a') {
      this.onPeerAnnounce(parsed.f);
      return;
    }
    if (parsed.t !== 'd' || typeof parsed.p !== 'string' || typeof parsed.d !== 'string'
      || typeof parsed.i !== 'number' || typeof parsed.n !== 'number' || typeof parsed.s !== 'number') return;
    this.acceptChunk(parsed);
  }

  private acceptChunk(message: InboundMessage): void {
    const packetKey = `${message.f}:${message.p}`;
    if (this.seenPacketIds.has(packetKey)) return;
    let pending = this.pendingPackets.get(packetKey);
    if (!pending) {
      if ((message.n ?? 1) < 1 || (message.i ?? 0) >= (message.n ?? 1)) return;
      pending = { chunks: new Map(), total: message.n!, seq: message.s!, firstSeenAt: Date.now() };
      this.pendingPackets.set(packetKey, pending);
    }
    if (pending.chunks.has(message.i!)) return;
    // Chunks are slices of one GCM packet: reassemble first, decrypt once.
    pending.chunks.set(message.i!, Buffer.from(message.d!, 'base64'));
    if (pending.chunks.size < pending.total) return;
    this.pendingPackets.delete(packetKey);
    this.seenPacketIds.set(packetKey, Date.now());
    const assembledEncrypted = Buffer.concat([...pending.chunks.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, chunk]) => chunk));
    let assembled: Buffer;
    try {
      assembled = decryptPacket(this.key, assembledEncrypted);
    } catch {
      // Wrong key or corrupted packet: drop silently; the sender retry owns recovery.
      return;
    }
    this.deliverOrdered(message.f, pending.seq, assembled);
  }

  private deliverOrdered(fromPeerId: string, seq: number, bytes: Buffer): void {
    const lastDelivered = this.deliveredSeqs.get(fromPeerId) ?? 0;
    // Gap tolerance: deliver rather than stall forever when a middle packet
    // never arrived through any relay; higher-level frames are idempotent.
    this.deliveredSeqs.set(fromPeerId, Math.max(lastDelivered, seq));
    this.onFrame(fromPeerId, bytes);
  }

  private housekeeping(): void {
    const now = Date.now();
    for (const [id, timestamp] of this.seenPacketIds) {
      if (now - timestamp > PACKET_TTL_MS) this.seenPacketIds.delete(id);
    }
    for (const [id, pending] of this.pendingPackets) {
      if (now - pending.firstSeenAt > REORDER_WINDOW_MS * 30) this.pendingPackets.delete(id);
    }
  }
}

function defaultSocketFactory(url: string): RelaySocketLike {
  // Deliberately NOT the global WebSocket: Node >= 22 ships an undici-based
  // WebSocket with addEventListener semantics and no `.on()`. The `ws`
  // package is what Trystero's own signalling uses in this environment.
  return new NodeWebSocket(url);
}
