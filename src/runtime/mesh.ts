import { EventEmitter } from 'node:events';
import { RTCPeerConnection as WeriftPeerConnection } from 'werift';
import {
  joinRoom,
  type HandshakePayload,
  type JoinError,
  type JoinRoomCallbacks,
  type MessageAction,
  type NostrRoomConfig,
  type Room,
} from 'trystero';
import {
  generateIdentityCredentials,
  newIdentityNonce,
  publicKeyFromPrivate,
  signIdentityTranscript,
  validateIdentityNonce,
  validateIdentityPublicKey,
  verifyIdentityTranscript,
} from '../core/identity';
import {
  ConnectionRoute,
  HostClock,
  PeerIdentity,
  PeerRuntime,
  cleanDisplayName,
  newId,
  normalizeDisplayName,
  validateDisplayName,
} from '../core/types';
import { decodeFrame, encodeFrame, MAX_WIRE_FRAME_BYTES, MAX_WIRE_HEADER_BYTES, WireFrame } from '../core/wire';
import {
  DEFAULT_TURN_URLS,
  orderTurnEndpoints,
  parseTurnEndpoints,
  probeTurnEndpoints,
  selectTurnEndpoints,
  type TurnEndpoint,
  type TurnProbeResult,
} from './turn';
import { describeProxy, resolveProxy, type ProxyDescriptor } from './proxy';
import { installProxyAwareWebSocket, type ProxyWebSocketRuntimeOptions } from './proxyWebSocket';

export const TRYSTERO_APP_ID = 'dev.pair-notebook.vscode.v2';
/**
 * Curated public Nostr relays used for peer discovery.
 *
 * Without an explicit list, Trystero picks five default relays
 * deterministically from the app id, and two of the five it currently picks
 * are offline, which stalls discovery for many seconds or breaks joining
 * entirely. This health-checked list keeps discovery fast and identical on
 * every participant. Order matters: the first RELAY_REDUNDANCY entries are
 * used, so keep the fastest relays first.
 */
export const TRYSTERO_RELAY_URLS = [
  'wss://nos.lol',
  'wss://relay.sigit.io',
  'wss://nostr.mom',
  'wss://relay.damus.io',
  'wss://nostr.data.haus',
  'wss://nostr.sathoarder.com',
  'wss://relay.primal.net',
  'wss://nostr.oxtr.dev',
  'wss://relay.orangepill.dev',
  'wss://offchain.pub',
];
/**
 * Default TURN relay endpoints, used as a last-resort connectivity fallback.
 *
 * Trystero's default STUN servers cannot traverse symmetric NATs or
 * restrictive firewalls, which made joins stall for a long time and then
 * fail with "could not connect to peer ... configure TURN servers".
 * Endpoints are ordered UDP -> TCP -> TLS; at runtime the first entry is
 * what the werift ICE stack actually uses (it consumes only one TURN URL),
 * so MeshTransport probes reachability and reorders this list in place,
 * always keeping direct peer-to-peer ICE preferred over relaying.
 * The list must stay compatible on every participant because ICE needs both
 * sides to attempt usable relays. The Open Relay (Metered) demo credentials
 * are publicly published by that provider for free-tier testing; they are
 * overridden via `pairNotebook.turnUrls` + secret storage in production.
 */
