/**
 * Encrypted emergency data relay over public MQTT-over-WebSocket brokers.
 *
 * This is independent from Nostr and from Trystero's MQTT signalling room:
 * it carries complete Pair Notebook wire frames when ICE/TURN cannot build a
 * data channel and Nostr is unreachable. Broker operators cannot read the
 * AES-256-GCM-encrypted frame content, but they can observe the stable topic,
 * routing ids, timing and packet sizes.
 */

import { createHash, randomBytes } from 'node:crypto';
import mqtt, { type IClientOptions, type IClientPublishOptions } from 'mqtt';
import { MAX_WIRE_FRAME_BYTES } from '../core/wire';
import { type FrameRelay } from './frameRelay';
import { defaultRelayUrls } from './mqttRoom';
import { proxyAwareMqttOptions } from './mqttProxy';
import {
  createRelayAnnounceProof,
  decryptRelayPacket,
  deriveRelayFrameKey,
  encryptRelayPacket,
  encryptRelayReadinessProbe,
  verifyRelayAnnounceProof,
  verifyRelayReadinessProbe,
} from './relayCrypto';

const CHUNK_TARGET_BYTES = 32 * 1024;
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
const DEFAULT_READINESS_RETRY_MS = 5_000;
const PEER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PACKET_ID_PATTERN = /^[a-f0-9]{24}$/;
const QOS_ONE: IClientPublishOptions = { qos: 1 };

export interface MqttRelayClient {
  connected: boolean;
  on(event: string, handler: (...args: any[]) => void): this;
  subscribe(
    topic: string,
    options: { qos: 1 },
    callback: (error?: Error | null, granted?: readonly MqttSubscriptionGrant[]) => void,
  ): unknown;
  publish(
    topic: string,
    payload: string,
    options: IClientPublishOptions,
    callback?: (error?: Error | null) => void,
  ): unknown;
  end(force?: boolean): unknown;
}

export interface MqttSubscriptionGrant {
  topic: string;
  qos: number;
}

export interface MqttFrameRelayOptions {
  token: string;
  sessionId: string;
  localPeerId: string;
  brokers?: readonly string[];
  clientFactory?: (url: string, options: IClientOptions) => MqttRelayClient;
  /** Test hooks; production uses conservative network-scale defaults. */
  readinessProbeTimeoutMs?: number;
  readinessRecheckMs?: number;
  readinessRetryMs?: number;
}

interface RelayMessage {
  v: 1;
  t: 'a' | 'd' | 'r';
  f: string;
  to?: string;
  p?: string;
  i?: number;
  n?: number;
  d?: string;
}

interface PendingPacket {
  chunks: Map<number, Buffer>;
  total: number;
  firstSeenAt: number;
  bytes: number;
}

interface QueuedMessage {
  wire: string;
  bytes: number;
}

interface PendingReadinessProbe {
  nonce: string;
  timer: NodeJS.Timeout;
}

export function deriveMqttRelayTopic(sessionId: string, token: string): string {
  const digest = createHash('sha256')
    .update(`pair-notebook-mqtt-data-v1|${sessionId}|${token}`)
    .digest('hex');
  return `pair-notebook/data/v1/${digest}`;
}

export class MqttFrameRelay implements FrameRelay {
  private readonly clients = new Map<string, MqttRelayClient>();
  private readonly readyClients = new Set<MqttRelayClient>();
  private readonly pendingReadiness = new Map<MqttRelayClient, PendingReadinessProbe>();
  private readonly lastVerifiedAt = new Map<MqttRelayClient, number>();
  private readonly readinessRetryTimers = new Map<MqttRelayClient, NodeJS.Timeout>();
  private readonly key: Buffer;
  private readonly topic: string;
  private readonly pendingPackets = new Map<string, PendingPacket>();
  private readonly seenPacketIds = new Map<string, number>();
  private readonly outbox: QueuedMessage[] = [];
  private pendingPacketBytes = 0;
  private outboxBytes = 0;
  private stopped = false;
  private announced = false;
  private housekeepingTimer: NodeJS.Timeout | undefined;

  onFrame: (fromPeerId: string, bytes: Buffer) => void = () => undefined;
  onPeerAnnounce: (peerId: string) => void = () => undefined;

