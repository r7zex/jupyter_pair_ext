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

import { createHash, randomBytes } from 'node:crypto';
import { schnorr } from '@noble/secp256k1';
import { MAX_WIRE_FRAME_BYTES } from '../core/wire';
import { type FrameRelay } from './frameRelay';
import { createProxiedNodeWebSocket } from './proxyWebSocket';
import {
  decryptRelayPacket,
  deriveRelayFrameKey,
  encryptRelayPacket,
  encryptRelayReadinessProbe,
  verifyRelayReadinessProbe,
} from './relayCrypto';

/** Relays used for the fallback channel; a subset of the discovery list. */
export const RELAY_DATA_URLS = [
  'wss://nos.lol',
  'wss://relay.sigit.io',
  'wss://nostr.mom',
  'wss://nostr.data.haus',
];

const CHUNK_TARGET_BYTES = 32 * 1024;
const REORDER_WINDOW_MS = 1_000;
const PACKET_TTL_MS = 120_000;
const MAX_RELAY_CHUNKS = Math.ceil((MAX_WIRE_FRAME_BYTES + 12 + 16) / CHUNK_TARGET_BYTES);
const MAX_RELAY_CHUNK_BASE64_CHARS = Math.ceil(CHUNK_TARGET_BYTES * 4 / 3) + 4;
const MAX_PENDING_PACKETS = 256;
const MAX_PENDING_PACKET_BYTES = 128 * 1024 * 1024;
const MAX_OUTBOX_MESSAGES = 8_192;
const MAX_OUTBOX_BYTES = 256 * 1024 * 1024;
const MAX_SEEN_PACKET_IDS = 32_768;
const DEFAULT_READINESS_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_READINESS_RECHECK_MS = 45_000;
const PEER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PACKET_ID_PATTERN = /^[a-f0-9]{24}$/;

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
  /** Test hooks; production uses conservative network-scale defaults. */
  readinessProbeTimeoutMs?: number;
  readinessRecheckMs?: number;
  reconnectDelayMs?: number;
}

interface PendingPacket {
  chunks: Map<number, Buffer>;
  total: number;
  seq: number;
  firstSeenAt: number;
  bytes: number;
}

interface QueuedPayload {
  payload: unknown;
  bytes: number;
}

interface PendingReadinessProbe {
  nonce: string;
  eventId: string;
  timer: NodeJS.Timeout;
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
  t: 'd' | 'a' | 'r';
  f: string;
  s?: number;
  p?: string;
  i?: number;
  n?: number;
  d?: string;
}

export class NostrFrameRelay implements FrameRelay {
  /** Includes both dialing and open sockets so start() cannot duplicate dials. */
  private readonly sockets = new Map<string, RelaySocketLike>();
  private readonly openSockets = new Set<RelaySocketLike>();
  private readonly pendingReadiness = new Map<RelaySocketLike, PendingReadinessProbe>();
  private readonly lastVerifiedAt = new Map<RelaySocketLike, number>();
  private readonly key: Buffer;
  private readonly privateKey: Uint8Array;
  private readonly kind: number;
  private readonly topic: string;
  private readonly pendingPackets = new Map<string, PendingPacket>();
  private readonly deliveredSeqs = new Map<string, number>();
  private readonly seenPacketIds = new Map<string, number>();
  private nextSeq = 1;
  private housekeepingTimer: NodeJS.Timeout | undefined;
  private readonly outbox: QueuedPayload[] = [];
  private outboxBytes = 0;
  private pendingPacketBytes = 0;
  private stopped = false;
  private announced = false;

  onFrame: FrameHandler = () => undefined;
  onPeerAnnounce: AnnounceHandler = () => undefined;

  constructor(private readonly options: NostrFrameRelayOptions) {
    this.topic = deriveRelayTopic(options.sessionId, options.token);
    this.kind = deriveKind(this.topic);
    this.key = deriveRelayFrameKey(options.token, options.sessionId);
    this.privateKey = randomBytes(32);
  }

  get connectedRelayCount(): number {
    return this.openSockets.size;
  }