export const TRYSTERO_TURN_SERVERS = [
  {
    urls: [...DEFAULT_TURN_URLS],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

export interface MeshNetworkConfig {
  /** Overrides the default TURN endpoint URL list. */
  turnUrls?: readonly string[];
  turnUsername?: string;
  /** TURN credential; supplied from VS Code secret storage, never logged. */
  turnPassword?: string;
  /** Disables the live TURN Allocate probe when true. */
  disableTurnProbe?: boolean;
  /** Proxy options applied to signalling WebSockets. */
  proxy?: ProxyWebSocketRuntimeOptions;
}

const meshNetworkConfig: Required<Pick<MeshNetworkConfig, 'disableTurnProbe'>> & MeshNetworkConfig = {
  disableTurnProbe: false,
};

/**
 * Applies extension-level networking configuration (settings + secrets).
 * Safe to call again before any transport start; running transports keep
 * their captured configuration.
 */
export function configureMeshNetwork(config: MeshNetworkConfig): void {
  meshNetworkConfig.turnUrls = config.turnUrls;
  meshNetworkConfig.turnUsername = config.turnUsername;
  meshNetworkConfig.turnPassword = config.turnPassword;
  meshNetworkConfig.disableTurnProbe = config.disableTurnProbe ?? false;
  meshNetworkConfig.proxy = config.proxy;
}

const RELAY_REDUNDANCY = 8;
const HANDSHAKE_VERSION = 2;
const ACTION_NAMESPACE = 'pair-notebook-frame-v2';
const MAX_OUTBOUND_QUEUE = 128 * 1024 * 1024;
const MAX_TOTAL_OUTBOUND_QUEUE = 512 * 1024 * 1024;
const MAX_OUTBOUND_FRAMES = 16_384;
const MAX_TOTAL_OUTBOUND_FRAMES = 65_536;
const MAX_DIRECTORY_PEERS = 256;
const MAX_SEEN_IDS_PER_PEER = 2048;
const MAX_INBOUND_BYTES_PER_SECOND = 96 * 1024 * 1024;
const MAX_INBOUND_MESSAGES_PER_SECOND = 4096;
const MAX_TOTAL_INBOUND_BYTES_PER_SECOND = 256 * 1024 * 1024;
const MAX_TOTAL_INBOUND_MESSAGES_PER_SECOND = 8192;
const MAX_PENDING_HANDSHAKE_FRAMES = 64;
const MAX_PENDING_HANDSHAKE_BYTES = MAX_WIRE_FRAME_BYTES + 1024;
const MAX_TOTAL_PENDING_HANDSHAKE_BYTES = 128 * 1024 * 1024;
const PENDING_HANDSHAKE_TTL_MS = 30_000;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BULK_CHUNK_TYPES = new Set(['binaryChunk', 'snapshotFileChunk']);
const BOOTSTRAP_TO_RUNTIME_TYPES = new Set([
  'helloAck', 'snapshotRequest', 'snapshotCheckpointAck', 'appPing', 'appPong',
]);
const RUNTIME_TO_BOOTSTRAP_TYPES = new Set([
  'helloAck', 'peerAdmission', 'snapshotBegin', 'snapshotManifest', 'snapshotManifestEnd', 'snapshotDirectory',
  'snapshotFileStart', 'snapshotFileChunk', 'snapshotFileEnd', 'snapshotCheckpoint',
  'snapshotEnd', 'snapshotError', 'appPing', 'appPong',
]);
const SNAPSHOT_PROTOCOL_TYPES = new Set([
  'snapshotRequest', 'snapshotBegin', 'snapshotManifest', 'snapshotManifestEnd', 'snapshotDirectory',
  'snapshotFileStart', 'snapshotFileChunk', 'snapshotFileEnd', 'snapshotCheckpoint',
  'snapshotCheckpointAck', 'snapshotEnd', 'snapshotError',
]);

export type PeerConnectionPurpose = 'runtime' | 'bootstrap';

export interface MeshOptions {
  sessionId: string;
  token: string;
  localPeer: PeerIdentity;
  hostClock: () => HostClock;
  isHost: () => boolean;
  hostReady?: () => boolean;
  purpose?: PeerConnectionPurpose;
  roomFactory?: TrysteroRoomFactory;
  /** Required by production callers; omitted tests receive an ephemeral key. */
  identityPrivateKey?: string;
}

export type TrysteroRoomFactory = (
  config: NostrRoomConfig,
  roomId: string,
  callbacks?: JoinRoomCallbacks,
) => Room;

interface HandshakeMessage {
  version: number;
  sessionId: string;
  purpose: PeerConnectionPurpose;
  peer: PeerIdentity;
  nonce: string;
  admittedAt?: number;
}

interface HandshakeProof {
  version: number;
  signature: string;
}

interface ConnectedPeer {
  transportPeerId: string;
  identity: PeerIdentity;
  purpose: PeerConnectionPurpose;
  connectedAt: number;
  lastSeen: number;
  snapshotRequested: boolean;
}

interface QueuedFrame {
  bytes: Buffer;
  priority: FramePriority;
}

interface OutboundQueue {
  realtimeFrames: QueuedFrame[];
  bulkFrames: QueuedFrame[];
  queuedBytes: number;
  inFlightBytes: number;
  inFlightFrames: number;
  draining: boolean;
  failure?: Error;
}

interface InboundWindow {
  startedAt: number;
  bytes: number;
  messages: number;
}

interface PendingInboundFrames {
  frames: ArrayBuffer[];
  bytes: number;
}

type FramePriority = 'realtime' | 'bulk';

export interface MeshMetrics {
  bytesSentPerSecond: number;
  bytesReceivedPerSecond: number;
  totalBytesSent: number;
  totalBytesReceived: number;
  directPeers: number;
}

/**
 * Trystero-backed, fully connected WebRTC transport.
 *
 * Trystero owns discovery, encrypted signalling and RTCDataChannel lifecycle.
 * Pair Notebook keeps its existing binary frame protocol above the data channel
 * so CRDT, filesystem and execution logic remain transport-independent.
 */
export class MeshTransport extends EventEmitter {
  private static testingRoomFactory: TrysteroRoomFactory | undefined;

  private room: Room | undefined;
  private action: MessageAction<ArrayBuffer> | undefined;
  private readonly connections = new Map<string, ConnectedPeer>();
  private readonly identityToTransport = new Map<string, string>();
  private readonly pendingHandshakes = new Map<string, HandshakeMessage>();
  private readonly pendingInboundFrames = new Map<string, PendingInboundFrames>();
  private totalPendingInboundBytes = 0;
  private readonly directory = new Map<string, PeerIdentity>();
  private readonly seenIds = new Map<string, Map<string, number>>();
  private readonly inboundWindows = new Map<string, InboundWindow>();
  private globalInboundWindow: InboundWindow = { startedAt: Date.now(), bytes: 0, messages: 0 };
  private readonly latency = new Map<string, { current: number; ema: number }>();
  private readonly routes = new Map<string, ConnectionRoute>();
  private readonly outboundQueues = new Map<string, OutboundQueue>();
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private sentWindow = 0;
  private receivedWindow = 0;
  private totalSent = 0;
  private totalReceived = 0;
  private lastSentRate = 0;
  private lastReceivedRate = 0;
  private hasStarted = false;
  private pingInFlight = false;
  private turnEndpoints: TurnEndpoint[] | undefined;
  private turnProbes: TurnProbeResult[] | undefined;
  private readonly identityPrivateKey: string;

  public static setRoomFactoryForTesting(factory: TrysteroRoomFactory | undefined): void {
    MeshTransport.testingRoomFactory = factory;
  }

  public constructor(private readonly options: MeshOptions) {
    super();
    const initialIdentityError = validatePeerIdentity(options.localPeer);
    if (initialIdentityError) throw new Error(`Invalid local identity: ${initialIdentityError}`);
    const credentials = options.identityPrivateKey
      ? {
        privateKey: options.identityPrivateKey,
        publicKey: publicKeyFromPrivate(options.identityPrivateKey),
      }
      : generateIdentityCredentials();
    if (options.localPeer.identityKey && options.localPeer.identityKey !== credentials.publicKey) {
      throw new Error('The local identity key does not match its private key.');
    }
    options.localPeer = normalizedPeerIdentity({
      ...options.localPeer,
      identityKey: credentials.publicKey,
    });
    this.identityPrivateKey = credentials.privateKey;
    const identityError = validatePeerIdentity(options.localPeer, true);
    if (identityError) throw new Error(`Invalid local identity: ${identityError}`);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.sessionId)) {
      throw new Error('The session id has an unsupported format.');
    }
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(options.token)) {
      throw new Error('The session token has an unsupported format.');
    }
    this.directory.set(options.localPeer.peerId, options.localPeer);
  }

  /** Starts discovery. The numeric return value is retained for API compatibility and is always zero. */
  public async start(): Promise<number> {
    if (this.room) return 0;
    const restarting = this.hasStarted;
    this.stopped = false;
    ensureWebSocketRuntime();
    const callbacks: JoinRoomCallbacks = {
      handshakeTimeoutMs: 15_000,
      onPeerHandshake: async (transportPeerId, send, receive, isInitiator) => {
        const local = this.localHandshake();
        let incoming: HandshakePayload;
        if (isInitiator) {
          await send(local as unknown as Parameters<typeof send>[0]);
          incoming = await receive();
        } else {
          incoming = await receive();
          await send(local as unknown as Parameters<typeof send>[0]);
        }
        const remote = this.parseHandshake(incoming.data);
        const transcript = handshakeTranscript(
          isInitiator ? local : remote,
          isInitiator ? remote : local,
        );
        const localProof: HandshakeProof = {
          version: HANDSHAKE_VERSION,
          signature: signIdentityTranscript(this.identityPrivateKey, transcript),
        };
        let incomingProof: HandshakePayload;
        if (isInitiator) {
          await send(localProof as unknown as Parameters<typeof send>[0]);
          incomingProof = await receive();
        } else {
          incomingProof = await receive();
          await send(localProof as unknown as Parameters<typeof send>[0]);
        }
        const remoteProof = this.parseHandshakeProof(incomingProof.data);
        if (!verifyIdentityTranscript(remote.peer.identityKey!, transcript, remoteProof.signature)) {
          throw new Error(`Peer ${remote.peer.peerId} did not prove ownership of its identity key.`);
        }
        this.assertPeerCanJoin(remote.peer, transportPeerId);
        this.pendingHandshakes.set(transportPeerId, { ...remote, admittedAt: Date.now() });
      },
      onJoinError: (details) => this.onJoinError(details),
    };
    const config: NostrRoomConfig = {
      appId: TRYSTERO_APP_ID,
      password: this.options.token,
      rtcPolyfill: WeriftPeerConnection as unknown as NostrRoomConfig['rtcPolyfill'],
      relayConfig: {
        urls: TRYSTERO_RELAY_URLS,
        redundancy: RELAY_REDUNDANCY,
        warnOnRelayFailure: false,
      },
      turnConfig: this.buildTurnConfig(),
    };
    const factory = this.options.roomFactory ?? MeshTransport.testingRoomFactory ?? joinRoom;
    try {
      this.room = factory(config, this.options.sessionId, callbacks);
      this.action = this.room.makeAction<ArrayBuffer>(ACTION_NAMESPACE);
      this.action.onMessage = (data, { peerId }) => this.handleAction(data, peerId);
      this.room.onPeerJoin = (peerId) => this.onPeerJoin(peerId);
      this.room.onPeerLeave = (peerId) => this.onPeerLeave(peerId);
    } catch (error) {
      this.room = undefined;
      this.action = undefined;
      throw new Error(`Could not start Trystero: ${formatError(error)}`, { cause: error });
    }
    this.hasStarted = true;
    this.timers = [
      setInterval(() => this.heartbeatTick(), 500),
      setInterval(() => void this.pingTick(), 1000),
      setInterval(() => this.metricsTick(), 1000),
      setInterval(() => this.cleanupSeenIds(), 10_000),
    ];
    if (restarting) this.emit('restarted');
    return 0;
  }

  /**
   * Builds the Trystero TURN configuration from the configured endpoints.
   *
   * werift consumes only the first TURN URL of the resulting iceServers
   * list, so ordering is the selection mechanism: the static order is the
   * preferred UDP -> TCP -> TLS fallback chain, and a non-blocking live
   * Allocate probe reorders the same array in place once local reachability
   * is known. Peers connect seconds after discovery, so the reorder lands
   * before the first peer connection in practice; direct ICE remains
   * preferred by ordinary candidate priority regardless of TURN ordering.
   */
  private buildTurnConfig(): NostrRoomConfig['turnConfig'] {
    const urls = meshNetworkConfig.turnUrls?.length ? [...meshNetworkConfig.turnUrls] : DEFAULT_TURN_URLS;
    const username = meshNetworkConfig.turnUsername || TRYSTERO_TURN_SERVERS[0].username;
    const password = meshNetworkConfig.turnPassword || TRYSTERO_TURN_SERVERS[0].credential;
    const endpoints = parseTurnEndpoints(urls);
    if (endpoints.length === 0) return undefined;
    const ordered = orderTurnEndpoints(endpoints);
    const entry = {
      urls: ordered.map((endpoint) => endpoint.url),
      username,
      credential: password,
    };
    this.turnEndpoints = ordered;
    if (!meshNetworkConfig.disableTurnProbe) {
      void this.probeTurnEndpointsSafely(endpoints, entry, username, password);
    }
    return [entry];
  }

  /**
   * Runs the reachability probe without letting werift's internal socket
   * failures crash the extension host: unreachable TURN endpoints surface
   * TLS/TCP resets as unhandled rejections from library-internal promises
   * that are not tied to our awaited call. The guard swallows only network
   * errors during the probe window; anything else is re-thrown unchanged.
   */
  private async probeTurnEndpointsSafely(
    endpoints: readonly TurnEndpoint[],
    entry: { urls: string[] },
    username: string,
    password: string,
  ): Promise<void> {
    const guard = (reason: unknown): void => {
      const error = reason as { code?: string; message?: string } | undefined;
      const text = `${error?.code ?? ''} ${error?.message ?? String(reason)}`;
      if (/econnreset|etimedout|ehostunreach|enetunreach|econnrefused|timeout|tls|ssl|turn/i.test(text)) return;
      throw reason;
    };
    process.on('unhandledRejection', guard);
    try {
      const probes = await probeTurnEndpoints(endpoints, { username, password, timeoutMs: 4_000 });
      this.turnProbes = probes;
      entry.urls = selectTurnEndpoints(endpoints, probes).ordered.map((endpoint) => endpoint.url);
    } catch {
      // Probing is an optimization; the static fallback chain still works.
    } finally {
      // Late socket failures can arrive well after our own timeouts gave up
      // on an unreachable relay; keep the guard for a grace period instead of
      // removing it while werift's internal sockets are still pending.
      const removeGuard = setTimeout(() => process.off('unhandledRejection', guard), 90_000);
      removeGuard.unref?.();
    }
  }

  /** Sanitized networking diagnostics safe for UI display. */
  public networkDiagnostics(): Record<string, unknown> {
    return {
      relays: [...TRYSTERO_RELAY_URLS],
      relayRedundancy: RELAY_REDUNDANCY,
      turnEndpoints: (this.turnEndpoints ?? []).map((endpoint) => ({ ...endpoint })),
      turnProbes: (this.turnProbes ?? []).map((probe) => ({
        url: probe.endpoint.url,
        transport: probe.endpoint.transport,
        ok: probe.ok,
        ...(probe.ok ? { latencyMs: probe.latencyMs } : { error: probe.error }),
      })),
      proxy: describeProxy(resolveSignallingProxy('wss://nos.lol')),
      stunServers: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
    };
  }

  /** Trystero discovers room peers automatically; this re-announces identity to an already connected peer. */
  public connect(peer: PeerIdentity): void {
    if (this.stopped || peer.peerId === this.options.localPeer.peerId) return;
    const error = validatePeerIdentity(peer);
    if (error) throw new Error(`Cannot remember an invalid peer: ${error}`);
    this.rememberPeer(normalizedPeerIdentity(peer));
    if (this.identityToTransport.has(peer.peerId)) this.sendHelloAck(peer.peerId);
  }

  public updateLocalPeer(identity: PeerIdentity): void {
    if (identity.peerId !== this.options.localPeer.peerId) {
      throw new Error('A local peer update cannot change the peer identity.');
    }
    if (identity.identityKey && identity.identityKey !== this.options.localPeer.identityKey) {
      throw new Error('A local peer update cannot change the identity key.');
    }
    const displayNameError = validateDisplayName(identity.displayName);
    if (displayNameError) throw new Error(`Invalid local display name: ${displayNameError}`);
    const next = normalizedPeerIdentity({ ...identity, identityKey: this.options.localPeer.identityKey });
    const conflictingPeer = this.connectedDisplayNameOwner(next);
    if (conflictingPeer) {
      throw new Error(`Display name is already used by connected peer ${conflictingPeer.displayName}.`);
    }
    Object.assign(this.options.localPeer, next);
    this.directory.set(next.peerId, this.options.localPeer);
    this.broadcast('peerIdentity', { peer: this.options.localPeer });
    // The runtime owns the authoritative descriptor copy. Like participant
    // admission and directory updates, a self-initiated identity change must
    // announce itself so SessionRuntime can sync its descriptor, presence and
    // persisted session marker instead of publishing a stale name.
    this.emit('localIdentityUpdated', { ...this.options.localPeer });
  }

  public updateDirectory(peers: readonly PeerIdentity[]): void {
    for (const peer of peers.slice(0, MAX_DIRECTORY_PEERS)) {
      if (validatePeerIdentity(peer)) continue;
      if (peer.peerId === this.options.localPeer.peerId) {
        if (peer.identityKey === this.options.localPeer.identityKey
          && normalizeDisplayName(peer.displayName) === normalizeDisplayName(this.options.localPeer.displayName)
          && peer.joinOrder !== this.options.localPeer.joinOrder) {
          this.options.localPeer.joinOrder = peer.joinOrder;
          this.directory.set(peer.peerId, { ...this.options.localPeer });
          this.emit('localIdentityUpdated', { ...this.options.localPeer });
        }
        continue;
      }
      this.rememberPeer(normalizedPeerIdentity(peer));
    }
  }

  /** Assigns the host-authoritative, stable order used by deterministic failover. */
  public setPeerJoinOrder(peerId: string, joinOrder: number): PeerIdentity {
    if (!this.options.isHost()) throw new Error('Only the current host may assign participant order.');
    if (!Number.isSafeInteger(joinOrder) || joinOrder < 0) {
      throw new Error('Participant order must be a non-negative safe integer.');
    }
    const transportPeerId = this.identityToTransport.get(peerId);
    const connection = transportPeerId ? this.connections.get(transportPeerId) : undefined;
    if (!connection) throw new Error(`Cannot assign order to disconnected peer ${peerId}.`);
    const changed = connection.identity.joinOrder !== joinOrder;
    const identity = { ...connection.identity, joinOrder };
    connection.identity = identity;
    this.directory.set(peerId, identity);
    if (changed) this.sendTo(peerId, 'peerAdmission', { peer: identity });
    if (connection.purpose === 'runtime') this.broadcastDirectory();
    return { ...identity };
  }

  public broadcast(
    type: string,
    meta: Record<string, unknown> = {},
    payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
  ): string {
    const messageId = String(meta.messageId ?? newId());
    const frame = this.createFrame(type, { ...meta, messageId }, payload);
    for (const connection of this.connections.values()) {
      if (connection.purpose !== 'runtime') continue;
      try {
        this.enqueue(connection.transportPeerId, frame, framePriority(type));
      } catch (error) {
        if (this.connections.has(connection.transportPeerId)) this.emit('connectionError', connection.identity, error);
      }
    }
    return messageId;
  }

  public sendTo(
    peerId: string,
    type: string,
    meta: Record<string, unknown> = {},
    payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
  ): string {
    const transportPeerId = this.identityToTransport.get(peerId);
    if (!transportPeerId || !this.connections.has(transportPeerId)) throw new Error(`No route to peer ${peerId}.`);
    const messageId = String(meta.messageId ?? newId());
    const frame = this.createFrame(type, { ...meta, targetPeerId: peerId, messageId }, payload);
    const connection = this.connections.get(transportPeerId);
    if (!connection || !isPurposeMessageAllowed(this.options.purpose ?? 'runtime', connection.purpose, type, false)) {
      throw new Error(`Frame type ${type} is not allowed for the ${connection?.purpose ?? 'unknown'} connection purpose.`);
    }
    this.enqueue(transportPeerId, frame, framePriority(type));
    return messageId;
  }

  public async awaitDrain(
    peerId: string,
    lowWaterBytes = 4 * 1024 * 1024,
    timeoutMs = 120_000,
    lowWaterFrames = 1024,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const transportPeerId = this.identityToTransport.get(peerId);
      if (!transportPeerId || !this.connections.has(transportPeerId)) {
        throw new Error(`Peer ${peerId} disconnected during transfer.`);
      }
      const queue = this.outboundQueues.get(transportPeerId);
      if (queue?.failure) throw queue.failure;
      const bytes = (queue?.queuedBytes ?? 0) + (queue?.inFlightBytes ?? 0);
      const frames = (queue?.realtimeFrames.length ?? 0) + (queue?.bulkFrames.length ?? 0)
        + (queue?.inFlightFrames ?? 0);
      if (bytes <= lowWaterBytes && frames <= lowWaterFrames) return;
      if (Date.now() > deadline) throw new Error(`Transfer to ${peerId} stalled: outbound queue did not drain.`);
      await delay(10);
    }
  }

  public async awaitDrainAll(
    lowWaterBytes = 4 * 1024 * 1024,
    timeoutMs = 120_000,
    lowWaterFrames = 1024,
  ): Promise<void> {
    for (const connection of [...this.connections.values()]) {
      try {
        await this.awaitDrain(connection.identity.peerId, lowWaterBytes, timeoutMs, lowWaterFrames);
      } catch (error) {
        // Disconnect handling owns peer cleanup; one vanished peer must not block
        // every other peer. A still-connected peer with a failed send queue is a
        // real delivery failure and must reach the caller.
        if (this.identityToTransport.has(connection.identity.peerId)) throw error;
      }
    }
  }

  public peerRuntime(): PeerRuntime[] {
    const activeRuntimeIds = new Set(
      [...this.connections.values()]
        .filter((connection) => connection.purpose === 'runtime')
        .map((connection) => connection.identity.peerId),
    );
    return [...this.directory.values()]
      .filter((peer) => peer.peerId === this.options.localPeer.peerId || activeRuntimeIds.has(peer.peerId))
      .map((peer) => {
        const transportPeerId = this.identityToTransport.get(peer.peerId);
        const connection = transportPeerId ? this.connections.get(transportPeerId) : undefined;
        const latency = this.latency.get(peer.peerId);
        const local = peer.peerId === this.options.localPeer.peerId;
        return {
          ...peer,
          latency: latency?.current ?? (local ? 0 : -1),
          latencyEma: latency?.ema ?? (local ? 0 : -1),
          lastHeartbeat: connection?.lastSeen ?? (local ? Date.now() : 0),
          missedHeartbeats: 0,
          route: local ? 'Direct' : this.routes.get(peer.peerId) ?? 'Direct',
          online: local || Boolean(connection),
        };
      });
  }

  public setRoute(peerId: string, route: ConnectionRoute): void {
    this.routes.set(peerId, route);
  }

  public metrics(): MeshMetrics {
    return {
      bytesSentPerSecond: this.lastSentRate,
      bytesReceivedPerSecond: this.lastReceivedRate,
      totalBytesSent: this.totalSent,
      totalBytesReceived: this.totalReceived,
      directPeers: [...this.connections.values()].filter((peer) => peer.purpose === 'runtime').length,
    };
  }

  public async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    const room = this.room;
    this.room = undefined;
    this.action = undefined;
    this.connections.clear();
    this.identityToTransport.clear();
    this.pendingHandshakes.clear();
    this.pendingInboundFrames.clear();
    this.totalPendingInboundBytes = 0;
    this.outboundQueues.clear();
    this.seenIds.clear();
    this.inboundWindows.clear();
    if (room) await room.leave();
  }

  private localHandshake(): HandshakeMessage {
    return {
      version: HANDSHAKE_VERSION,
      sessionId: this.options.sessionId,
      purpose: this.options.purpose ?? 'runtime',
      peer: { ...this.options.localPeer },
      nonce: newIdentityNonce(),
    };
  }

  private parseHandshake(value: unknown): HandshakeMessage {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Peer sent an invalid Pair Notebook handshake.');
    }
    let serializedLength = MAX_WIRE_HEADER_BYTES;
    try { serializedLength = Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { /* rejected below */ }
    if (serializedLength > 16 * 1024) throw new Error('Peer handshake exceeds the size limit.');
    const handshake = value as Partial<HandshakeMessage>;
    if (handshake.version !== HANDSHAKE_VERSION || handshake.sessionId !== this.options.sessionId) {
      throw new Error('Peer uses an incompatible Pair Notebook session protocol.');
    }
    if (handshake.purpose !== 'runtime' && handshake.purpose !== 'bootstrap') {
      throw new Error('Peer sent an unsupported connection purpose.');
    }
    const identityError = validatePeerIdentity(handshake.peer, true);
    if (identityError) throw new Error(`Peer sent an invalid identity: ${identityError}`);
    if (!validateIdentityNonce(handshake.nonce)) throw new Error('Peer sent an invalid identity challenge.');
    const peer = normalizedPeerIdentity(handshake.peer as PeerIdentity);
    return {
      version: HANDSHAKE_VERSION,
      sessionId: this.options.sessionId,
      purpose: handshake.purpose,
      peer,
      nonce: handshake.nonce,
    };
  }

  private parseHandshakeProof(value: unknown): HandshakeProof {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Peer sent an invalid identity proof.');
    }
    const proof = value as Partial<HandshakeProof>;
    if (proof.version !== HANDSHAKE_VERSION || typeof proof.signature !== 'string'
      || proof.signature.length > 128) {
      throw new Error('Peer sent an invalid identity proof.');
    }
    return { version: HANDSHAKE_VERSION, signature: proof.signature };
  }

  private assertPeerCanJoin(identity: PeerIdentity, transportPeerId: string): void {
    if (this.connections.size + this.pendingHandshakes.size >= MAX_DIRECTORY_PEERS) {
      throw new Error(`Pair Notebook supports at most ${MAX_DIRECTORY_PEERS} connected peers.`);
    }
    if (identity.peerId === this.options.localPeer.peerId) {
      throw new Error('Peer announced our own application identity.');
    }
    if (!this.directory.has(identity.peerId) && this.directory.size >= MAX_DIRECTORY_PEERS) {
      throw new Error(`Pair Notebook identity directory reached its ${MAX_DIRECTORY_PEERS}-peer limit.`);
    }
    const remembered = this.directory.get(identity.peerId);
    if (remembered?.identityKey && remembered.identityKey !== identity.identityKey) {
      throw new Error(`Peer identity ${identity.peerId} presented a different identity key.`);
    }
    if (remembered?.identityKey && remembered.joinOrder !== identity.joinOrder) {
      throw new Error(`Peer identity ${identity.peerId} presented a different host-assigned order.`);
    }
    const activeTransport = this.identityToTransport.get(identity.peerId);
    if (activeTransport && activeTransport !== transportPeerId) {
      throw new Error(`Peer identity ${identity.peerId} is already connected.`);
    }
    for (const [pendingTransport, pending] of this.pendingHandshakes) {
      if (pendingTransport !== transportPeerId && pending.peer.peerId === identity.peerId) {
        throw new Error(`Peer identity ${identity.peerId} is already connecting.`);
      }
    }
    const conflictingPeer = this.connectedDisplayNameOwner(identity, transportPeerId);
    if (conflictingPeer) {
      throw new Error(`Display name is already in use: ${conflictingPeer.displayName}.`);
    }
  }

  private onPeerJoin(transportPeerId: string): void {
    if (this.stopped) return;
    const handshake = this.pendingHandshakes.get(transportPeerId);
    this.pendingHandshakes.delete(transportPeerId);
    if (!handshake) {
      this.rejectProtocolPeer(transportPeerId, new Error(`Trystero admitted peer ${transportPeerId} without a completed handshake.`));
      return;
    }
    const connection: ConnectedPeer = {
      transportPeerId,
      identity: handshake.peer,
      purpose: handshake.purpose,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      snapshotRequested: false,
    };
    this.connections.set(transportPeerId, connection);
    this.identityToTransport.set(handshake.peer.peerId, transportPeerId);
    this.rememberPeer(handshake.peer);
    this.routes.set(handshake.peer.peerId, 'Direct');
    if (handshake.purpose === 'runtime') {
      this.sendHelloAck(handshake.peer.peerId);
      this.emit('peerConnected', handshake.peer);
      if (this.options.isHost()) this.broadcastDirectory();
    } else {
      // SessionRuntime assigns the stable join order synchronously from this
      // event. Send hello only afterwards so peerAdmission is ordered first.
      this.emit('bootstrapConnected', handshake.peer);
      this.sendHelloAck(handshake.peer.peerId);
    }
    const pendingFrames = this.takePendingInboundFrames(transportPeerId);
    for (const frame of pendingFrames) {
      if (!this.connections.has(transportPeerId)) break;
      this.handleAction(frame, transportPeerId);
    }
  }

  private onPeerLeave(transportPeerId: string): void {
    this.pendingHandshakes.delete(transportPeerId);
    this.takePendingInboundFrames(transportPeerId);
    const connection = this.connections.get(transportPeerId);
    if (!connection) return;
    const queue = this.outboundQueues.get(transportPeerId);
    if (queue) {
      queue.realtimeFrames.length = 0;
      queue.bulkFrames.length = 0;
      queue.queuedBytes = 0;
    }
    this.connections.delete(transportPeerId);
    this.outboundQueues.delete(transportPeerId);
    this.inboundWindows.delete(transportPeerId);
    this.seenIds.delete(connection.identity.peerId);
    this.latency.delete(connection.identity.peerId);
    if (this.identityToTransport.get(connection.identity.peerId) === transportPeerId) {
      this.identityToTransport.delete(connection.identity.peerId);
    }
    if (!this.stopped) {
      this.emit(
        connection.purpose === 'runtime' ? 'peerDisconnected' : 'bootstrapDisconnected',
        connection.identity,
      );
    }
  }

  private onJoinError(details: JoinError): void {
    const pending = this.pendingHandshakes.get(details.peerId);
    this.pendingHandshakes.delete(details.peerId);
    this.takePendingInboundFrames(details.peerId);
    const error = new Error(details.error || 'Trystero could not establish the peer connection.');
    const peer = pending?.peer ?? this.directory.get(details.peerId) ?? {
      peerId: details.peerId,
      displayName: 'Unidentified peer',
      joinOrder: Number.MAX_SAFE_INTEGER,
    };
    this.emit('connectionError', peer, error);
  }

  private sendHelloAck(peerId: string): void {
    try {
      this.sendTo(peerId, 'helloAck', {
        peer: this.options.localPeer,
        clock: this.options.hostClock(),
        hostStorageReady: this.options.hostReady?.() ?? false,
        peers: [...this.directory.values()].slice(0, MAX_DIRECTORY_PEERS),
      });
    } catch (error) {
      const peer = this.directory.get(peerId) ?? {
        peerId,
        displayName: peerId,
        joinOrder: Number.MAX_SAFE_INTEGER,
      };
      this.emit('connectionError', peer, error);
    }
  }

  private createFrame(
    type: string,
    meta: Record<string, unknown>,
    payload: Uint8Array<ArrayBufferLike>,
  ): Buffer {
    return encodeFrame(type, {
      ...meta,
      sourceId: this.options.localPeer.peerId,
      sentAt: Date.now(),
      clock: this.options.hostClock(),
    }, payload);
  }

  private enqueue(transportPeerId: string, frame: Buffer, priority: FramePriority): void {
    if (this.stopped || !this.action) throw new Error('Trystero transport is not active.');
    if (!this.connections.has(transportPeerId)) throw new Error('The target peer is no longer connected.');
    const queue = this.outboundQueues.get(transportPeerId) ?? {
      realtimeFrames: [],
      bulkFrames: [],
      queuedBytes: 0,
      inFlightBytes: 0,
      inFlightFrames: 0,
      draining: false,
    };
    this.outboundQueues.set(transportPeerId, queue);
    if (queue.failure) throw queue.failure;
    const queuedFrames = queue.realtimeFrames.length + queue.bulkFrames.length + queue.inFlightFrames;
    if (queue.queuedBytes + queue.inFlightBytes + frame.byteLength > MAX_OUTBOUND_QUEUE
      || queuedFrames + 1 > MAX_OUTBOUND_FRAMES) {
      const error = new Error('Trystero peer outbound queue exceeded the 128 MiB safety limit.');
      this.emit('backpressure', queue.queuedBytes + queue.inFlightBytes + frame.byteLength);
      this.failOutboundQueue(transportPeerId, queue, error);
      throw error;
    }
    const totalRetainedBytes = [...this.outboundQueues.values()]
      .reduce((total, item) => total + item.queuedBytes + item.inFlightBytes, 0);
    const totalRetainedFrames = [...this.outboundQueues.values()].reduce(
      (total, item) => total + item.realtimeFrames.length + item.bulkFrames.length + item.inFlightFrames,
      0,
    );
    if (totalRetainedBytes + frame.byteLength > MAX_TOTAL_OUTBOUND_QUEUE
      || totalRetainedFrames + 1 > MAX_TOTAL_OUTBOUND_FRAMES) {
      const error = new Error('Trystero total outbound queues exceeded the 512 MiB safety limit.');
      this.emit('backpressure', totalRetainedBytes + frame.byteLength);
      this.failOutboundQueue(transportPeerId, queue, error);
      throw error;
    }
    const item = { bytes: frame, priority };
    (priority === 'realtime' ? queue.realtimeFrames : queue.bulkFrames).push(item);
    queue.queuedBytes += frame.byteLength;
    void this.drain(transportPeerId, queue);
  }

  private async drain(transportPeerId: string, queue: OutboundQueue): Promise<void> {
    if (queue.draining || queue.failure) return;
    queue.draining = true;
    try {
      while (!this.stopped && this.connections.has(transportPeerId)) {
        const item = queue.realtimeFrames.shift() ?? queue.bulkFrames.shift();
        if (!item) break;
        queue.queuedBytes -= item.bytes.byteLength;
        queue.inFlightBytes += item.bytes.byteLength;
        queue.inFlightFrames += 1;
        try {
          const action = this.action;
          if (!action) throw new Error('Trystero transport stopped during send.');
          await action.send(exactArrayBuffer(item.bytes), { target: transportPeerId });
          this.sentWindow += item.bytes.byteLength;
          this.totalSent += item.bytes.byteLength;
        } finally {
          queue.inFlightBytes -= item.bytes.byteLength;
          queue.inFlightFrames -= 1;
        }
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.failOutboundQueue(transportPeerId, queue, failure);
    } finally {
      queue.draining = false;
      if (!this.stopped
        && this.connections.has(transportPeerId)
        && !queue.failure
        && (queue.realtimeFrames.length || queue.bulkFrames.length)) {
        void this.drain(transportPeerId, queue);
      }
    }
  }

  private failOutboundQueue(transportPeerId: string, queue: OutboundQueue, failure: Error): void {
    if (queue.failure) return;
    queue.failure = failure;
    queue.realtimeFrames.length = 0;
    queue.bulkFrames.length = 0;
    queue.queuedBytes = 0;
    const connection = this.connections.get(transportPeerId);
    if (!connection) return;
    try {
      this.room?.getPeers()[transportPeerId]?.close();
    } catch {
      // Local cleanup below does not depend on RTC close succeeding.
    }
    this.onPeerLeave(transportPeerId);
    this.emit('connectionError', connection.identity, failure);
  }

  private handleAction(data: ArrayBuffer, transportPeerId: string): void {
    try {
      const connection = this.connections.get(transportPeerId);
      if (!connection) {
        // Trystero can invoke one side's onPeerJoin callback a few microtasks
        // before the other side's callback. The first peer may immediately send
        // helloAck, so retain a strictly bounded copy until local admission is
        // published instead of tearing down an otherwise valid connection.
        if (this.pendingHandshakes.has(transportPeerId)) {
          this.retainPendingInboundFrame(transportPeerId, data);
          return;
        }
        throw new Error('Received a frame from a peer without an admitted identity.');
      }
      if (data.byteLength > MAX_WIRE_FRAME_BYTES) throw new Error('Inbound Pair Notebook frame exceeds the wire size limit.');
      this.acceptInboundRate(transportPeerId, data.byteLength);
      connection.lastSeen = Date.now();
      const bytes = Buffer.from(data);
      this.receivedWindow += bytes.byteLength;
      this.totalReceived += bytes.byteLength;
      const frame = decodeFrame(bytes);
      const sourceId = typeof frame.meta.sourceId === 'string' ? frame.meta.sourceId : '';
      if (sourceId !== connection.identity.peerId) {
        throw new Error(`Frame source ${sourceId || '(missing)'} does not match admitted peer ${connection.identity.peerId}.`);
      }
      if (!isPurposeMessageAllowed(this.options.purpose ?? 'runtime', connection.purpose, frame.type, true)) {
        throw new Error(`Frame type ${frame.type} is not allowed for the ${connection.purpose} connection purpose.`);
      }
      if (connection.purpose === 'bootstrap' && (this.options.purpose ?? 'runtime') === 'runtime'
        && frame.type === 'snapshotRequest') {
        if (connection.snapshotRequested) throw new Error('Bootstrap peer requested more than one project snapshot.');
        connection.snapshotRequested = true;
      }
      if (frame.payload.byteLength > maxPayloadBytes(frame.type)) {
        throw new Error(`Frame payload for ${frame.type} exceeds its safety limit.`);
      }
      const messageId = typeof frame.meta.messageId === 'string' ? frame.meta.messageId : '';
      if (!MESSAGE_ID_PATTERN.test(messageId)) throw new Error('Frame has a missing or malformed message id.');
      if (this.wasSeen(sourceId, messageId)) return;
      const targetPeerId = typeof frame.meta.targetPeerId === 'string' ? frame.meta.targetPeerId : undefined;
      if (targetPeerId && targetPeerId !== this.options.localPeer.peerId) return;
      if (frame.type === 'peerDirectory') {
        if (sourceId !== this.options.hostClock().hostId) {
          if (isStaleSelfHostDirectory(frame, sourceId, this.options.hostClock())) {
            this.emit('protocolError', new Error(
              `Ignored a stale peer directory from former host ${sourceId}.`,
            ));
            return;
          }
          throw new Error('Only the current host may publish the peer directory.');
        }
        const peers = frame.meta.peers as PeerIdentity[] | undefined;
        if (!Array.isArray(peers) || peers.length > MAX_DIRECTORY_PEERS) {
          throw new Error('Peer directory is missing or exceeds the participant limit.');
        }
        this.updateDirectory(peers);
      } else if (frame.type === 'peerAdmission') {
        this.acceptPeerAdmission(frame, sourceId);
      } else if (frame.type === 'peerIdentity') {
        this.acceptIdentityUpdate(frame, connection);
      } else if (frame.type === 'appPing') {
        this.sendTo(sourceId, 'appPong', { pingAt: frame.meta.pingAt });
      } else if (frame.type === 'appPong') {
        this.acceptPong(frame, sourceId);
      }
      const suppressBootstrapHello = (this.options.purpose ?? 'runtime') === 'runtime'
        && connection.purpose === 'bootstrap'
        && frame.type === 'helloAck';
      if (!suppressBootstrapHello) this.emit('message', frame, sourceId);
    } catch (error) {
      this.rejectProtocolPeer(transportPeerId, error);
    }
  }

  private acceptIdentityUpdate(frame: WireFrame, connection: ConnectedPeer): void {
    const announced = frame.meta.peer as PeerIdentity | undefined;
    const error = validatePeerIdentity(announced);
    if (error || announced?.peerId !== connection.identity.peerId
      || announced.identityKey !== connection.identity.identityKey
      || announced.joinOrder !== connection.identity.joinOrder) {
      throw new Error(`Invalid peer identity update: ${error ?? 'peer id, identity key, or host-assigned order changed'}.`);
    }
    const identity = normalizedPeerIdentity(announced);
    const conflict = this.connectedDisplayNameOwner(identity, connection.transportPeerId);
    if (conflict) throw new Error(`Display name is already in use: ${conflict.displayName}.`);
    connection.identity = identity;
    this.directory.set(identity.peerId, identity);
    if (this.options.isHost()) this.broadcastDirectory();
  }

  private acceptPeerAdmission(frame: WireFrame, sourceId: string): void {
    if (sourceId !== this.options.hostClock().hostId) {
      throw new Error('Only the current host may assign participant order.');
    }
    const announced = frame.meta.peer as PeerIdentity | undefined;
    const error = validatePeerIdentity(announced, true);
    if (error || announced?.peerId !== this.options.localPeer.peerId
      || announced.identityKey !== this.options.localPeer.identityKey
      || normalizeDisplayName(announced.displayName) !== normalizeDisplayName(this.options.localPeer.displayName)
      || announced.joinOrder < 0) {
      throw new Error(`Invalid participant admission: ${error ?? 'identity changed'}.`);
    }
    if (announced.joinOrder === this.options.localPeer.joinOrder) return;
    this.options.localPeer.joinOrder = announced.joinOrder;
    this.directory.set(announced.peerId, { ...this.options.localPeer });
    this.emit('localIdentityUpdated', { ...this.options.localPeer });
  }

  private rememberPeer(identity: PeerIdentity): void {
    const remembered = this.directory.get(identity.peerId);
    if (remembered?.identityKey && identity.identityKey
      && remembered.identityKey !== identity.identityKey) {
      throw new Error(`Peer identity ${identity.peerId} cannot change its identity key.`);
    }
    if (!identity.identityKey && remembered?.identityKey) {
      identity = { ...identity, identityKey: remembered.identityKey };
    }
    const activeTransport = this.identityToTransport.get(identity.peerId);
    const active = activeTransport ? this.connections.get(activeTransport) : undefined;
    if (active) {
      // A directory from the authenticated host owns failover order, while a
      // peer's authenticated connection continues to own its name and key.
      if (identity.joinOrder !== active.identity.joinOrder) {
        active.identity = { ...active.identity, joinOrder: identity.joinOrder };
      }
      identity = active.identity;
    }
    if (!this.directory.has(identity.peerId) && this.directory.size >= MAX_DIRECTORY_PEERS) {
      throw new Error(`Pair Notebook identity directory reached its ${MAX_DIRECTORY_PEERS}-peer limit.`);
    }
    this.directory.set(identity.peerId, identity);
  }

  private rejectProtocolPeer(transportPeerId: string, value: unknown): void {
    const error = value instanceof Error ? value : new Error(String(value));
    try {
      this.room?.getPeers()[transportPeerId]?.close();
    } catch {
      // Local cleanup below is authoritative even if the RTC implementation has
      // already closed the connection.
    }
    this.onPeerLeave(transportPeerId);
    this.emit('protocolError', error);
  }

  private retainPendingInboundFrame(transportPeerId: string, data: ArrayBuffer): void {
    if (data.byteLength > MAX_WIRE_FRAME_BYTES) {
      throw new Error('Pending Pair Notebook frame exceeds the wire size limit.');
    }
    const pending = this.pendingInboundFrames.get(transportPeerId) ?? { frames: [], bytes: 0 };
    const nextPeerBytes = pending.bytes + data.byteLength;
    const nextTotalBytes = this.totalPendingInboundBytes + data.byteLength;
    if (pending.frames.length >= MAX_PENDING_HANDSHAKE_FRAMES
      || nextPeerBytes > MAX_PENDING_HANDSHAKE_BYTES
      || nextTotalBytes > MAX_TOTAL_PENDING_HANDSHAKE_BYTES) {
      throw new Error('Peer exceeded the pending-handshake frame safety limit.');
    }
    pending.frames.push(data.slice(0));
    pending.bytes = nextPeerBytes;
    this.totalPendingInboundBytes = nextTotalBytes;
    this.pendingInboundFrames.set(transportPeerId, pending);
  }

  private takePendingInboundFrames(transportPeerId: string): ArrayBuffer[] {
    const pending = this.pendingInboundFrames.get(transportPeerId);
    if (!pending) return [];
    this.pendingInboundFrames.delete(transportPeerId);
    this.totalPendingInboundBytes = Math.max(0, this.totalPendingInboundBytes - pending.bytes);
    return pending.frames;
  }

  private acceptPong(frame: WireFrame, sourceId: string): void {
    const pingAt = Number(frame.meta.pingAt);
    const now = Date.now();
    if (!Number.isSafeInteger(pingAt) || pingAt < now - 60_000 || pingAt > now + 5_000) return;
    const current = Math.max(0, Math.min(60_000, now - pingAt));
    const previous = this.latency.get(sourceId)?.ema ?? current;
    this.latency.set(sourceId, { current, ema: previous * 0.7 + current * 0.3 });
  }

  private heartbeatTick(): void {
    if (!this.stopped && this.options.isHost()) {
      this.broadcast('hostHeartbeat', {
        clock: this.options.hostClock(),
        hostStorageReady: this.options.hostReady?.() ?? true,
      });
    }
  }

  private async pingTick(): Promise<void> {
    const room = this.room;
    if (!room || this.stopped || this.pingInFlight) return;
    this.pingInFlight = true;
    try {
      await Promise.all([...this.connections.values()].map(async (connection) => {
        try {
          const current = await room.ping(connection.transportPeerId);
          if (!Number.isFinite(current) || current < 0) return;
          const bounded = Math.min(60_000, current);
          const previous = this.latency.get(connection.identity.peerId)?.ema ?? bounded;
          this.latency.set(connection.identity.peerId, { current: bounded, ema: previous * 0.7 + bounded * 0.3 });
          connection.lastSeen = Date.now();
        } catch {
          // Trystero emits onPeerLeave when the connection is conclusively gone.
        }
      }));
    } finally {
      this.pingInFlight = false;
    }
  }

  private metricsTick(): void {
    this.lastSentRate = this.sentWindow;
    this.lastReceivedRate = this.receivedWindow;
    this.sentWindow = 0;
    this.receivedWindow = 0;
    this.emit('metrics', this.metrics());
  }

  private cleanupSeenIds(): void {
    const now = Date.now();
    const oldest = now - 60_000;
    for (const [peerId, ids] of this.seenIds) {
      for (const [id, timestamp] of ids) if (timestamp < oldest) ids.delete(id);
      if (!ids.size) this.seenIds.delete(peerId);
    }
    for (const [transportPeerId, handshake] of this.pendingHandshakes) {
      if ((handshake.admittedAt ?? now) >= now - PENDING_HANDSHAKE_TTL_MS) continue;
      this.pendingHandshakes.delete(transportPeerId);
      this.takePendingInboundFrames(transportPeerId);
      try { this.room?.getPeers()[transportPeerId]?.close(); } catch { /* best effort */ }
      this.emit('protocolError', new Error(`Expired incomplete peer admission ${transportPeerId}.`));
    }
  }

  private broadcastDirectory(): void {
    this.broadcast('peerDirectory', { peers: [...this.directory.values()] });
  }

  private connectedDisplayNameOwner(identity: PeerIdentity, ignoredTransportId?: string): PeerIdentity | undefined {
    const wanted = normalizeDisplayName(identity.displayName);
    if (this.options.localPeer.peerId !== identity.peerId
      && normalizeDisplayName(this.options.localPeer.displayName) === wanted) {
      return this.options.localPeer;
    }
    for (const [transportPeerId, connection] of this.connections) {
      if (transportPeerId === ignoredTransportId || connection.identity.peerId === identity.peerId) continue;
      if (normalizeDisplayName(connection.identity.displayName) === wanted) return connection.identity;
    }
    for (const [transportPeerId, pending] of this.pendingHandshakes) {
      if (transportPeerId === ignoredTransportId || pending.peer.peerId === identity.peerId) continue;
      if (normalizeDisplayName(pending.peer.displayName) === wanted) return pending.peer;
    }
    return undefined;
  }

  private acceptInboundRate(transportPeerId: string, bytes: number): void {
    const now = Date.now();
    let window = this.inboundWindows.get(transportPeerId);
    if (!window || now - window.startedAt >= 1000) {
      window = { startedAt: now, bytes: 0, messages: 0 };
      this.inboundWindows.set(transportPeerId, window);
    }
    window.bytes += bytes;
    window.messages += 1;
    if (window.bytes > MAX_INBOUND_BYTES_PER_SECOND || window.messages > MAX_INBOUND_MESSAGES_PER_SECOND) {
      throw new Error('Peer exceeded the inbound message rate limit.');
    }
    if (now - this.globalInboundWindow.startedAt >= 1000) {
      this.globalInboundWindow = { startedAt: now, bytes: 0, messages: 0 };
    }
    this.globalInboundWindow.bytes += bytes;
    this.globalInboundWindow.messages += 1;
    if (this.globalInboundWindow.bytes > MAX_TOTAL_INBOUND_BYTES_PER_SECOND
      || this.globalInboundWindow.messages > MAX_TOTAL_INBOUND_MESSAGES_PER_SECOND) {
      throw new Error('Session exceeded the aggregate inbound message rate limit.');
    }
  }

  private wasSeen(sourceId: string, messageId: string): boolean {
    const ids = this.seenIds.get(sourceId) ?? new Map<string, number>();
    this.seenIds.set(sourceId, ids);
    if (ids.has(messageId)) return true;
    ids.set(messageId, Date.now());
    while (ids.size > MAX_SEEN_IDS_PER_PEER) {
      const oldest = ids.keys().next().value as string | undefined;
      if (!oldest) break;
      ids.delete(oldest);
    }
    return false;
  }
}