  constructor(private readonly options: MqttFrameRelayOptions) {
    this.topic = deriveMqttRelayTopic(options.sessionId, options.token);
    this.key = deriveRelayFrameKey(options.token, options.sessionId);
  }

  get connectedRelayCount(): number {
    return this.readyClients.size;
  }

  async waitUntilReady(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.stopped && this.connectedRelayCount === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (this.connectedRelayCount === 0) {
      throw new Error('No MQTT emergency broker completed a verified data-path check.');
    }
  }

  start(): void {
    if (this.stopped) return;
    const factory = this.options.clientFactory ?? defaultClientFactory;
    for (const url of this.options.brokers ?? defaultRelayUrls) {
      if (this.clients.has(url)) continue;
      let client: MqttRelayClient;
      try {
        client = factory(url, proxyAwareMqttOptions({
          clean: true,
          connectTimeout: 10_000,
          reconnectPeriod: 2_000,
          reconnectOnConnackError: true,
          resubscribe: true,
        }));
      } catch {
        continue;
      }
      this.clients.set(url, client);
      client.on('connect', () => this.subscribeClient(client));
      client.on('message', (topic: unknown, payload: unknown) => {
        if (topic !== this.topic) return;
        const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
        this.handleMessage(bytes, client);
      });
      client.on('offline', () => this.clearClientReadiness(client));
      client.on('close', () => this.clearClientReadiness(client));
      client.on('error', () => undefined);
      if (client.connected) this.subscribeClient(client);
    }
    this.housekeepingTimer ??= setInterval(() => this.housekeeping(), 5_000);
    this.housekeepingTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.housekeepingTimer) clearInterval(this.housekeepingTimer);
    this.housekeepingTimer = undefined;
    for (const client of this.clients.values()) {
      try { client.end(true); } catch { /* already closed */ }
    }
    this.clients.clear();
    this.readyClients.clear();
    for (const client of this.pendingReadiness.keys()) this.clearPendingReadiness(client);
    this.lastVerifiedAt.clear();
    for (const timer of this.readinessRetryTimers.values()) clearTimeout(timer);
    this.readinessRetryTimers.clear();
    this.pendingPackets.clear();
    this.seenPacketIds.clear();
    this.outbox.splice(0);
    this.pendingPacketBytes = 0;
    this.outboxBytes = 0;
  }

  sendAnnounce(): void {
    this.announced = true;
    this.executeOrQueue([{
      v: 1,
      t: 'a',
      f: this.options.localPeerId,
      d: createRelayAnnounceProof(this.key, this.options.sessionId, this.options.localPeerId),
    }]);
  }

  send(bytes: Buffer, toPeerId?: string): void {
    if (bytes.byteLength > MAX_WIRE_FRAME_BYTES) {
      throw new Error('MQTT relay frame exceeds the Pair Notebook wire size limit.');
    }
    const encrypted = encryptRelayPacket(this.key, bytes);
    const packetId = randomBytes(12).toString('hex');
    const total = Math.max(1, Math.ceil(encrypted.byteLength / CHUNK_TARGET_BYTES));
    const messages: RelayMessage[] = [];
    for (let index = 0; index < total; index += 1) {
      const chunk = encrypted.subarray(
        index * CHUNK_TARGET_BYTES,
        Math.min((index + 1) * CHUNK_TARGET_BYTES, encrypted.byteLength),
      );
      messages.push({
        v: 1,
        t: 'd',
        f: this.options.localPeerId,
        ...(toPeerId ? { to: toPeerId } : {}),
        p: packetId,
        i: index,
        n: total,
        d: chunk.toString('base64'),
      });
    }
    this.executeOrQueue(messages);
  }

  private subscribeClient(client: MqttRelayClient): void {
    if (this.stopped) return;
    this.clearReadinessRetry(client);
    try {
      client.subscribe(this.topic, { qos: 1 }, (error, granted) => {
        if (this.stopped || error || !granted?.some((entry) => (
          entry.topic === this.topic && entry.qos === 1
        ))) {
          this.dropClientReadiness(client);
          this.scheduleReadinessRetry(client);
          return;
        }
        this.beginReadinessProbe(client);
      });
    } catch {
      this.dropClientReadiness(client);
      this.scheduleReadinessRetry(client);
    }
  }

  private executeOrQueue(messages: readonly RelayMessage[]): void {
    if (this.stopped) return;
    const queued = messages.map((message) => {
      const wire = JSON.stringify(message);
      return { wire, bytes: Buffer.byteLength(wire, 'utf8') };
    });
    if (this.readyClients.size === 0) {
      const addedBytes = queued.reduce((total, item) => total + item.bytes, 0);
      if (this.outbox.length + queued.length > MAX_OUTBOX_MESSAGES
        || this.outboxBytes + addedBytes > MAX_OUTBOX_BYTES) {
        throw new Error('MQTT relay queue is full; wait for a broker to reconnect and retry.');
      }
      this.outbox.push(...queued);
      this.outboxBytes += addedBytes;
      return;
    }
    for (const item of queued) this.publishAll(item.wire);
  }

  private flushOutbox(): void {
    if (this.outbox.length === 0 || this.readyClients.size === 0) return;
    const queued = this.outbox.splice(0);
    this.outboxBytes = 0;
    for (const item of queued) this.publishAll(item.wire);
  }

  private publishAll(wire: string): void {
    for (const client of this.readyClients) this.publishWire(client, wire);
  }

  private publishWire(client: MqttRelayClient, wire: string): void {
    try {
      client.publish(this.topic, wire, QOS_ONE, (error) => {
        if (!error) return;
        this.dropClientReadiness(client);
        this.scheduleReadinessRetry(client);
      });
    } catch {
      this.dropClientReadiness(client);
      this.scheduleReadinessRetry(client);
    }
  }

  private beginReadinessProbe(client: MqttRelayClient): void {
    if (this.pendingReadiness.has(client)) return;
    const nonce = randomBytes(12).toString('hex');
    const timer = setTimeout(() => {
      const pending = this.pendingReadiness.get(client);
      if (pending?.nonce !== nonce) return;
      this.dropClientReadiness(client);
      this.scheduleReadinessRetry(client);
    }, this.options.readinessProbeTimeoutMs ?? DEFAULT_READINESS_PROBE_TIMEOUT_MS);
    timer.unref?.();
    this.pendingReadiness.set(client, { nonce, timer });
    const wire = JSON.stringify({
      v: 1,
      t: 'r',
      f: this.options.localPeerId,
      p: nonce,
      d: encryptRelayReadinessProbe(this.key, nonce),
    } satisfies RelayMessage);
    try {
      client.publish(this.topic, wire, QOS_ONE, (error) => {
        if (error) {
          this.dropClientReadiness(client);
          this.scheduleReadinessRetry(client);
        }
      });
    } catch {
      this.dropClientReadiness(client);
      this.scheduleReadinessRetry(client);
    }
  }

  private handleMessage(bytes: Buffer, client: MqttRelayClient): void {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_RELAY_CHUNK_BASE64_CHARS + 1_024) return;
    let message: RelayMessage;
    try { message = JSON.parse(bytes.toString('utf8')) as RelayMessage; } catch { return; }
    if (message.v !== 1 || typeof message.f !== 'string' || !PEER_ID_PATTERN.test(message.f)) return;
    if (message.t === 'r') {
      const pending = this.pendingReadiness.get(client);
      if (!pending || message.f !== this.options.localPeerId || message.p !== pending.nonce
        || typeof message.d !== 'string' || message.d.length > 512
        || !verifyRelayReadinessProbe(this.key, pending.nonce, message.d)) return;
      this.clearPendingReadiness(client);
      this.readyClients.add(client);
      this.lastVerifiedAt.set(client, Date.now());
      if (this.announced) this.publishWire(client, JSON.stringify({
        v: 1,
        t: 'a',
        f: this.options.localPeerId,
        d: createRelayAnnounceProof(this.key, this.options.sessionId, this.options.localPeerId),
      } satisfies RelayMessage));
      this.flushOutbox();
      return;
    }
    if (message.f === this.options.localPeerId) return;
    if (message.to !== undefined && message.to !== this.options.localPeerId) return;
    if (message.t === 'a') {
      if (!verifyRelayAnnounceProof(this.key, this.options.sessionId, message.f, message.d)) return;
      this.onPeerAnnounce(message.f);
      return;
    }
    if (message.t !== 'd' || typeof message.p !== 'string' || !PACKET_ID_PATTERN.test(message.p)
      || typeof message.d !== 'string' || message.d.length > MAX_RELAY_CHUNK_BASE64_CHARS
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(message.d) || message.d.length % 4 !== 0
      || !Number.isSafeInteger(message.i) || !Number.isSafeInteger(message.n)
      || message.i! < 0 || message.n! < 1 || message.n! > MAX_RELAY_CHUNKS || message.i! >= message.n!) return;
    this.acceptChunk(message);
  }

  private dropClientReadiness(client: MqttRelayClient): void {
    this.readyClients.delete(client);
    this.clearPendingReadiness(client);
    this.lastVerifiedAt.delete(client);
  }

  private acceptChunk(message: RelayMessage): void {
    const packetKey = `${message.f}:${message.p}`;
    if (this.seenPacketIds.has(packetKey)) return;
    const chunk = Buffer.from(message.d!, 'base64');
    if (chunk.byteLength === 0 || chunk.byteLength > CHUNK_TARGET_BYTES) return;
    let pending = this.pendingPackets.get(packetKey);
    if (!pending) {
      if (this.pendingPackets.size >= MAX_PENDING_PACKETS) return;
      pending = { chunks: new Map(), total: message.n!, firstSeenAt: Date.now(), bytes: 0 };
      this.pendingPackets.set(packetKey, pending);
    }
    if (pending.total !== message.n || pending.chunks.has(message.i!)) return;
    if (this.pendingPacketBytes + chunk.byteLength > MAX_PENDING_PACKET_BYTES) return;
    pending.chunks.set(message.i!, chunk);
    pending.bytes += chunk.byteLength;
    this.pendingPacketBytes += chunk.byteLength;
    if (pending.chunks.size < pending.total) return;
    this.pendingPackets.delete(packetKey);
    this.pendingPacketBytes -= pending.bytes;
    this.rememberSeen(packetKey);
    const encrypted = Buffer.concat([...pending.chunks.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, value]) => value));
    try {
      this.onFrame(message.f, decryptRelayPacket(this.key, encrypted));
    } catch {
      // Wrong session key, corruption, or an injected public-broker packet.
    }
  }

  private housekeeping(): void {
    const now = Date.now();
    for (const [id, timestamp] of this.seenPacketIds) {
      if (now - timestamp > PACKET_TTL_MS) this.seenPacketIds.delete(id);
    }
    for (const [id, pending] of this.pendingPackets) {
      if (now - pending.firstSeenAt <= 30_000) continue;
      this.pendingPackets.delete(id);
      this.pendingPacketBytes -= pending.bytes;
    }
    const recheckMs = this.options.readinessRecheckMs ?? DEFAULT_READINESS_RECHECK_MS;
    for (const client of this.readyClients) {
      if (!this.pendingReadiness.has(client)
        && now - (this.lastVerifiedAt.get(client) ?? 0) >= recheckMs) {
        this.beginReadinessProbe(client);
      }
    }
  }

  private clearClientReadiness(client: MqttRelayClient): void {
    this.dropClientReadiness(client);
    this.clearReadinessRetry(client);
  }

  private clearPendingReadiness(client: MqttRelayClient): void {
    const pending = this.pendingReadiness.get(client);
    if (pending) clearTimeout(pending.timer);
    this.pendingReadiness.delete(client);
  }

  private scheduleReadinessRetry(client: MqttRelayClient): void {
    if (this.stopped || !client.connected || this.readinessRetryTimers.has(client)) return;
    const timer = setTimeout(() => {
      this.readinessRetryTimers.delete(client);
      if (!this.stopped && client.connected) this.subscribeClient(client);
    }, this.options.readinessRetryMs ?? DEFAULT_READINESS_RETRY_MS);
    timer.unref?.();
    this.readinessRetryTimers.set(client, timer);
  }

  private clearReadinessRetry(client: MqttRelayClient): void {
    const timer = this.readinessRetryTimers.get(client);
    if (timer) clearTimeout(timer);
    this.readinessRetryTimers.delete(client);
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

function defaultClientFactory(url: string, options: IClientOptions): MqttRelayClient {
  return mqtt.connect(url, options) as MqttRelayClient;
}
