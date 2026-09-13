import { createHash } from 'node:crypto';
import { type FrameRelay, type FrameRelayOptions } from './frameRelay';
import { MqttFrameRelay } from './mqttFrameRelay';
import { NostrFrameRelay } from './nostrRelay';
import { IrohFrameRelay } from './irohFrameRelay';
import type { PeerIdentity } from '../core/types';

const DEDUPE_TTL_MS = 120_000;
const MAX_DEDUPE_ENTRIES = 65_536;
const ANNOUNCE_DEDUPE_MS = 500;
const MAX_ANNOUNCED_PEERS = 1_024;

export interface RedundantFrameRelayOptions extends FrameRelayOptions {
  channels?: readonly FrameRelay[];
  identityPrivateKey?: string;
  peers?: readonly PeerIdentity[];
  disableIroh?: boolean;
}

/**
 * Fans frames across independent Nostr, MQTT and Iroh transports. Identical frames
 * returned through several brokers/relays are collapsed before the identity
 * protocol sees them.
 */
export class RedundantFrameRelay implements FrameRelay {
  private readonly relays: readonly FrameRelay[];
  private readonly failedStarts = new Map<FrameRelay, Error>();
  private readonly seenFrames = new Map<string, number>();
  private readonly announcedPeers = new Map<string, number>();
  private housekeepingTimer: NodeJS.Timeout | undefined;

  onFrame: (fromPeerId: string, bytes: Buffer) => void = () => undefined;
  onPeerAnnounce: (peerId: string) => void = () => undefined;

  constructor(options: RedundantFrameRelayOptions) {
    this.relays = options.channels ?? [
      new NostrFrameRelay(options),
      new MqttFrameRelay(options),
      ...(options.identityPrivateKey && !options.disableIroh
        ? [new IrohFrameRelay({ ...options, identityPrivateKey: options.identityPrivateKey })] : []),
    ];
    for (const relay of this.relays) {
      relay.onFrame = (fromPeerId, bytes) => this.acceptFrame(fromPeerId, bytes);
      relay.onPeerAnnounce = (peerId) => this.acceptAnnounce(peerId);
    }
  }

  get connectedRelayCount(): number {
    return this.relays.reduce((total, relay) => total + relay.connectedRelayCount, 0);
  }

  updateDirectory(peers: readonly PeerIdentity[]): void {
    for (const relay of this.relays) relay.updateDirectory?.(peers);
  }

  diagnostics(): Record<string, unknown> {
    return { paths: this.relays.map((relay) => ({
      ...(relay.diagnostics?.() ?? { transport: relay.constructor.name, ready: relay.connectedRelayCount > 0 }),
      ...(this.failedStarts.has(relay) ? { startupError: this.failedStarts.get(relay)!.message } : {}),
    })) };
  }

  start(): void {
    for (const relay of this.relays) {
      try { relay.start(); this.failedStarts.delete(relay); }
      catch (error) { this.failedStarts.set(relay, asError(error)); }
    }
    this.housekeepingTimer ??= setInterval(() => this.housekeeping(), 10_000);
    this.housekeepingTimer.unref?.();
  }

  stop(): void {
    if (this.housekeepingTimer) clearInterval(this.housekeepingTimer);
    this.housekeepingTimer = undefined;
    for (const relay of this.relays) relay.stop();
    this.seenFrames.clear();
    this.announcedPeers.clear();
  }

  async waitUntilReady(timeoutMs = 15_000): Promise<void> {
    const readinessChecks = this.relays
      .filter((relay) => !this.failedStarts.has(relay) && relay.waitUntilReady !== undefined)
      .map((relay) => relay.waitUntilReady!(timeoutMs));
    if (this.failedStarts.size === this.relays.length) throw new Error('No relay transport could start.');
    if (readinessChecks.length === 0) return;
    try {
      // Either family is a complete data path. Requiring both would turn a
      // transient outage in one public infrastructure into an avoidable join
      // failure even though the other family can carry the whole session.
      await Promise.any(readinessChecks);
    } catch (error) {
      const reasons = error instanceof AggregateError
        ? error.errors.map((reason) => asError(reason).message).join(' ')
        : asError(error).message;
      throw new Error(`No emergency relay family became ready. ${reasons}`);
    }
  }

  sendAnnounce(): void {
    const errors: Error[] = [];
    for (const relay of this.relays) {
      try { relay.sendAnnounce(); } catch (error) { errors.push(asError(error)); }
    }
    if (errors.length === this.relays.length && errors[0]) throw errors[0];
  }

  send(bytes: Buffer, toPeerId?: string): void {
    const errors: Error[] = [];
    for (const relay of this.relays) {
      try { relay.send(bytes, toPeerId); } catch (error) { errors.push(asError(error)); }
    }
    if (errors.length === this.relays.length && errors[0]) throw errors[0];
  }

  private acceptFrame(fromPeerId: string, bytes: Buffer): void {
    const key = createHash('sha256').update(fromPeerId).update('\0').update(bytes).digest('hex');
    if (this.seenFrames.has(key)) return;
    this.seenFrames.set(key, Date.now());
    while (this.seenFrames.size > MAX_DEDUPE_ENTRIES) {
      const oldest = this.seenFrames.keys().next().value as string | undefined;
      if (!oldest) break;
      this.seenFrames.delete(oldest);
    }
    this.onFrame(fromPeerId, bytes);
  }

  private acceptAnnounce(peerId: string): void {
    const now = Date.now();
    if (now - (this.announcedPeers.get(peerId) ?? 0) < ANNOUNCE_DEDUPE_MS) return;
    if (!this.announcedPeers.has(peerId) && this.announcedPeers.size >= MAX_ANNOUNCED_PEERS) return;
    this.announcedPeers.set(peerId, now);
    this.onPeerAnnounce(peerId);
  }

  private housekeeping(): void {
    const oldest = Date.now() - DEDUPE_TTL_MS;
    for (const [key, timestamp] of this.seenFrames) {
      if (timestamp < oldest) this.seenFrames.delete(key);
    }
    for (const [peerId, timestamp] of this.announcedPeers) {
      if (timestamp < oldest) this.announcedPeers.delete(peerId);
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