function maxPayloadBytes(type: string): number {
  if (BULK_CHUNK_TYPES.has(type)) return 1024 * 1024;
  if (type === 'awareness') return 1024 * 1024;
  if (type === 'projectUpdate' || type === 'stateDocument' || type === 'stateDiff') return 64 * 1024 * 1024;
  return 4 * 1024 * 1024;
}

function isStaleSelfHostDirectory(frame: WireFrame, sourceId: string, current: HostClock): boolean {
  const claimed = frame.meta.clock as Partial<HostClock> | undefined;
  return Boolean(claimed
    && Number.isSafeInteger(claimed.sessionEpoch)
    && Number.isSafeInteger(claimed.hostEpoch)
    && claimed.sessionEpoch === current.sessionEpoch
    && (claimed.hostEpoch ?? -1) >= 0
    && (claimed.hostEpoch ?? Number.MAX_SAFE_INTEGER) < current.hostEpoch
    && claimed.hostId === sourceId);
}

function isPurposeMessageAllowed(
  localPurpose: PeerConnectionPurpose,
  remotePurpose: PeerConnectionPurpose,
  type: string,
  inbound: boolean,
): boolean {
  if (localPurpose === remotePurpose) {
    return localPurpose === 'runtime' && !SNAPSHOT_PROTOCOL_TYPES.has(type);
  }
  if (localPurpose === 'runtime' && remotePurpose === 'bootstrap') {
    return (inbound ? BOOTSTRAP_TO_RUNTIME_TYPES : RUNTIME_TO_BOOTSTRAP_TYPES).has(type);
  }
  return (inbound ? RUNTIME_TO_BOOTSTRAP_TYPES : BOOTSTRAP_TO_RUNTIME_TYPES).has(type);
}