  async waitUntilReady(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.stopped && this.connectedRelayCount === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (this.connectedRelayCount === 0) {
      throw new Error('No Nostr emergency relay completed a verified data-path check.');
    }
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
      this.sockets.set(url, socket);
      socket.on('open', () => {
        if (this.stopped || this.sockets.get(url) !== socket) {
          try { socket.close(); } catch { /* already gone */ }
          return;
        }
        try {
          socket.send(JSON.stringify(['REQ', 'sub', { kinds: [this.kind], '#x': [this.topic], since: Math.floor(Date.now() / 1000) - 30 }]));
        } catch {
          try { socket.close(); } catch { /* close/reconnect owns recovery */ }
          return;
        }
        void this.beginReadinessProbe(url, socket);
      });
      socket.on('message', (raw: unknown) => {
        try { this.handleRelayMessage(String(raw), socket); } catch { /* malformed input from a stranger */ }
      });
      socket.on('error', () => { /* close follows */ });
      socket.on('close', () => {
        this.openSockets.delete(socket);
        this.clearPendingReadiness(socket);
        this.lastVerifiedAt.delete(socket);
        if (this.sockets.get(url) !== socket) return;
        this.sockets.delete(url);
        this.scheduleReconnect();
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
    this.openSockets.clear();
    for (const socket of this.pendingReadiness.keys()) this.clearPendingReadiness(socket);
    this.lastVerifiedAt.clear();
    this.pendingPackets.clear();
    this.pendingPacketBytes = 0;
    this.seenPacketIds.clear();
    this.outbox.splice(0);
    this.outboxBytes = 0;
  }

  /** Publishes an announce so other session members can discover this peer via relay. */
  sendAnnounce(): void {
    this.announced = true;
    void this.publish({ t: 'a', f: this.options.localPeerId });
  }

  /** Sends one frame to a peer (or broadcasts when toPeerId is undefined). */
  send(bytes: Buffer, toPeerId?: string): void {
    if (bytes.byteLength > MAX_WIRE_FRAME_BYTES) {
      throw new Error('Relay frame exceeds the Pair Notebook wire size limit.');
    }
    const packetId = randomBytes(12).toString('hex');
    const encrypted = encryptRelayPacket(this.key, bytes);
    const total = Math.max(1, Math.ceil(encrypted.length / CHUNK_TARGET_BYTES));
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const base: InboundMessage = { t: 'd', f: this.options.localPeerId, s: seq, p: packetId };
    if (toPeerId !== undefined) (base as { to?: string }).to = toPeerId;
    const payloads: unknown[] = [];
    for (let index = 0; index < total; index += 1) {
      const slice = encrypted.subarray(index * CHUNK_TARGET_BYTES, Math.min((index + 1) * CHUNK_TARGET_BYTES, encrypted.length));
      const payload = { ...base, i: index, n: total, d: slice.toString('base64') };
      payloads.push(payload);
    }
    this.executeOrQueue(payloads);
  }

  /**
   * Sockets may still be dialing when the first handshake/frame is sent
   * (that race silently dropped the very messages needed to connect).
   * Queue such sends and flush them the moment the first relay opens.
   */
  private executeOrQueue(payloads: unknown[]): void {
    if (this.stopped) return;
    if (this.openSockets.size === 0) {
      const queued = payloads.map((payload) => ({
        payload,
        bytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
      }));
      const addedBytes = queued.reduce((total, entry) => total + entry.bytes, 0);
      if (this.outbox.length + queued.length > MAX_OUTBOX_MESSAGES
        || this.outboxBytes + addedBytes > MAX_OUTBOX_BYTES) {
        throw new Error('Relay connection queue is full; wait for a relay to reconnect and retry.');
      }
      this.outbox.push(...queued);
      this.outboxBytes += addedBytes;
      return;
    }
    for (const payload of payloads) void this.publish(payload);
  }

  private flushOutbox(): void {
    if (this.outbox.length === 0) return;
    const queued = this.outbox.splice(0);
    this.outboxBytes = 0;
    for (const entry of queued) void this.publish(entry.payload);
  }

  private async publish(payload: unknown): Promise<void> {
    if (this.stopped || this.openSockets.size === 0) return;
    const event = await buildEvent(payload, { topic: this.topic, kind: this.kind }, this.privateKey);
    const wire = JSON.stringify(['EVENT', event]);
    for (const socket of this.openSockets) {
      try { socket.send(wire); } catch { /* reconnect logic handles it */ }
    }
  }

  private async beginReadinessProbe(url: string, socket: RelaySocketLike): Promise<void> {
    if (this.pendingReadiness.has(socket)) return;
    const nonce = randomBytes(12).toString('hex');
    try {
      const event = await buildEvent({
        t: 'r',
        f: this.options.localPeerId,
        p: nonce,
        d: encryptRelayReadinessProbe(this.key, nonce),
      } satisfies InboundMessage, { topic: this.topic, kind: this.kind }, this.privateKey);
      if (this.stopped || this.sockets.get(url) !== socket) return;
      const timer = setTimeout(() => {
        const pending = this.pendingReadiness.get(socket);
        if (pending?.nonce === nonce) this.rejectSocket(socket);
      }, this.options.readinessProbeTimeoutMs ?? DEFAULT_READINESS_PROBE_TIMEOUT_MS);
      timer.unref?.();
      this.pendingReadiness.set(socket, { nonce, eventId: String(event.id), timer });
      socket.send(JSON.stringify(['EVENT', event]));
    } catch {
      this.rejectSocket(socket);
    }
  }

  private handleRelayMessage(raw: string, socket: RelaySocketLike): void {
    const message = JSON.parse(raw) as unknown[];
    if (!Array.isArray(message)) return;
    if (message[0] === 'CLOSED' && message[1] === 'sub') {
      this.rejectSocket(socket);
      return;
    }
    if (message[0] === 'OK') {
      const pending = this.pendingReadiness.get(socket);
      if (message[2] !== true && !String(message[3] ?? '').startsWith('duplicate:')) {
        // A relay that rejects any valid Pair Notebook event is no longer a
        // usable data path, even if its WebSocket remains open.
        if (!pending || message[1] === pending.eventId || this.openSockets.has(socket)) {
          this.rejectSocket(socket);
        }
      }
      return;
    }
    if (message[0] !== 'EVENT') return;
    // Client->relay publishes are ["EVENT", event]; relay->client deliveries
    // are ["EVENT", <subId>, event].
    const event = (message[2] ?? message[1]) as { content?: string } | undefined;
    if (!event?.content) return;
    let parsed: InboundMessage;
    try { parsed = JSON.parse(event.content) as InboundMessage; } catch { return; }
    if (typeof parsed.f !== 'string' || !PEER_ID_PATTERN.test(parsed.f)) return;
    if (parsed.t === 'r') {
      const pending = this.pendingReadiness.get(socket);
      if (!pending || parsed.f !== this.options.localPeerId || parsed.p !== pending.nonce
        || typeof parsed.d !== 'string' || parsed.d.length > 512
        || !verifyRelayReadinessProbe(this.key, pending.nonce, parsed.d)) return;
      this.clearPendingReadiness(socket);
      this.openSockets.add(socket);
      this.lastVerifiedAt.set(socket, Date.now());
      if (this.announced) this.sendAnnounce();
      this.flushOutbox();
      return;
    }
    if (parsed.f === this.options.localPeerId) return; // our own data/announce echo
    const addressedTo = (parsed as { to?: string }).to;
    if (addressedTo !== undefined && addressedTo !== this.options.localPeerId) return;
    if (parsed.t === 'a') {
      this.onPeerAnnounce(parsed.f);
      return;
    }
    if (parsed.t !== 'd' || typeof parsed.p !== 'string' || !PACKET_ID_PATTERN.test(parsed.p)
      || typeof parsed.d !== 'string' || parsed.d.length > MAX_RELAY_CHUNK_BASE64_CHARS
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(parsed.d) || parsed.d.length % 4 !== 0
      || !Number.isSafeInteger(parsed.i) || !Number.isSafeInteger(parsed.n) || !Number.isSafeInteger(parsed.s)
      || parsed.i! < 0 || parsed.n! < 1 || parsed.n! > MAX_RELAY_CHUNKS || parsed.i! >= parsed.n! || parsed.s! < 1) return;
    this.acceptChunk(parsed);
  }

  private rejectSocket(socket: RelaySocketLike): void {
    this.openSockets.delete(socket);
    this.clearPendingReadiness(socket);
    this.lastVerifiedAt.delete(socket);
    for (const [url, candidate] of this.sockets) {
      if (candidate !== socket) continue;
      this.sockets.delete(url);
      this.scheduleReconnect();
      break;
    }
    try { socket.close(); } catch { /* close/reconnect owns recovery */ }
  }

  private acceptChunk(message: InboundMessage): void {
    const packetKey = `${message.f}:${message.p}`;
    if (this.seenPacketIds.has(packetKey)) return;
    const chunk = Buffer.from(message.d!, 'base64');
    if (chunk.byteLength === 0 || chunk.byteLength > CHUNK_TARGET_BYTES) return;
    let pending = this.pendingPackets.get(packetKey);
    if (!pending) {
      if (this.pendingPackets.size >= MAX_PENDING_PACKETS) return;
      pending = { chunks: new Map(), total: message.n!, seq: message.s!, firstSeenAt: Date.now(), bytes: 0 };
      this.pendingPackets.set(packetKey, pending);
    }
    if (pending.total !== message.n || pending.seq !== message.s) return;
    if (pending.chunks.has(message.i!)) return;
    if (this.pendingPacketBytes + chunk.byteLength > MAX_PENDING_PACKET_BYTES) return;
    // Chunks are slices of one GCM packet: reassemble first, decrypt once.
    pending.chunks.set(message.i!, chunk);
    pending.bytes += chunk.byteLength;
    this.pendingPacketBytes += chunk.byteLength;
    if (pending.chunks.size < pending.total) return;
    this.pendingPackets.delete(packetKey);
    this.pendingPacketBytes -= pending.bytes;
    this.rememberSeen(packetKey);
    const assembledEncrypted = Buffer.concat([...pending.chunks.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, chunk]) => chunk));
    let assembled: Buffer;
    try {
      assembled = decryptRelayPacket(this.key, assembledEncrypted);
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
      if (now - pending.firstSeenAt > REORDER_WINDOW_MS * 30) {
        this.pendingPackets.delete(id);
        this.pendingPacketBytes -= pending.bytes;
      }
    }
    const recheckMs = this.options.readinessRecheckMs ?? DEFAULT_READINESS_RECHECK_MS;
    for (const [url, socket] of this.sockets) {
      if (!this.openSockets.has(socket) || this.pendingReadiness.has(socket)) continue;
      if (now - (this.lastVerifiedAt.get(socket) ?? 0) >= recheckMs) {
        void this.beginReadinessProbe(url, socket);
      }
    }
  }

  private clearPendingReadiness(socket: RelaySocketLike): void {
    const pending = this.pendingReadiness.get(socket);
    if (pending) clearTimeout(pending.timer);
    this.pendingReadiness.delete(socket);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delayMs = this.options.reconnectDelayMs ?? (2_000 + Math.floor(Math.random() * 2_000));
    setTimeout(() => this.start(), delayMs).unref?.();
  }

  private rememberSeen(packetKey: string): void {
    this.seenPacketIds.delete(packetKey);
    this.seenPacketIds.set(packetKey, Date.now());
    while (this.seenPacketIds.size > MAX_SEEN_PACKET_IDS) {
      const oldest = this.seenPacketIds.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.seenPacketIds.delete(oldest);
    }
  }
}

function defaultSocketFactory(url: string): RelaySocketLike {
  // Deliberately NOT the global WebSocket: Node >= 22 ships an undici-based
  // WebSocket with addEventListener semantics and no `.on()`. This helper
  // builds a `ws` socket through the SAME proxy resolution as Trystero
  // signalling, so the emergency relay works on proxy-only networks too.
  return createProxiedNodeWebSocket(url);
}
