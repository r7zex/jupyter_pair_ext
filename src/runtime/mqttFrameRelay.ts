/**
 * Encrypted emergency data relay over public MQTT-over-WebSocket brokers.
 *
 * This is independent from Nostr and from Trystero's MQTT signalling room:
 * it carries complete Pair Notebook wire frames when ICE/TURN cannot build a
 * data channel and Nostr is unreachable. Broker operators see only a random
 * topic and AES-256-GCM ciphertext derived from the session secret.
 */

import { createHash, randomBytes } from 'node:crypto';
import mqtt, { type IClientOptions, type IClientPublishOptions } from 'mqtt';
import { MAX_WIRE_FRAME_BYTES } from '../core/wire';
import { type FrameRelay } from './frameRelay';
import { defaultRelayUrls } from './mqttRoom';
import { proxyAwareMqttOptions } from './mqttProxy';
import { decryptRelayPacket, deriveRelayFrameKey, encryptRelayPacket } from './relayCrypto';

const CHUNK_TARGET_BYTES = 32 * 1024;
const PACKET_TTL_MS = 120_000;
const MAX_RELAY_CHUNKS = Math.ceil((MAX_WIRE_FRAME_BYTES + 12 + 16) / CHUNK_TARGET_BYTES);
const MAX_RELAY_CHUNK_BASE64_CHARS = Math.ceil(CHUNK_TARGET_BYTES * 4 / 3) + 4;
const MAX_PENDING_PACKETS = 256;
const MAX_PENDING_PACKET_BYTES = 128 * 1024 * 1024;
const MAX_OUTBOX_MESSAGES = 8_192;
const MAX_OUTBOX_BYTES = 256 * 1024 * 1024;
const MAX_SEEN_PACKET_IDS = 32_768;
const PEER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PACKET_ID_PATTERN = /^[a-f0-9]{24}$/;
const QOS_ONE: IClientPublishOptions = { qos: 1 };

export interface MqttRelayClient {
  connected: boolean;
  on(event: string, handler: (...args: any[]) => void): this;
  subscribe(
    topic: string,
    options: { qos: 1 },
    callback: (error?: Error | null) => void,
  ): unknown;
  publish(topic: string, payload: string, options: IClientPublishOptions): unknown;
  end(force?: boolean): unknown;
}

export interface MqttFrameRelayOptions {
  token: string;
  sessionId: string;
  localPeerId: string;
  brokers?: readonly string[];
  clientFactory?: (url: string, options: IClientOptions) => MqttRelayClient;
}

interface RelayMessage {
  v: 1;
  t: 'a' | 'd';
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

export function deriveMqttRelayTopic(sessionId: string, token: string): string {
  const digest = createHash('sha256')
    .update(`pair-notebook-mqtt-data-v1|${sessionId}|${token}`)
    .digest('hex');
  return `pair-notebook/data/v1/${digest}`;
}

export class MqttFrameRelay implements FrameRelay {
  private readonly clients = new Map<string, MqttRelayClient>();
  private readonly readyClients = new Set<MqttRelayClient>();
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
      throw new Error('No MQTT emergency broker completed a subscribed connection.');
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
        this.handleMessage(bytes);
      });
      client.on('offline', () => this.readyClients.delete(client));
      client.on('close', () => this.readyClients.delete(client));
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
    this.pendingPackets.clear();
    this.seenPacketIds.clear();
    this.outbox.splice(0);
    this.pendingPacketBytes = 0;
    this.outboxBytes = 0;
  }

  sendAnnounce(): void {
    this.announced = true;
    this.executeOrQueue([{ v: 1, t: 'a', f: this.options.localPeerId }]);
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
    try {
      client.subscribe(this.topic, { qos: 1 }, (error) => {
        if (this.stopped || error) return;
        this.readyClients.add(client);
        if (this.announced) this.publishWire(client, JSON.stringify({
          v: 1,
          t: 'a',
          f: this.options.localPeerId,
        } satisfies RelayMessage));
        this.flushOutbox();
      });
    } catch {
      this.readyClients.delete(client);
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
    try { client.publish(this.topic, wire, QOS_ONE); } catch { /* MQTT reconnect owns recovery */ }
  }

  private handleMessage(bytes: Buffer): void {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_RELAY_CHUNK_BASE64_CHARS + 1_024) return;
    let message: RelayMessage;
    try { message = JSON.parse(bytes.toString('utf8')) as RelayMessage; } catch { return; }
    if (message.v !== 1 || typeof message.f !== 'string'
      || !PEER_ID_PATTERN.test(message.f) || message.f === this.options.localPeerId) return;
    if (message.to !== undefined && message.to !== this.options.localPeerId) return;
    if (message.t === 'a') {
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