function validatePeerIdentity(value: unknown, requireIdentityKey = false): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'identity must be an object';
  const peer = value as Partial<PeerIdentity>;
  if (typeof peer.peerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(peer.peerId)) {
    return 'peer id has an unsupported format';
  }
  const displayNameError = validateDisplayName(peer.displayName);
  if (displayNameError) return displayNameError;
  if (!Number.isSafeInteger(peer.joinOrder) || (peer.joinOrder ?? -1) < 0) return 'join order must be a non-negative integer';
  if (requireIdentityKey || peer.identityKey !== undefined) {
    const identityKeyError = validateIdentityPublicKey(peer.identityKey);
    if (identityKeyError) return identityKeyError;
  }
  return undefined;
}

function normalizedPeerIdentity(peer: PeerIdentity): PeerIdentity {
  return {
    peerId: peer.peerId,
    displayName: cleanDisplayName(peer.displayName),
    joinOrder: peer.joinOrder,
    ...(peer.identityKey ? { identityKey: peer.identityKey } : {}),
  };
}

function handshakeTranscript(initiator: HandshakeMessage, responder: HandshakeMessage): Buffer {
  return Buffer.from(JSON.stringify({
    context: 'pair-notebook-identity-proof-v2',
    sessionId: initiator.sessionId,
    initiator: transcriptIdentity(initiator),
    responder: transcriptIdentity(responder),
  }), 'utf8');
}

function transcriptIdentity(handshake: HandshakeMessage): Record<string, unknown> {
  return {
    purpose: handshake.purpose,
    peerId: handshake.peer.peerId,
    displayName: handshake.peer.displayName,
    joinOrder: handshake.peer.joinOrder,
    identityKey: handshake.peer.identityKey,
    nonce: handshake.nonce,
  };
}

function exactArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

const BULK_FRAME_TYPES = new Set([
  'binaryStart',
  'binaryChunk',
  'binaryEnd',
  'snapshotBegin',
  'snapshotManifest',
  'snapshotManifestEnd',
  'snapshotDirectory',
  'snapshotFileStart',
  'snapshotFileChunk',
  'snapshotFileEnd',
  // A checkpoint must stay behind every bulk frame it acknowledges. The reply
  // travels in the opposite direction and can remain realtime.
  'snapshotCheckpoint',
  'snapshotEnd',
  'stateDocument',
  'stateDiff',
  'stateVector',
  'filesystemState',
  'stateEnd',
  // The barrier commit must remain behind the stateDocument/binary frames that
  // satisfy it. Otherwise the realtime queue can authorize execution against
  // a partially synchronized filesystem.
  'executionBarrierCommit',
]);

function framePriority(type: string): FramePriority {
  return BULK_FRAME_TYPES.has(type) ? 'bulk' : 'realtime';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ensureWebSocketRuntime(): void {
  // Always install the proxy-aware WebSocket: Node's `ws` ignores system,
  // VS Code and environment proxy configuration, so a plain global breaks
  // discovery on proxy-only networks even when WebRTC could still work.
  installProxyAwareWebSocket(meshNetworkConfig.proxy ?? {});
}

/** Resolves the effective proxy for a signalling URL, for diagnostics. */
function resolveSignallingProxy(url: string): ProxyDescriptor | undefined {
  return resolveProxy(url, meshNetworkConfig.proxy ?? {});
}


