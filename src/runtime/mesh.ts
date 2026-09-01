import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { RTCPeerConnection as WeriftPeerConnection } from 'werift';
import {
  type JoinError,
  type JoinRoomCallbacks,
  type MessageAction,
  type NostrRoomConfig,
  type Room,
} from 'trystero';
import {
  getRelayHealth as getNostrRelayHealth,
  getRelaySockets as getNostrRelaySockets,
  joinRoom,
  relaySocketRefreshProgress as nostrRelaySocketRefreshProgress,
  refreshRelaySockets as refreshNostrRelaySockets,
} from './nostrRoom';
import {
  defaultRelayUrls as MQTT_SIGNALLING_RELAY_URLS,
  getRelayHealth as getMqttRelayHealth,
  getRelaySockets as getMqttRelaySockets,
  joinRoom as joinMqttRoom,
  relaySocketRefreshProgress as mqttRelaySocketRefreshProgress,
  refreshRelaySockets as refreshMqttRelaySockets,
} from './mqttRoom';
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
import {
  getSignallingSocketHealth,
  installProxyAwareWebSocket,
  type ProxyWebSocketRuntimeOptions,
} from './proxyWebSocket';
import { type FrameRelay, type FrameRelayOptions } from './frameRelay';
import { RedundantFrameRelay } from './redundantFrameRelay';
import { assessUdpAvailability, type SignallingFamilyDiagnostic } from './diagnostics';
import { shouldMigrateRoute } from './routeScoring';
import { NetworkChangeWatcher } from './netWatch';
import { signallingEndpointIdentity } from './signallingEndpoint';

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
  'wss://nostr.data.haus',
  'wss://nostr.sathoarder.com',
  'wss://relay.primal.net',
  'wss://nostr.oxtr.dev',
  'wss://relay.orangepill.dev',
  'wss://offchain.pub',
];
/** @deprecated Pair Notebook no longer advertises a dead built-in TURN service. */
export const TRYSTERO_TURN_SERVERS: ReadonlyArray<{
  urls: string[];
  username: string;
  credential: string;
}> = [];

export interface MeshNetworkConfig {
  /** Overrides the default TURN endpoint URL list. */
  turnUrls?: readonly string[] | undefined;
  turnUsername?: string | undefined;
  /** TURN credential; supplied from VS Code secret storage, never logged. */
  turnPassword?: string | undefined;
  /** Disables the live TURN Allocate probe when true. */
  disableTurnProbe?: boolean;
  /** Proxy options applied to signalling WebSockets. */
  proxy?: ProxyWebSocketRuntimeOptions | undefined;
  /** Disables the redundant Nostr + MQTT emergency data relay (default: enabled). */
  disableRelayFallback?: boolean | undefined;
  /** Test hook: builds the relay channel instead of the real one. */
  relayFactory?: ((options: FrameRelayOptions) => FrameRelay) | undefined;
}

const RELAY_TRANSPORT_PREFIX = 'relay:';
/**
 * Transport-id prefix for peers discovered through the SECONDARY signalling
 * family (MQTT). Both families run concurrently and may discover the same
 * logical participant twice; assertPeerCanJoin deduplicates them by keeping
 * the already-connected transport while it is provably fresh.
 */
export const MQTT_TRANSPORT_PREFIX = 'mqtt:';
/** A connected transport younger than this is not replaced by a duplicate. */
export const DUPLICATE_HANDSHAKE_WINDOW_MS = 20_000;
/**
 * Transport-id prefix for peers met inside the dedicated route-upgrade room.
 * A candidate direct connection created by "Try to improve" is fully built
 * and verified BEFORE it may replace the working emergency-relay route
 * (make-before-break); the prefix lets the frame drain and ping paths route
 * candidate traffic without touching the active identity mapping.
 */
export const UPGRADE_TRANSPORT_PREFIX = 'upgrade:';
/** Room id suffix for the short-lived make-before-break negotiation room. */
export const ROUTE_UPGRADE_ROOM_SUFFIX = '-route-upgrade-v1';
/** Overall deadline for one improvement attempt. */
export const ROUTE_UPGRADE_TIMEOUT_MS = 45_000;
/** Consecutive successful candidate pings required before promotion. */
export const ROUTE_UPGRADE_REQUIRED_PINGS = 3;
/** Minimum time the candidate must stay alive before promotion. */
export const ROUTE_UPGRADE_STABILITY_WINDOW_MS = 3_000;
/** Maximum time a relay identity handshake may retain retry-blocking state. */
export const RELAY_NEGOTIATION_TIMEOUT_MS = 12_000;
/**
 * A physical Trystero route is not the logical participant. Keep the identity
 * alive long enough to replace a failed route before SessionCoordinator may
 * interpret it as a host loss.
 */
export const LOGICAL_PEER_RECOVERY_MS = 30_000;

export type RouteUpgradeStatus =
  | 'requesting'
  | 'waiting-peer'
  | 'authenticating'
  | 'verifying'
  | 'promoting'
  | 'completed'
  | 'failed';

export interface RouteUpgradeState {
  peerId: string;
  role: 'initiator' | 'responder';
  status: RouteUpgradeStatus;
  startedAt: number;
  detail?: string;
}

interface RouteUpgrade {
  peerId: string;
  role: 'initiator' | 'responder';
  status: RouteUpgradeStatus;
  startedAt: number;
  incumbentTransportId: string;
  incumbentConnection: ConnectedPeer;
  candidateTransportId?: string | undefined;
  candidateRawId?: string | undefined;
  probeMessageId?: string | undefined;
  probeAcknowledged: boolean;
  connectedAt?: number | undefined;
  verifiedPings: number;
  lastError?: string | undefined;
  deadlineTimer?: NodeJS.Timeout | undefined;
  verifyTimer?: NodeJS.Timeout | undefined;
}

interface RelayNegotiation {
  role: 'initiator' | 'responder';
  localHs: HandshakeMessage;
  sentLocalHs: boolean;
  sentProof: boolean;
  localProof?: HandshakeProof | undefined;
  remoteHs?: HandshakeMessage | undefined;
  remoteProof?: HandshakeProof | undefined;
  timeout: NodeJS.Timeout;
}

interface SignedRelayEnvelope {
  version: number;
  messageId: string;
  sentAt: number;
  targetPeerId: string;
  payload: Record<string, unknown>;
  signature: string;
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
  meshNetworkConfig.disableRelayFallback = config.disableRelayFallback;
  meshNetworkConfig.relayFactory = config.relayFactory;
  // Trystero and the emergency relay create replacement sockets during
  // recovery. Refresh the global constructor now so those reconnects see a
  // newly enabled VPN or proxy without restarting the extension host.
  installProxyAwareWebSocket(config.proxy ?? {});
}

const RELAY_REDUNDANCY = 8;
const HANDSHAKE_VERSION = 4;
const RELAY_ENVELOPE_VERSION = 2;
const RELAY_ENVELOPE_MAX_AGE_MS = 10 * 60_000;
const RELAY_ENVELOPE_MAX_FUTURE_SKEW_MS = 2 * 60_000;
const MAX_SEEN_RELAY_ENVELOPES = 131_072;
const ACTION_NAMESPACE = 'pair-notebook-frame-v2';
const MAX_OUTBOUND_QUEUE = 128 * 1024 * 1024;
const MAX_TOTAL_OUTBOUND_QUEUE = 512 * 1024 * 1024;
const MAX_OUTBOUND_FRAMES = 16_384;
const MAX_TOTAL_OUTBOUND_FRAMES = 65_536;
const MAX_DIRECTORY_PEERS = 256;
const MAX_UNKNOWN_RELAY_CANDIDATES = MAX_DIRECTORY_PEERS;
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
  'helloAck', 'snapshotRequest', 'snapshotCheckpointAck', 'snapshotFileRetry', 'appPing', 'appPong',
]);
const RUNTIME_TO_BOOTSTRAP_TYPES = new Set([
  'helloAck', 'peerAdmission', 'snapshotBegin', 'snapshotManifest', 'snapshotManifestEnd', 'snapshotDirectory',
  'snapshotFileStart', 'snapshotFileChunk', 'snapshotFileEnd', 'snapshotCheckpoint',
  'snapshotEnd', 'snapshotError', 'appPing', 'appPong',
]);
const SNAPSHOT_PROTOCOL_TYPES = new Set([
  'snapshotRequest', 'snapshotBegin', 'snapshotManifest', 'snapshotManifestEnd', 'snapshotDirectory',
  'snapshotFileStart', 'snapshotFileChunk', 'snapshotFileEnd', 'snapshotCheckpoint',
  'snapshotCheckpointAck', 'snapshotFileRetry', 'snapshotEnd', 'snapshotError',
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
  roomFactory?: TrysteroRoomFactory | undefined;
  /** Test hook: builds the SECONDARY (MQTT) signalling room. */
  secondaryRoomFactory?: TrysteroRoomFactory | undefined;
  /** Disables the concurrent MQTT signalling family (default: enabled). */
  disableSecondarySignalling?: boolean | undefined;
  /** Required by production callers; omitted tests receive an ephemeral key. */
  identityPrivateKey?: string | undefined;
  /** Test hook; production uses the bounded logical recovery lease above. */
  logicalPeerRecoveryMs?: number | undefined;
  /** Test seam; production uses a bounded ten-second signalling refresh. */
  signallingRefreshTimeoutMs?: number | undefined;
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

interface PendingHandshake extends HandshakeMessage {
  /** Exact make-before-break attempt that authorized an upgrade-room peer. */
  upgradeGeneration?: RouteUpgrade | undefined;
}

interface HandshakeProof {
  version: number;
  signature: string;
  /** Binds delayed relay proofs to the exact pair of handshake nonces. */
  transcriptId?: string | undefined;
}

interface ConnectedPeer {
  transportPeerId: string;
  identity: PeerIdentity;
  purpose: PeerConnectionPurpose;
  connectedAt: number;
  lastSeen: number;
  snapshotRequested: boolean;
}

interface RecoveringPeer {
  identity: PeerIdentity;
  purpose: PeerConnectionPurpose;
  startedAt: number;
  timer: NodeJS.Timeout;
}

interface SignallingEvidence {
  startedAt?: number | undefined;
  peerDiscoveredAt?: number | undefined;
  identityAuthenticatedAt?: number | undefined;
  routeEstablishedAt?: number | undefined;
  routePurpose?: PeerConnectionPurpose | undefined;
  handshakesInFlight?: number | undefined;
  lastRefresh?: {
    at: number;
    status: SignallingRefreshStatus;
    requestedSockets: number;
    replacedSockets: number;
    verifiedEndpoints: number;
  } | undefined;
  lastError?: SignallingFamilyDiagnostic['lastError'] | undefined;
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

export type SignallingRefreshStatus = 'verified' | 'partial' | 'timed-out' | 'no-sockets';

export interface SignallingFamilyRefreshResult {
  requestedSockets: number;
  replacedSockets: number;
  verifiedEndpoints: number;
}

export interface SignallingRefreshResult {
  requestedAt: number;
  completedAt: number;
  status: SignallingRefreshStatus;
  nostr: SignallingFamilyRefreshResult;
  mqtt: SignallingFamilyRefreshResult;
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
  private readonly recoveringPeers = new Map<string, RecoveringPeer>();
  private readonly pendingHandshakes = new Map<string, PendingHandshake>();
  private readonly pendingInboundFrames = new Map<string, PendingInboundFrames>();
  private totalPendingInboundBytes = 0;
  private readonly directory = new Map<string, PeerIdentity>();
  private readonly seenIds = new Map<string, Map<string, number>>();
  private readonly inboundWindows = new Map<string, InboundWindow>();
  private globalInboundWindow: InboundWindow = { startedAt: Date.now(), bytes: 0, messages: 0 };
  private readonly latency = new Map<string, { current: number; ema: number }>();
  private readonly routes = new Map<string, ConnectionRoute>();
  private readonly outboundQueues = new Map<string, OutboundQueue>();
  /** Retired sends still settling remain part of the global memory budget. */
  private readonly retiredOutboundQueues = new Set<OutboundQueue>();
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
  private turnStatus: 'not-configured' | 'invalid' | 'configured' = 'not-configured';
  private relay: FrameRelay | undefined;
  private readonly relayNegotiations = new Map<string, RelayNegotiation>();
  private readonly relayAttempts = new Map<string, number>();
  /** Valid signed relay envelopes retained briefly to reject captured replays. */
  private readonly seenRelayEnvelopes = new Map<string, number>();
  /** Make-before-break improvement attempts, keyed by logical peer id. */
  private readonly routeUpgrades = new Map<string, RouteUpgrade>();
  private upgradeRoom: Room | undefined;
  private upgradeAction: MessageAction<ArrayBuffer> | undefined;
  private upgradeJoining = false;
  /** Secondary (MQTT) signalling family: runs concurrently with Nostr. */
  private mqttRoom: Room | undefined;
  private mqttAction: MessageAction<ArrayBuffer> | undefined;
  private mqttJoining = false;
  private primaryUsesProductionSockets = false;
  private secondaryUsesProductionSockets = false;
  private readonly signallingEvidence: Record<'nostr' | 'mqtt', SignallingEvidence> = {
    nostr: {},
    mqtt: {},
  };
  private signallingRefreshInFlight: Promise<SignallingRefreshResult> | undefined;
  private readonly networkWatcher = new NetworkChangeWatcher(() => this.onNetworkChanged());
  /** Rate-limited remote migration notices for the participants panel. */
  private readonly remoteRouteStatuses = new Map<string, { status: string; at: number }>();
  private lastRemoteStatusSentAt = 0;


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
    this.signallingEvidence.nostr = { startedAt: Date.now() };
    ensureWebSocketRuntime();
    const callbacks: JoinRoomCallbacks = {
      handshakeTimeoutMs: 15_000,
      onPeerHandshake: async (transportPeerId, send, receive, isInitiator) => {
        this.beginSignallingHandshake('nostr');
        this.noteSignallingPeerStage('nostr', 'peer-discovered');
        try {
          await this.runPeerHandshake(
            transportPeerId,
            send as (data: unknown) => Promise<void>,
            receive as () => Promise<{ data: unknown }>,
            isInitiator,
          );
          this.noteSignallingPeerStage('nostr', 'identity-authenticated');
        } catch (error) {
          if (isDuplicatePeerError(error)) {
            // Same participant already connected via the other signalling
            // family: close this duplicate transport instead of admitting it.
            try { this.room?.getPeers()[transportPeerId]?.close(); } catch { /* gone */ }
            return;
          }
          this.noteSignallingError('nostr', error);
          throw error;
        } finally {
          this.endSignallingHandshake('nostr');
        }
      },
      onJoinError: (details) => {
        this.noteSignallingError('nostr', details.error);
        this.onJoinError(details);
      },
    };
    const turnConfig = this.buildTurnConfig();
    const config: NostrRoomConfig = {
      appId: TRYSTERO_APP_ID,
      password: this.options.token,
      rtcPolyfill: WeriftPeerConnection as unknown as NostrRoomConfig['rtcPolyfill'],
      relayConfig: {
        urls: TRYSTERO_RELAY_URLS,
        redundancy: RELAY_REDUNDANCY,
        warnOnRelayFailure: false,
      },
      ...(turnConfig !== undefined ? { turnConfig } : {}),
    };
    const factory = this.options.roomFactory ?? MeshTransport.testingRoomFactory ?? joinRoom;
    this.primaryUsesProductionSockets = factory === joinRoom;
    try {
      this.room = factory(config, this.options.sessionId, callbacks);
      this.action = this.room.makeAction<ArrayBuffer>(ACTION_NAMESPACE);
      this.action.onMessage = (data, { peerId }) => this.handleAction(data, peerId);
      this.room.onPeerJoin = (peerId) => {
        this.onPeerJoin(peerId);
        if (this.connections.has(peerId)) this.noteSignallingPeerStage('nostr', 'route-established', peerId);
      };
      this.room.onPeerLeave = (peerId) => this.onPeerLeave(peerId);
    } catch (error) {
      this.room = undefined;
      this.action = undefined;
      this.noteSignallingError('nostr', error, 'startup', 'startup');
      throw new Error(`Could not start Trystero: ${formatError(error)}`, { cause: error });
    }
    this.hasStarted = true;
    await this.startRelayFallback();
    this.timers = [
      setInterval(() => this.heartbeatTick(), 500),
      setInterval(() => void this.pingTick(), 1000),
      setInterval(() => this.metricsTick(), 1000),
      setInterval(() => this.cleanupSeenIds(), 10_000),
      setInterval(() => this.relaySweepTick(), 20_000),
    ];
    // Secondary signalling family and passive network-change watching are
    // strictly additive: neither can affect an already-working session.
    try { this.startSecondarySignalling(); } catch { /* primary stays up */ }
    if (!this.options.roomFactory && !MeshTransport.testingRoomFactory) {
      this.networkWatcher.start();
    }
    if (restarting) this.emit('restarted');
    return 0;
  }

  /**
   * Opens the SECONDARY signalling room (MQTT strategy). It runs
   * concurrently with the Nostr room so the failure of one public signalling
   * family does not kill discovery; duplicate discoveries of the same logical
   * participant are deduplicated at admission time. Failures here are
   * contained: the primary Nostr room is never affected.
   */
  private startSecondarySignalling(): void {
    if (this.mqttRoom || this.mqttJoining || this.stopped || this.options.disableSecondarySignalling) return;
    const testFactory = this.options.roomFactory || MeshTransport.testingRoomFactory;
    const factory = this.options.secondaryRoomFactory ?? (testFactory ? undefined : joinMqttRoom);
    if (!factory) return;
    this.signallingEvidence.mqtt = { startedAt: Date.now() };
    this.secondaryUsesProductionSockets = factory === joinMqttRoom;
    this.mqttJoining = true;
    try {
      const turnConfig = this.buildTurnConfig();
      const config: NostrRoomConfig = {
        appId: TRYSTERO_APP_ID,
        password: this.options.token,
        rtcPolyfill: WeriftPeerConnection as unknown as NostrRoomConfig['rtcPolyfill'],
        ...(turnConfig !== undefined ? { turnConfig } : {}),
      };
      const room = factory(config, `${this.options.sessionId}`, {
        handshakeTimeoutMs: 15_000,
        onPeerHandshake: async (rawId, send, receive, isInitiator) => {
          this.beginSignallingHandshake('mqtt');
          this.noteSignallingPeerStage('mqtt', 'peer-discovered');
          try {
            await this.runPeerHandshake(
              MQTT_TRANSPORT_PREFIX + rawId,
              send as (data: unknown) => Promise<void>,
              receive as () => Promise<{ data: unknown }>,
              isInitiator,
            );
            this.noteSignallingPeerStage('mqtt', 'identity-authenticated');
          } catch (error) {
            if (isDuplicatePeerError(error)) {
              // The same logical participant is already connected through the
              // other signalling family: drop this duplicate transport.
              try { this.mqttRoom?.getPeers()[rawId]?.close(); } catch { /* already gone */ }
              return;
            }
            this.noteSignallingError('mqtt', error);
            throw error;
          } finally {
            this.endSignallingHandshake('mqtt');
          }
        },
        onJoinError: (details) => this.noteSignallingError('mqtt', details.error),
      });
      this.mqttRoom = room;
      this.mqttAction = room.makeAction<ArrayBuffer>(ACTION_NAMESPACE);
      this.mqttAction.onMessage = (data, { peerId }) =>
        this.handleAction(data, MQTT_TRANSPORT_PREFIX + peerId);
      room.onPeerJoin = (rawId) => {
        const transportPeerId = MQTT_TRANSPORT_PREFIX + rawId;
        this.onPeerJoin(transportPeerId);
        if (this.connections.has(transportPeerId)) {
          this.noteSignallingPeerStage('mqtt', 'route-established', transportPeerId);
        }
      };
      room.onPeerLeave = (rawId) => this.onPeerLeave(MQTT_TRANSPORT_PREFIX + rawId);
    } catch (error) {
      this.mqttRoom = undefined;
      this.mqttAction = undefined;
      this.noteSignallingError('mqtt', error, 'startup', 'startup');
    } finally {
      this.mqttJoining = false;
    }
  }

  /** Resolves the room/action pair owning a transport id. */
  private roomForTransport(transportPeerId: string): {
    room: Room | undefined;
    action: MessageAction<ArrayBuffer> | undefined;
    rawId: string;
  } {
    if (transportPeerId.startsWith(RELAY_TRANSPORT_PREFIX)) {
      // Emergency relay routes are logical authenticated connections carried
      // by FrameRelay, not peers owned by any Trystero room.
      return {
        room: undefined,
        action: undefined,
        rawId: transportPeerId.slice(RELAY_TRANSPORT_PREFIX.length),
      };
    }
    if (transportPeerId.startsWith(MQTT_TRANSPORT_PREFIX)) {
      return {
        room: this.mqttRoom,
        action: this.mqttAction,
        rawId: transportPeerId.slice(MQTT_TRANSPORT_PREFIX.length),
      };
    }
    if (transportPeerId.startsWith(UPGRADE_TRANSPORT_PREFIX)) {
      return {
        room: this.upgradeRoom,
        action: this.upgradeAction,
        rawId: transportPeerId.slice(UPGRADE_TRANSPORT_PREFIX.length),
      };
    }
    return { room: this.room, action: this.action, rawId: transportPeerId };
  }

  /** Tests liveness through the transport that actually owns the route. */
  private isTransportRouteLive(transportPeerId: string): boolean {
    if (transportPeerId.startsWith(RELAY_TRANSPORT_PREFIX)) {
      return this.connections.has(transportPeerId)
        && Boolean(this.relay && this.relay.connectedRelayCount > 0);
    }
    const owner = this.roomForTransport(transportPeerId);
    return Boolean(owner.room?.getPeers()[owner.rawId]);
  }

  /**
   * Bounded reaction to a network change: NEVER tears down a healthy route.
   * The change is only used as a reason to search for alternatives - relay
   * fallback for unmapped peers and a safe improvement attempt for peers
   * stuck on the emergency relay. All guards inside those paths apply.
   */
  private onNetworkChanged(): void {
    if (this.stopped) return;
    this.emit('networkChanged');
    this.reevaluateRoutes();
  }

  private reevaluateRoutes(): void {
    for (const peerId of this.directory.keys()) {
      if (peerId === this.options.localPeer.peerId) continue;
      if (!this.identityToTransport.has(peerId) && !this.relayNegotiations.has(peerId)) {
        this.relayAttempts.delete(peerId); // allow one fresh negotiation round
        this.considerRelayFallback(peerId);
      }
    }
    for (const peerId of [...this.identityToTransport.keys()]) {
      const transportId = this.identityToTransport.get(peerId);
      if (transportId?.startsWith(RELAY_TRANSPORT_PREFIX) && !this.routeUpgrades.has(peerId)) {
        this.tryImproveRoute(peerId);
      }
    }
  }

  /** Signalling families backed by an open endpoint or real peer lifecycle evidence. */
  public activeSignallingFamilies(): string[] {
    return this.signallingDiagnostics()
      .filter((family) => family.active)
      .map((family) => family.family);
  }

  /** Sanitized signalling lifecycle evidence safe for diagnostics and UI. */
  public signallingDiagnostics(): SignallingFamilyDiagnostic[] {
    return [this.signallingFamilyDiagnostic('nostr'), this.signallingFamilyDiagnostic('mqtt')];
  }

  private signallingFamilyDiagnostic(family: 'nostr' | 'mqtt'): SignallingFamilyDiagnostic {
    const evidence = this.signallingEvidence[family];
    const roomCreated = family === 'nostr' ? Boolean(this.room) : Boolean(this.mqttRoom);
    const enabled = family === 'nostr'
      ? !this.stopped
      : !this.stopped && !this.options.disableSecondarySignalling
        && Boolean(this.mqttRoom || evidence.startedAt || this.options.secondaryRoomFactory
          || (!this.options.roomFactory && !MeshTransport.testingRoomFactory));
    const endpoints = this.signallingEndpointDiagnostics(family);
    const connectedEndpoints = endpoints.filter((endpoint) =>
      endpoint.state === 'connected' || endpoint.state === 'subscribed'
        || endpoint.state === 'publish-verified').length;
    const capableEndpoints = endpoints.filter((endpoint) =>
      endpoint.state === 'publish-verified'
        && endpoint.subscription === 'verified'
        && endpoint.publication === 'verified').length;
    const currentConnections = [...this.connections.entries()]
      .filter(([transportPeerId, connection]) =>
        this.transportBelongsToSignallingFamily(transportPeerId, family)
          && this.identityToTransport.get(connection.identity.peerId) === transportPeerId)
      .map(([, connection]) => connection);
    const pendingHandshakes = [...this.pendingHandshakes.keys()]
      .filter((transportPeerId) => this.transportBelongsToSignallingFamily(transportPeerId, family)).length;
    const handshakesInFlight = evidence.handshakesInFlight ?? 0;
    const active = enabled && (capableEndpoints > 0
      || pendingHandshakes > 0
      || handshakesInFlight > 0);
    const routes = (['runtime', 'bootstrap'] as const).flatMap((purpose) => {
      const count = currentConnections.filter((connection) => connection.purpose === purpose).length;
      return count > 0 ? [{ purpose, count }] : [];
    });
    const directEvidence: string[] = [];
    if (connectedEndpoints > 0) directEvidence.push(`socket-connected:${connectedEndpoints}`);
    const subscribedEndpoints = endpoints.filter((endpoint) => endpoint.subscription === 'verified').length;
    const publishingEndpoints = endpoints.filter((endpoint) => endpoint.publication === 'verified').length;
    if (subscribedEndpoints > 0) directEvidence.push(`subscription-verified:${subscribedEndpoints}`);
    if (publishingEndpoints > 0) directEvidence.push(`publication-verified:${publishingEndpoints}`);
    if (evidence.peerDiscoveredAt !== undefined) directEvidence.push('peer-discovered');
    if (evidence.identityAuthenticatedAt !== undefined) directEvidence.push('identity-authenticated');
    for (const route of routes) directEvidence.push(`${route.purpose}-route-selected:${route.count}`);
    const endpointLastError = endpoints
      .flatMap((endpoint) => endpoint.lastError ? [endpoint.lastError] : [])
      .sort((left, right) => right.at - left.at)[0];
    const lastError = !evidence.lastError
      ? endpointLastError
      : !endpointLastError || evidence.lastError.at >= endpointLastError.at
        ? evidence.lastError
        : endpointLastError;
    let stage: SignallingFamilyDiagnostic['stage'];
    if (!enabled) stage = 'disabled';
    else if (currentConnections.length > 0) stage = 'route-established';
    else if (pendingHandshakes > 0) stage = 'identity-authenticated';
    else if (handshakesInFlight > 0) stage = 'peer-discovered';
    else if (connectedEndpoints > 0) stage = 'socket-connected';
    else if (lastError) stage = 'failed';
    else if (roomCreated || evidence.startedAt !== undefined) stage = 'starting';
    else stage = 'idle';
    return {
      family,
      enabled,
      active,
      stage,
      roomCreated,
      endpoints,
      evidence: directEvidence,
      routes,
      ...(evidence.lastRefresh ? { lastRefresh: { ...evidence.lastRefresh } } : {}),
      ...(lastError ? { lastError: { ...lastError } } : {}),
    };
  }

  private signallingEndpointDiagnostics(family: 'nostr' | 'mqtt'): SignallingFamilyDiagnostic['endpoints'] {
    const productionSockets = family === 'nostr'
      ? this.primaryUsesProductionSockets
      : this.secondaryUsesProductionSockets;
    if (!productionSockets) return [];
    const configured = family === 'nostr' ? TRYSTERO_RELAY_URLS : MQTT_SIGNALLING_RELAY_URLS.slice(0, 4);
    let sockets: Record<string, { readyState?: number }> = {};
    try {
      sockets = (family === 'nostr' ? getNostrRelaySockets() : getMqttRelaySockets()) as typeof sockets;
    } catch { /* diagnostics must never affect transport */ }
    const mqttHealth = family === 'mqtt'
      ? new Map(getMqttRelayHealth(TRYSTERO_APP_ID, this.options.sessionId)
        .map((health) => [health.endpointId, health]))
      : new Map();
    const nostrRoomHealth = family === 'nostr'
      ? new Map(getNostrRelayHealth(TRYSTERO_APP_ID, this.options.sessionId)
        .map((health) => [health.endpointId, health]))
      : new Map();
    const nostrHealth = family === 'nostr'
      ? new Map(getSignallingSocketHealth().map((health) => [health.endpointId, health]))
      : new Map();
    const endpointLabels = new Map<string, string>();
    for (const url of configured) {
      const identity = signallingEndpointIdentity(url);
      endpointLabels.set(identity.id, identity.label);
    }
    for (const health of [...mqttHealth.values(), ...nostrRoomHealth.values(), ...nostrHealth.values()]) {
      endpointLabels.set(health.endpointId, health.endpoint);
    }
    const readyStates = new Map(Object.entries(sockets).map(([url, socket]) => {
      const identity = signallingEndpointIdentity(url);
      endpointLabels.set(identity.id, identity.label);
      return [identity.id, socket.readyState];
    }));
    return [...endpointLabels].map(([endpointId, endpoint]) => {
      const readyState = readyStates.get(endpointId);
      const health = family === 'mqtt' ? mqttHealth.get(endpointId) : nostrRoomHealth.get(endpointId);
      const socketHealth = family === 'nostr' ? nostrHealth.get(endpointId) : undefined;
      const connected = health?.connected ?? readyState === 1;
      const state: SignallingFamilyDiagnostic['endpoints'][number]['state'] = connected
        ? health?.subscription === 'failed' || health?.publication === 'failed'
          ? 'failed'
          : health?.publication === 'verified'
            && health.subscription === 'verified'
          ? 'publish-verified'
          : health?.subscription === 'verified'
            ? 'subscribed'
            : 'connected'
        : socketHealth?.state === 'failed'
          ? 'failed'
          : readyState === 0 || socketHealth?.state === 'connecting'
          ? 'connecting'
          : health?.lastError
            ? 'failed'
            : readyState === undefined && !health
            ? 'not-observed'
            : 'disconnected';
      return {
        id: endpointId,
        endpoint,
        state,
        subscription: health?.subscription ?? 'not-observed',
        publication: health?.publication ?? 'not-observed',
        ...(health?.lastError || socketHealth?.lastError
          ? { lastError: { ...(health?.lastError ?? socketHealth!.lastError!) } }
          : {}),
      };
    });
  }

  private transportBelongsToSignallingFamily(
    transportPeerId: string,
    family: 'nostr' | 'mqtt',
  ): boolean {
    if (transportPeerId.startsWith(RELAY_TRANSPORT_PREFIX)) return false;
    return family === 'mqtt'
      ? transportPeerId.startsWith(MQTT_TRANSPORT_PREFIX)
      : !transportPeerId.startsWith(MQTT_TRANSPORT_PREFIX);
  }

  private signallingFamilyForTransport(transportPeerId: string): 'nostr' | 'mqtt' | undefined {
    if (transportPeerId.startsWith(RELAY_TRANSPORT_PREFIX)) return undefined;
    return transportPeerId.startsWith(MQTT_TRANSPORT_PREFIX) ? 'mqtt' : 'nostr';
  }

  private beginSignallingHandshake(family: 'nostr' | 'mqtt'): void {
    const evidence = this.signallingEvidence[family];
    evidence.handshakesInFlight = (evidence.handshakesInFlight ?? 0) + 1;
  }

  private endSignallingHandshake(family: 'nostr' | 'mqtt'): void {
    const evidence = this.signallingEvidence[family];
    evidence.handshakesInFlight = Math.max(0, (evidence.handshakesInFlight ?? 1) - 1);
  }

  private noteSignallingPeerStage(
    family: 'nostr' | 'mqtt',
    stage: 'peer-discovered' | 'identity-authenticated' | 'route-established',
    transportPeerId?: string,
  ): void {
    const evidence = this.signallingEvidence[family];
    const now = Date.now();
    if (stage === 'peer-discovered') evidence.peerDiscoveredAt = now;
    else if (stage === 'identity-authenticated') evidence.identityAuthenticatedAt = now;
    else {
      evidence.routeEstablishedAt = now;
      evidence.routePurpose = transportPeerId
        ? this.connections.get(transportPeerId)?.purpose ?? this.pendingHandshakes.get(transportPeerId)?.purpose
        : undefined;
    }
  }

  private noteSignallingError(
    family: 'nostr' | 'mqtt',
    error: unknown,
    category?: NonNullable<SignallingFamilyDiagnostic['lastError']>['category'],
    phase?: NonNullable<SignallingFamilyDiagnostic['lastError']>['phase'],
  ): void {
    this.signallingEvidence[family].lastError = {
      category: category ?? classifySignallingError(error),
      phase: phase ?? (this.options.purpose === 'bootstrap' ? 'bootstrap' : 'handshake'),
      at: Date.now(),
    };
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
    const urls = meshNetworkConfig.turnUrls?.length ? [...meshNetworkConfig.turnUrls] : [...DEFAULT_TURN_URLS];
    const endpoints = parseTurnEndpoints(urls);
    this.turnEndpoints = undefined;
    this.turnProbes = undefined;
    this.turnStatus = urls.length === 0 ? 'not-configured' : endpoints.length === 0 ? 'invalid' : 'configured';
    if (endpoints.length === 0) return undefined;
    const username = meshNetworkConfig.turnUsername ?? '';
    const password = meshNetworkConfig.turnPassword ?? '';
    const ordered = orderTurnEndpoints(endpoints);
    const entry = {
      urls: ordered.map((endpoint) => endpoint.url),
      username,
      credential: password,
    };
    this.turnEndpoints = ordered;
    const testMode = Boolean(this.options.roomFactory || MeshTransport.testingRoomFactory);
    if (!meshNetworkConfig.disableTurnProbe && !testMode) {
      // Live probing dials real relays; skip it for in-memory test rooms.
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
      turnStatus: this.turnStatus,
      turnEndpoints: (this.turnEndpoints ?? []).map((endpoint) => ({ ...endpoint })),
      turnProbes: (this.turnProbes ?? []).map((probe) => ({
        url: probe.endpoint.url,
        transport: probe.endpoint.transport,
        ok: probe.ok,
        ...(probe.ok ? { latencyMs: probe.latencyMs } : { error: probe.error }),
      })),
      proxy: describeProxy(resolveSignallingProxy('wss://nos.lol')),
      stunServers: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
      udpAvailability: assessUdpAvailability(this.turnProbes ?? []),
      signallingFamilies: this.activeSignallingFamilies(),
      signalling: this.signallingDiagnostics(),
      relayFallback: {
        enabled: !meshNetworkConfig.disableRelayFallback,
        connectedRelays: this.relay?.connectedRelayCount ?? 0,
        peers: [...this.connections.keys()]
          .filter((transportPeerId) => transportPeerId.startsWith(RELAY_TRANSPORT_PREFIX))
          .map((transportPeerId) => {
            const connection = this.connections.get(transportPeerId);
            return connection?.identity.peerId ?? transportPeerId;
          }),
      },
    };
  }

  /**
   * Recreates signalling sockets through their existing reconnect loops while
   * leaving authenticated WebRTC/emergency-relay data routes untouched.
   */
  public refreshSignalling(): Promise<SignallingRefreshResult> {
    if (this.signallingRefreshInFlight) return this.signallingRefreshInFlight;
    const refresh = this.performSignallingRefresh();
    this.signallingRefreshInFlight = refresh;
    const clearRefresh = (): void => {
      if (this.signallingRefreshInFlight === refresh) this.signallingRefreshInFlight = undefined;
    };
    void refresh.then(clearRefresh, clearRefresh);
    return refresh;
  }

  private async performSignallingRefresh(): Promise<SignallingRefreshResult> {
    const requestedAt = Date.now();
    const emptyFamily = (): SignallingFamilyRefreshResult => ({
      requestedSockets: 0,
      replacedSockets: 0,
      verifiedEndpoints: 0,
    });
    if (this.stopped) {
      return {
        requestedAt,
        completedAt: requestedAt,
        status: 'no-sockets',
        nostr: emptyFamily(),
        mqtt: emptyFamily(),
      };
    }
    const nostrRequest = this.primaryUsesProductionSockets
      ? refreshNostrRelaySockets(TRYSTERO_APP_ID, this.options.sessionId)
      : { targets: [] };
    const mqttRequest = this.secondaryUsesProductionSockets
      ? refreshMqttRelaySockets(TRYSTERO_APP_ID, this.options.sessionId)
      : { targets: [] };
    this.reevaluateRoutes();
    const timeoutMs = Math.max(1, this.options.signallingRefreshTimeoutMs ?? 10_000);
    const deadline = requestedAt + timeoutMs;
    let nostrProgress = { replaced: 0, verified: 0 };
    let mqttProgress = { replaced: 0, verified: 0 };
    const familyComplete = (requested: number, verified: number): boolean => requested === 0 || verified > 0;
    while (!this.stopped && Date.now() < deadline) {
      nostrProgress = nostrRelaySocketRefreshProgress(
        TRYSTERO_APP_ID,
        this.options.sessionId,
        nostrRequest,
      );
      mqttProgress = mqttRelaySocketRefreshProgress(
        TRYSTERO_APP_ID,
        this.options.sessionId,
        mqttRequest,
      );
      if (familyComplete(nostrRequest.targets.length, nostrProgress.verified)
        && familyComplete(mqttRequest.targets.length, mqttProgress.verified)) break;
      await delay(50);
    }
    const nostr: SignallingFamilyRefreshResult = {
      requestedSockets: nostrRequest.targets.length,
      replacedSockets: nostrProgress.replaced,
      verifiedEndpoints: nostrProgress.verified,
    };
    const mqtt: SignallingFamilyRefreshResult = {
      requestedSockets: mqttRequest.targets.length,
      replacedSockets: mqttProgress.replaced,
      verifiedEndpoints: mqttProgress.verified,
    };
    const requestedSockets = nostr.requestedSockets + mqtt.requestedSockets;
    const verifiedEndpoints = nostr.verifiedEndpoints + mqtt.verifiedEndpoints;
    const everyRequestedFamilyVerified = familyComplete(nostr.requestedSockets, nostr.verifiedEndpoints)
      && familyComplete(mqtt.requestedSockets, mqtt.verifiedEndpoints);
    const status: SignallingRefreshStatus = requestedSockets === 0
      ? 'no-sockets'
      : everyRequestedFamilyVerified
        ? 'verified'
        : verifiedEndpoints > 0
          ? 'partial'
          : 'timed-out';
    const completedAt = Date.now();
    const familyStatus = (family: SignallingFamilyRefreshResult): SignallingRefreshStatus => (
      family.requestedSockets === 0
        ? 'no-sockets'
        : family.verifiedEndpoints > 0
          ? 'verified'
          : 'timed-out'
    );
    if (this.room) {
      this.signallingEvidence.nostr.lastRefresh = {
        at: completedAt,
        status: familyStatus(nostr),
        ...nostr,
      };
    }
    if (this.mqttRoom) {
      this.signallingEvidence.mqtt.lastRefresh = {
        at: completedAt,
        status: familyStatus(mqtt),
        ...mqtt,
      };
    }
    const result = { requestedAt, completedAt, status, nostr, mqtt };
    this.emit('signallingRefreshed', result);
    return result;
  }

  /** Trystero discovers room peers automatically; this re-announces identity to an already connected peer. */
  public connect(peer: PeerIdentity): void {
    if (this.stopped || peer.peerId === this.options.localPeer.peerId) return;
    const error = validatePeerIdentity(peer);
    if (error) throw new Error(`Cannot remember an invalid peer: ${error}`);
    this.rememberPeer(normalizedPeerIdentity(peer));
    if (this.identityToTransport.has(peer.peerId)) this.sendHelloAck(peer.peerId);
  }

  public hasRoute(peerId: string): boolean {
    const transportPeerId = this.identityToTransport.get(peerId);
    return Boolean(transportPeerId && this.connections.has(transportPeerId));
  }

  public isPeerRecovering(peerId: string): boolean {
    return this.recoveringPeers.has(peerId);
  }

  /** Waits for an authenticated replacement route without changing host state. */
  public async waitForRoute(peerId: string, timeoutMs = LOGICAL_PEER_RECOVERY_MS): Promise<void> {
    if (this.hasRoute(peerId)) return;
    const remembered = this.directory.get(peerId);
    if (remembered && peerId !== this.options.localPeer.peerId) this.beginLogicalRecovery(remembered, 'runtime');
    const deadline = Date.now() + Math.max(1, timeoutMs);
    while (!this.stopped && Date.now() < deadline) {
      if (this.hasRoute(peerId)) return;
      await delay(50);
    }
    throw new Error(`No authenticated route to peer ${peerId} after route recovery.`);
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

  /** Starts independent Nostr and MQTT emergency data relays unless disabled. */
  private async startRelayFallback(): Promise<void> {
    if (this.relay || meshNetworkConfig.disableRelayFallback || this.stopped) return;
    // Tests inject a custom room factory (options or the testing hook) to run
    // in-memory transports; a relay there would dial real public Nostr relays
    // from unit tests. Production callers never inject one, so the fallback
    // stays on for them (tests can still opt in via an explicit relayFactory).
    const testRoomFactory = this.options.roomFactory || MeshTransport.testingRoomFactory;
    if (testRoomFactory && !meshNetworkConfig.relayFactory) return;
    try {
      this.relay = meshNetworkConfig.relayFactory?.({
        token: this.options.token,
        sessionId: this.options.sessionId,
        localPeerId: this.options.localPeer.peerId,
      }) ?? new RedundantFrameRelay({
        token: this.options.token,
        sessionId: this.options.sessionId,
        localPeerId: this.options.localPeer.peerId,
      });
    } catch (error) {
      this.relay = undefined;
      throw new Error(`Guaranteed emergency relay construction failed: ${formatError(error)}`, { cause: error });
    }
    this.relay.onPeerAnnounce = (peerId) => {
      if (!this.identityToTransport.has(peerId)) this.considerRelayFallback(peerId);
    };
    this.relay.onFrame = (fromPeerId, bytes) => this.handleRelayData(fromPeerId, bytes);
    this.relay.start();
    try {
      await this.relay.waitUntilReady?.(15_000);
    } catch (error) {
      this.relay.stop();
      this.relay = undefined;
      throw new Error(`Guaranteed emergency relay readiness failed: ${formatError(error)}`, { cause: error });
    }
    // Announce presence a few times so peers joining via WebRTC-less paths
    // find each other even if some early publishes race the socket open.
    for (const delayMs of [500, 4_000, 12_000]) {
      const timer = setTimeout(() => {
        if (!this.stopped) this.relay?.sendAnnounce();
      }, delayMs);
      timer.unref?.();
    }
  }

  /**
   * Shared signed identity handshake used by both the discovery room and the
   * short-lived route-upgrade room. `transportKey` is the pending-handshake
   * map key, which may carry the UPGRADE_TRANSPORT_PREFIX.
   */
  private async runPeerHandshake(
    transportKey: string,
    send: (data: unknown) => Promise<void>,
    receive: () => Promise<{ data: unknown }>,
    isInitiator: boolean,
  ): Promise<void> {
    const local = this.localHandshake();
    let incoming: { data: unknown };
    if (isInitiator) {
      await send(local);
      incoming = await receive();
    } else {
      incoming = await receive();
      await send(local);
    }
    const remote = this.parseHandshake(incoming.data);
    const isUpgradeTransport = transportKey.startsWith(UPGRADE_TRANSPORT_PREFIX);
    const upgradeGeneration = isUpgradeTransport
      ? this.routeUpgrades.get(remote.peer.peerId)
      : undefined;
    if (isUpgradeTransport
      && (!upgradeGeneration || !this.isUpgradeIncumbentCurrent(upgradeGeneration))) {
      throw new Error('Route-upgrade handshake started without a current authorized attempt.');
    }
    const transcript = handshakeTranscript(
      isInitiator ? local : remote,
      isInitiator ? remote : local,
    );
    const localProof: HandshakeProof = {
      version: HANDSHAKE_VERSION,
      signature: signIdentityTranscript(this.identityPrivateKey, transcript),
      transcriptId: handshakeTranscriptId(transcript),
    };
    let incomingProof: { data: unknown };
    if (isInitiator) {
      await send(localProof);
      incomingProof = await receive();
    } else {
      incomingProof = await receive();
      await send(localProof);
    }
    const remoteProof = this.parseHandshakeProof(incomingProof.data);
    if (remoteProof.transcriptId && remoteProof.transcriptId !== handshakeTranscriptId(transcript)) {
      throw new Error('Peer identity proof belongs to a different handshake attempt.');
    }
    if (!verifyIdentityTranscript(remote.peer.identityKey!, transcript, remoteProof.signature)) {
      throw new Error(`Peer ${remote.peer.peerId} did not prove ownership of its identity key.`);
    }
    if (isUpgradeTransport
      && (!upgradeGeneration
        || this.routeUpgrades.get(remote.peer.peerId) !== upgradeGeneration
        || !this.isUpgradeIncumbentCurrent(upgradeGeneration))) {
      throw new Error('Route-upgrade handshake outlived its authorized attempt.');
    }
    // During an explicit upgrade the working route must survive the candidate
    // handshake, so assertPeerCanJoin defers retirement for prefixed keys.
    const admittedPeer = this.assertPeerCanJoin(remote.peer, transportKey);
    this.pendingHandshakes.set(transportKey, {
      ...remote,
      peer: admittedPeer,
      admittedAt: Date.now(),
      ...(upgradeGeneration ? { upgradeGeneration } : {}),
    });
  }

  /**
   * Opens (or reuses) the dedicated make-before-break negotiation room. This
   * is a SECOND Trystero room derived deterministically from the session id,
   * so both sides reach it without any extra configuration. Joining it never
   * touches existing transports: the working relay route stays fully alive
   * while the direct candidate is being built inside this room.
   */
  private ensureUpgradeRoom(): void {
    if (this.upgradeRoom || this.stopped || this.upgradeJoining) return;
    const buildCallbacks = (): JoinRoomCallbacks => ({
      handshakeTimeoutMs: 15_000,
      onPeerHandshake: async (rawId, send, receive, isInitiator) => {
        await this.runPeerHandshake(UPGRADE_TRANSPORT_PREFIX + rawId, send as (data: unknown) => Promise<void>, receive as () => Promise<{ data: unknown }>, isInitiator);
      },
      // Candidate failures are expected outcomes of probing; they are
      // reported through the upgrade state machine instead of the global
      // connectionError channel that would alarm the session runtime.
      onJoinError: () => undefined,
    });
    this.upgradeJoining = true;
    try {
      const factory = this.options.roomFactory ?? MeshTransport.testingRoomFactory ?? joinRoom;
      const config: NostrRoomConfig = {
        appId: TRYSTERO_APP_ID,
        password: this.options.token,
        rtcPolyfill: WeriftPeerConnection as unknown as NostrRoomConfig['rtcPolyfill'],
        relayConfig: {
          urls: TRYSTERO_RELAY_URLS,
          redundancy: RELAY_REDUNDANCY,
          warnOnRelayFailure: false,
        },
      };
      this.upgradeRoom = factory(config, `${this.options.sessionId}${ROUTE_UPGRADE_ROOM_SUFFIX}`, buildCallbacks());
      this.upgradeAction = this.upgradeRoom.makeAction<ArrayBuffer>(ACTION_NAMESPACE);
      this.upgradeAction.onMessage = (data, { peerId }) =>
        this.handleAction(data, UPGRADE_TRANSPORT_PREFIX + peerId);
      this.upgradeRoom.onPeerJoin = (rawId) => this.onUpgradeCandidateJoin(rawId);
      this.upgradeRoom.onPeerLeave = (rawId) => this.onUpgradeCandidateLeave(rawId);
    } catch {
      this.upgradeRoom = undefined;
      this.upgradeAction = undefined;
    } finally {
      this.upgradeJoining = false;
    }
  }

  /** True while at least one make-before-break attempt is in flight. */
  public hasActiveRouteUpgrades(): boolean {
    return this.routeUpgrades.size > 0;
  }

  /** Directory peers currently reachable ONLY through the emergency relay. */
public improvablePeerIds(): string[] {
    if (this.stopped || !this.relay) return [];
    const result: string[] = [];
    for (const [peerId, transportId] of this.identityToTransport) {
      if (!transportId.startsWith(RELAY_TRANSPORT_PREFIX)) continue;
      if (this.routeUpgrades.has(peerId)) continue;
      if (!this.connections.has(transportId)) continue;
      result.push(peerId);
    }
    return result;
  }

  /** Snapshot of running improvement attempts for UI rendering. */
  public activeRouteUpgrades(): RouteUpgradeState[] {
    return [...this.routeUpgrades.values()].map((upgrade) => ({
      peerId: upgrade.peerId,
      role: upgrade.role,
      status: upgrade.status,
      startedAt: upgrade.startedAt,
      ...(upgrade.lastError ? { detail: upgrade.lastError } : {}),
    }));
  }

  /**
   * Starts a safe improvement attempt for a peer currently reachable only
   * through the emergency relay. CRITICAL INVARIANT: the working relay route
   * is never disconnected by this call; the candidate direct connection is
   * built, authenticated, health-checked and kept stable BEFORE promotion,
   * and failure leaves the current route untouched.
   *
   * Returns false when no improvable route exists (e.g. already direct).
   */
  public tryImproveRoute(peerId: string): boolean {
    if (this.stopped || !this.relay) return false;
    if (peerId === this.options.localPeer.peerId) return false;
    if (this.routeUpgrades.has(peerId)) return true; // already optimizing
    const current = this.identityToTransport.get(peerId);
    if (!current || !current.startsWith(RELAY_TRANSPORT_PREFIX)) return false;
    const incumbentConnection = this.connections.get(current);
    if (!incumbentConnection) return false;
    this.ensureUpgradeRoom();
    if (!this.upgradeRoom) return false;
    const upgrade: RouteUpgrade = {
      peerId,
      role: this.options.localPeer.peerId < peerId ? 'initiator' : 'responder',
      status: 'requesting',
      startedAt: Date.now(),
      incumbentTransportId: current,
      incumbentConnection,
      probeAcknowledged: false,
      verifiedPings: 0,
    };
    this.routeUpgrades.set(peerId, upgrade);
    // Ask the peer over the WORKING relay channel to meet us in the upgrade
    // room. If this message is lost the deadline fails the attempt cleanly.
    try {
      this.sendRelayEnvelope(peerId, { k: 'up' });
    } catch {
      this.failRouteUpgrade(upgrade, 'Could not reach the peer through the current connection.');
      return false;
    }
    this.armUpgradeDeadline(upgrade);
    this.emitRouteUpgradeEvent(upgrade);
    return true;
  }

  /** Cancels an in-flight improvement attempt without touching the active route. */
  public cancelRouteUpgrade(peerId: string): void {
    const upgrade = this.routeUpgrades.get(peerId);
    if (!upgrade) return;
    this.discardCandidate(upgrade);
    this.failRouteUpgrade(upgrade, 'The improvement attempt was cancelled.');
  }

  private armUpgradeDeadline(upgrade: RouteUpgrade): void {
    upgrade.deadlineTimer ??= setTimeout(() => {
      if (this.routeUpgrades.get(upgrade.peerId) !== upgrade) return;
      this.discardCandidate(upgrade);
      upgrade.status = 'failed';
      upgrade.lastError = 'The improvement attempt timed out.';
      this.finishUpgrade(upgrade);
    }, ROUTE_UPGRADE_TIMEOUT_MS);
    upgrade.deadlineTimer.unref?.();
  }

  private emitRouteUpgradeEvent(upgrade: RouteUpgrade): void {
    this.emit('routeUpgradeStatus', {
      peerId: upgrade.peerId,
      role: upgrade.role,
      status: upgrade.status,
      startedAt: upgrade.startedAt,
      ...(upgrade.lastError ? { detail: upgrade.lastError } : {}),
    } satisfies RouteUpgradeState);
    // Let the remote participant see our migration progress in real time.
    if (upgrade.status === 'verifying') this.announceLocalRouteStatus('checking-better-route');
    else if (upgrade.status === 'promoting') this.announceLocalRouteStatus('switching-path');
    else if (upgrade.status === 'completed') this.announceLocalRouteStatus('switched-path');
  }

  /** Peer side of "Try to improve": join the upgrade room when asked. */
  private handleUpgradeRequest(fromPeerId: string): void {
    if (this.stopped || !this.relay) return;
    const current = this.identityToTransport.get(fromPeerId);
    if (!current || !current.startsWith(RELAY_TRANSPORT_PREFIX)) return;
    const incumbentConnection = this.connections.get(current);
    if (!incumbentConnection) return;
    let upgrade = this.routeUpgrades.get(fromPeerId);
    if (!upgrade) {
      this.ensureUpgradeRoom();
      if (!this.upgradeRoom) return;
      upgrade = {
        peerId: fromPeerId,
        role: 'responder',
        status: 'waiting-peer',
        startedAt: Date.now(),
        incumbentTransportId: current,
        incumbentConnection,
        probeAcknowledged: false,
        verifiedPings: 0,
      };
      this.routeUpgrades.set(fromPeerId, upgrade);
      this.armUpgradeDeadline(upgrade);
      this.emitRouteUpgradeEvent(upgrade);
    }
  }

  /** Rate-limited publication of OUR migration state to all connected peers. */
  private announceLocalRouteStatus(status: string): void {
    const now = Date.now();
    if (now - this.lastRemoteStatusSentAt < 3_000) return;
    this.lastRemoteStatusSentAt = now;
    try {
      this.broadcast('routeStatus', { messageId: newId(), status });
    } catch { /* best effort: visibility only */ }
  }

  /** Stores a peer's migration notice; bounded and rate-limited by the sender. */
  private acceptRemoteRouteStatus(peerId: string, status: string): void {
    const clean = status.slice(0, 64);
    this.remoteRouteStatuses.set(peerId, { status: clean, at: Date.now() });
    this.emit('remoteRouteStatus', peerId, clean);
  }

  public getRemoteRouteStatus(peerId: string): string | undefined {
    return this.remoteRouteStatuses.get(peerId)?.status;
  }

  private pruneRemoteRouteStatuses(): void {
    const cutoff = Date.now() - 120_000;
    for (const [peerId, entry] of this.remoteRouteStatuses) {
      if (entry.at < cutoff) this.remoteRouteStatuses.delete(peerId);
    }
  }

  /**
   * A candidate direct connection completed its signed handshake inside the
   * upgrade room. Register it WITHOUT touching the active identity mapping:
   * application traffic keeps flowing over the working route until the
   * candidate passes the stability window.
   */
  private onUpgradeCandidateJoin(rawId: string): void {
    if (this.stopped) return;
    const key = UPGRADE_TRANSPORT_PREFIX + rawId;
    const handshake = this.pendingHandshakes.get(key);
    this.pendingHandshakes.delete(key);
    if (!handshake) return;
    const identity = handshake.peer;
    const upgrade = handshake.upgradeGeneration;
    if (!upgrade || this.routeUpgrades.get(identity.peerId) !== upgrade) {
      try { this.upgradeRoom?.getPeers()[rawId]?.close(); } catch { /* already gone */ }
      return;
    }
    if (!this.isUpgradeIncumbentCurrent(upgrade)) {
      try { this.upgradeRoom?.getPeers()[rawId]?.close(); } catch { /* already gone */ }
      this.failRouteUpgrade(upgrade, 'The current route changed before verification completed.');
      return;
    }
    // The candidate must present exactly the directory identity it claims:
    // a mismatched identity key would have failed the signature check above.
    const remembered = this.directory.get(identity.peerId);
    if (remembered?.identityKey && remembered.identityKey !== identity.identityKey) return;
    upgrade.candidateRawId = rawId;
    upgrade.candidateTransportId = key;
    upgrade.connectedAt = Date.now();
    upgrade.status = 'verifying';
    upgrade.verifiedPings = 0;
    upgrade.probeAcknowledged = false;
    this.connections.set(key, {
      transportPeerId: key,
      identity,
      purpose: handshake.purpose,
      connectedAt: upgrade.connectedAt,
      lastSeen: Date.now(),
      snapshotRequested: false,
    });
    this.emitRouteUpgradeEvent(upgrade);
    // Bidirectional application-level probe: the reply proves frames travel
    // in both directions over the CANDIDATE channel specifically.
    const probeMessageId = newId();
    upgrade.probeMessageId = probeMessageId;
    try {
      this.enqueueCandidateFrame(
        key,
        this.createFrame('routeProbe', { messageId: probeMessageId }, new Uint8Array()),
      );
    } catch {
      this.discardCandidate(upgrade);
      this.failRouteUpgrade(upgrade, 'The candidate connection could not send a verification frame.');
      return;
    }
    upgrade.verifyTimer ??= setInterval(() => this.verifyCandidateTick(upgrade!), 1_000);
    upgrade.verifyTimer.unref?.();
  }

  /** Candidate vanished: if it was already ACTIVE, treat it as a real disconnect. */
  private onUpgradeCandidateLeave(rawId: string): void {
    const key = UPGRADE_TRANSPORT_PREFIX + rawId;
    for (const transportId of this.identityToTransport.values()) {
      if (transportId === key) {
        // A promoted direct route died: normal disconnect semantics apply and
        // the relay sweep will rebuild an emergency route for this identity.
        this.onPeerLeave(key);
        return;
      }
    }
    const connection = this.connections.get(key);
    if (connection) {
      // Only clean candidate-scoped state; never global identity mappings.
      this.connections.delete(key);
      this.retireOutboundQueue(key);
      this.takePendingInboundFrames(key);
    }
    for (const upgrade of this.routeUpgrades.values()) {
      if (upgrade.candidateTransportId !== key || upgrade.status === 'completed') continue;
      this.failRouteUpgrade(upgrade, 'The candidate connection dropped during verification.');
    }
  }

  private isUpgradeIncumbentCurrent(upgrade: RouteUpgrade): boolean {
    return upgrade.incumbentTransportId.startsWith(RELAY_TRANSPORT_PREFIX)
      && this.identityToTransport.get(upgrade.peerId) === upgrade.incumbentTransportId
      && this.connections.get(upgrade.incumbentTransportId) === upgrade.incumbentConnection;
  }

  /** One verification step: candidate ping + stability window accounting. */
  private verifyCandidateTick(upgrade: RouteUpgrade): void {
    if (this.routeUpgrades.get(upgrade.peerId) !== upgrade) return;
    if (!this.isUpgradeIncumbentCurrent(upgrade)) {
      this.discardCandidate(upgrade);
      this.failRouteUpgrade(upgrade, 'The current route changed during verification.');
      return;
    }
    const rawId = upgrade.candidateRawId;
    const room = this.upgradeRoom;
    const candidateTransportId = upgrade.candidateTransportId;
    if (upgrade.status !== 'verifying' || !rawId || !room || !candidateTransportId) return;
    const isCurrentCandidate = () => this.routeUpgrades.get(upgrade.peerId) === upgrade
      && this.upgradeRoom === room
      && upgrade.status === 'verifying'
      && upgrade.candidateRawId === rawId
      && upgrade.candidateTransportId === candidateTransportId
      && this.isUpgradeIncumbentCurrent(upgrade)
      && this.connections.has(candidateTransportId);
    void (async () => {
      try {
        const current = await room.ping(rawId);
        if (!isCurrentCandidate()) return;
        if (!Number.isFinite(current) || current < 0) throw new Error('no rtt');
        const bounded = Math.min(60_000, current);
        const connectedFor = Date.now() - (upgrade.connectedAt ?? upgrade.startedAt);
        if (!upgrade.probeAcknowledged || connectedFor < ROUTE_UPGRADE_STABILITY_WINDOW_MS) return;
        upgrade.verifiedPings += 1;
        if (upgrade.verifiedPings >= ROUTE_UPGRADE_REQUIRED_PINGS) {
          this.promoteCandidate(upgrade, bounded);
        }
      } catch {
        if (!isCurrentCandidate()) return;
        // A candidate that cannot hold one-second pings through the stability
        // window is not proven better than the working route: fail closed.
        this.discardCandidate(upgrade);
        this.failRouteUpgrade(upgrade, 'The new route did not stay stable during verification.');
      }
    })();
  }

  /**
   * Atomic promotion: switch the logical identity to the verified candidate
   * FIRST, then retire the superseded relay route. Frames enqueued before the
   * swap stay owned by their original queues; frame ids deduplicate any
   * boundary overlap on the receiver.
   */
  private promoteCandidate(upgrade: RouteUpgrade, measuredRttMs: number): void {
    const key = upgrade.candidateTransportId;
    if (this.routeUpgrades.get(upgrade.peerId) !== upgrade
      || upgrade.status !== 'verifying'
      || !upgrade.probeAcknowledged
      || !this.isUpgradeIncumbentCurrent(upgrade)
      || !key
      || !this.connections.has(key)) return;
    // Route-selection policy (hysteresis + minimum improvement): the final
    // gate before promotion. The candidate already passed authentication and
    // the stability window; this only rejects migrations that would not be a
    // MEANINGFUL improvement.
    const previousTransportId = this.identityToTransport.get(upgrade.peerId) ?? '';
    const decision = shouldMigrateRoute({
      kind: previousTransportId.startsWith(RELAY_TRANSPORT_PREFIX) ? 'relay' : 'direct',
      rttMs: this.latency.get(upgrade.peerId)?.ema ?? -1,
      recentFailures: 0,
    }, { kind: 'direct', rttMs: measuredRttMs, recentFailures: 0 });
    if (!decision.migrate) {
      this.discardCandidate(upgrade);
      this.failRouteUpgrade(upgrade, `Route selection kept the current connection (${decision.reason}).`);
      return;
    }
    upgrade.status = 'promoting';
    this.emitRouteUpgradeEvent(upgrade);
    const previous = upgrade.incumbentTransportId;
    this.identityToTransport.set(upgrade.peerId, key);
    this.routes.set(upgrade.peerId, 'Direct');
    this.latency.set(upgrade.peerId, { current: measuredRttMs, ema: measuredRttMs });
    // NOW retire the old route - only after the candidate is active.
    if (previous?.startsWith(RELAY_TRANSPORT_PREFIX)) {
      const oldConnection = this.connections.get(previous);
      // Frames already enqueued for the old route must not be lost at the
      // switch boundary: move them (order-preserving) to the candidate queue.
      const oldQueue = this.outboundQueues.get(previous);
      if (oldQueue && !oldQueue.failure && (oldQueue.realtimeFrames.length || oldQueue.bulkFrames.length)) {
        const newQueue = this.outboundQueues.get(key) ?? {
          realtimeFrames: [],
          bulkFrames: [],
          queuedBytes: 0,
          inFlightBytes: 0,
          inFlightFrames: 0,
          draining: false,
        };
        newQueue.realtimeFrames.unshift(...oldQueue.realtimeFrames);
        newQueue.bulkFrames.unshift(...oldQueue.bulkFrames);
        newQueue.queuedBytes += oldQueue.queuedBytes;
        this.outboundQueues.set(key, newQueue);
        void this.drain(key, newQueue);
      }
      this.retireOutboundQueue(previous);
      this.connections.delete(previous);
      this.inboundWindows.delete(previous);
      if (oldConnection) {
        // Deliberately no peerDisconnected event: the logical participant
        // stayed online throughout the migration (make-before-break).
        this.emit('routeChanged', oldConnection.identity, 'relay', 'direct');
      }
    }
    upgrade.status = 'completed';
    this.emitRouteUpgradeEvent(upgrade);
    this.finishUpgrade(upgrade);
  }

  /** Removes candidate transport state without touching the active route. */
  private discardCandidate(upgrade: RouteUpgrade): void {
    if (upgrade.verifyTimer) clearInterval(upgrade.verifyTimer);
    upgrade.verifyTimer = undefined;
    const key = upgrade.candidateTransportId;
    if (key) {
      this.connections.delete(key);
      this.retireOutboundQueue(key);
      this.takePendingInboundFrames(key);
      try {
        const rawId = upgrade.candidateRawId;
        if (rawId && this.upgradeRoom) this.upgradeRoom.getPeers()[rawId]?.close();
      } catch { /* best-effort cleanup */ }
    }
    upgrade.candidateTransportId = undefined;
    upgrade.candidateRawId = undefined;
    upgrade.probeMessageId = undefined;
    upgrade.probeAcknowledged = false;
  }

  /** Reports failure and releases the attempt; the active route is untouched. */
  private failRouteUpgrade(upgrade: RouteUpgrade, reason: string): void {
    if (this.routeUpgrades.get(upgrade.peerId) !== upgrade) return;
    upgrade.status = 'failed';
    upgrade.lastError = reason;
    this.emitRouteUpgradeEvent(upgrade);
    this.finishUpgrade(upgrade);
  }

  private finishUpgrade(upgrade: RouteUpgrade): void {
    if (upgrade.deadlineTimer) clearTimeout(upgrade.deadlineTimer);
    upgrade.deadlineTimer = undefined;
    if (upgrade.verifyTimer) clearInterval(upgrade.verifyTimer);
    upgrade.verifyTimer = undefined;
    this.routeUpgrades.delete(upgrade.peerId);
    // Leave the negotiation room only when it no longer hosts anything: not
    // just running attempts but also PROMOTED direct routes, whose peer
    // connections physically live inside this room.
    if (!this.hasUpgradeRoomDependents()) {
      const room = this.upgradeRoom;
      this.upgradeRoom = undefined;
      this.upgradeAction = undefined;
      if (room && !this.stopped) void room.leave().catch(() => undefined);
    }
  }

  /** True while any attempt or any promoted route still needs the upgrade room. */
  private hasUpgradeRoomDependents(): boolean {
    if (this.routeUpgrades.size > 0) return true;
    for (const transportId of this.identityToTransport.values()) {
      if (transportId.startsWith(UPGRADE_TRANSPORT_PREFIX)) return true;
    }
    return false;
  }

  /** Sends one application frame over a candidate transport (probe frames only). */
  private enqueueCandidateFrame(transportKey: string, frame: Buffer): void {
    this.enqueue(transportKey, frame, framePriority('routeProbe'));
  }

  /** Periodically looks for directory peers that never got any transport. */
  private relaySweepTick(): void {
    if (this.stopped || !this.relay) return;
    for (const peerId of this.directory.keys()) {
      if (peerId === this.options.localPeer.peerId) continue;
      if (this.identityToTransport.has(peerId)) continue;
      this.considerRelayFallback(peerId);
    }
  }

  private considerRelayFallback(peerId: string): void {
    if (this.stopped || !this.relay) return;
    if (peerId === this.options.localPeer.peerId) return;
    if (this.identityToTransport.has(peerId)) return; // connected via another transport
    if (!this.hasRelayCandidateCapacity(peerId)) return;
    const attempts = this.relayAttempts.get(peerId) ?? 0;
    if (attempts >= 6 || this.relayNegotiations.has(peerId)) return;
    this.relayAttempts.set(peerId, attempts + 1);
    this.sendRelayHandshake(peerId);
  }

  private sendRelayHandshake(peerId: string): void {
    const existing = this.relayNegotiations.get(peerId);
    const negotiation = existing ?? this.createRelayNegotiation(peerId);
    if (!negotiation.sentLocalHs) {
      negotiation.sentLocalHs = true;
      this.sendRelayEnvelope(peerId, { k: 'hs', hs: negotiation.localHs });
    }
  }

  private createRelayNegotiation(peerId: string): RelayNegotiation {
    const negotiation = {
      role: (this.options.localPeer.peerId < peerId ? 'initiator' : 'responder') as 'initiator' | 'responder',
      localHs: this.localHandshake(),
      sentLocalHs: false,
      sentProof: false,
      remoteHs: undefined,
      remoteProof: undefined,
      timeout: undefined as unknown as NodeJS.Timeout,
    } satisfies RelayNegotiation;
    negotiation.timeout = setTimeout(
      () => this.expireRelayNegotiation(peerId, negotiation),
      RELAY_NEGOTIATION_TIMEOUT_MS,
    );
    negotiation.timeout.unref?.();
    this.relayNegotiations.set(peerId, negotiation);
    return negotiation;
  }

  private expireRelayNegotiation(peerId: string, negotiation: RelayNegotiation): void {
    if (this.relayNegotiations.get(peerId) !== negotiation) return;
    this.relayNegotiations.delete(peerId);
    clearTimeout(negotiation.timeout);
    if (this.stopped || this.identityToTransport.has(peerId)) return;
    const error = new Error(`Emergency relay handshake with ${peerId} timed out; retrying.`);
    const peer = this.directory.get(peerId);
    if (peer) this.emit('connectionError', peer, error);
    else this.emit('protocolError', error);
    this.considerRelayFallback(peerId);
  }

  private failRelayNegotiation(peerId: string, error: unknown): void {
    const negotiation = this.relayNegotiations.get(peerId);
    if (negotiation) clearTimeout(negotiation.timeout);
    this.relayNegotiations.delete(peerId);
    const failure = error instanceof Error ? error : new Error(String(error));
    const peer = this.directory.get(peerId);
    if (peer) this.emit('connectionError', peer, failure);
    else this.emit('protocolError', failure);
    if (!this.stopped && !this.identityToTransport.has(peerId)) {
      queueMicrotask(() => this.considerRelayFallback(peerId));
    }
  }

  private handleRelayData(fromPeerId: string, bytes: Buffer): void {
    const envelope = this.verifyRelayEnvelope(fromPeerId, bytes);
    if (!envelope) return;
    if (envelope.k === 'up') {
      // Remote peer asked us to help build a better route. The working relay
      // channel stays up; we merely join the negotiation room.
      this.handleUpgradeRequest(fromPeerId);
      return;
    }
    if (envelope.k === 'st' && typeof envelope.s === 'string') {
      this.acceptRemoteRouteStatus(fromPeerId, envelope.s);
      return;
    }
    if (envelope.k === 'hs' || envelope.k === 'pr') {
      try {
        this.advanceRelayHandshake(fromPeerId, envelope.k, envelope.hs, envelope.pr);
      } catch (error) {
        // NostrFrameRelay intentionally isolates malformed public-relay input.
        // Convert authenticated Pair Notebook handshake failures into an
        // observable error here, and release the state that otherwise blocks
        // every later fallback attempt.
        this.failRelayNegotiation(fromPeerId, error);
      }
      return;
    }
    if (envelope.k === 'fr' && typeof envelope.d === 'string') {
      const connection = this.connections.get(RELAY_TRANSPORT_PREFIX + fromPeerId);
      if (!connection) return;
      this.handleAction(exactArrayBuffer(Buffer.from(envelope.d, 'base64')), RELAY_TRANSPORT_PREFIX + fromPeerId);
    }
  }

  private hasRelayCandidateCapacity(peerId: string): boolean {
    if (this.directory.has(peerId) || this.recoveringPeers.has(peerId)
      || this.relayAttempts.has(peerId) || this.relayNegotiations.has(peerId)) return true;
    const unknownCandidates = new Set<string>();
    for (const candidate of this.relayAttempts.keys()) {
      if (!this.directory.has(candidate) && !this.recoveringPeers.has(candidate)
        && !this.identityToTransport.has(candidate)) unknownCandidates.add(candidate);
    }
    for (const candidate of this.relayNegotiations.keys()) {
      if (!this.directory.has(candidate) && !this.recoveringPeers.has(candidate)
        && !this.identityToTransport.has(candidate)) unknownCandidates.add(candidate);
    }
    return unknownCandidates.size < MAX_UNKNOWN_RELAY_CANDIDATES;
  }

  private verifyRelayEnvelope(
    fromPeerId: string,
    bytes: Buffer,
  ): { k?: string; hs?: unknown; pr?: unknown; d?: string; s?: string } | undefined {
    let raw: unknown;
    try {
      raw = JSON.parse(bytes.toString('utf8'));
    } catch {
      return undefined;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const envelope = raw as Partial<SignedRelayEnvelope>;
    const { messageId, sentAt, targetPeerId, payload, signature } = envelope;
    if (envelope.version !== RELAY_ENVELOPE_VERSION
      || typeof messageId !== 'string'
      || !MESSAGE_ID_PATTERN.test(messageId)
      || typeof sentAt !== 'number'
      || !Number.isSafeInteger(sentAt)
      || sentAt <= 0
      || targetPeerId !== this.options.localPeer.peerId
      || !payload
      || typeof payload !== 'object'
      || Array.isArray(payload)
      || typeof signature !== 'string') return undefined;
    const now = Date.now();
    if (sentAt < now - RELAY_ENVELOPE_MAX_AGE_MS
      || sentAt > now + RELAY_ENVELOPE_MAX_FUTURE_SKEW_MS) return undefined;
    const identityKey = this.relayEnvelopeIdentityKey(fromPeerId, payload);
    if (!identityKey) return undefined;
    let transcript: Buffer;
    try {
      transcript = relayEnvelopeTranscript(
        this.options.sessionId,
        fromPeerId,
        this.options.localPeer.peerId,
        messageId,
        sentAt,
        payload,
      );
    } catch {
      return undefined;
    }
    if (!verifyIdentityTranscript(identityKey, transcript, signature)) return undefined;
    const replayKey = `${fromPeerId}:${messageId}`;
    if (this.seenRelayEnvelopes.has(replayKey)) return undefined;
    if (this.seenRelayEnvelopes.size >= MAX_SEEN_RELAY_ENVELOPES) {
      this.cleanupSeenRelayEnvelopes(now);
      if (this.seenRelayEnvelopes.size >= MAX_SEEN_RELAY_ENVELOPES) return undefined;
    }
    this.seenRelayEnvelopes.set(replayKey, sentAt);
    return payload;
  }

  private relayEnvelopeIdentityKey(
    fromPeerId: string,
    payload: Record<string, unknown>,
  ): string | undefined {
    const connectedKey = this.connections.get(RELAY_TRANSPORT_PREFIX + fromPeerId)?.identity.identityKey;
    const rememberedKey = this.directory.get(fromPeerId)?.identityKey;
    const negotiatedKey = this.relayNegotiations.get(fromPeerId)?.remoteHs?.peer.identityKey;
    const pinnedKey = connectedKey ?? rememberedKey ?? negotiatedKey;
    if (payload.k !== 'hs') return pinnedKey;
    if (!payload.hs || typeof payload.hs !== 'object' || Array.isArray(payload.hs)) return undefined;
    const handshake = payload.hs as { peer?: unknown };
    if (!handshake.peer || typeof handshake.peer !== 'object' || Array.isArray(handshake.peer)) return undefined;
    const peer = handshake.peer as Partial<PeerIdentity>;
    if (peer.peerId !== fromPeerId || validateIdentityPublicKey(peer.identityKey)) return undefined;
    if (pinnedKey && pinnedKey !== peer.identityKey) return undefined;
    return peer.identityKey;
  }

  private advanceRelayHandshake(
    fromPeerId: string,
    kind: 'hs' | 'pr',
    rawHs: unknown,
    rawPr: unknown,
  ): void {
    let negotiation = this.relayNegotiations.get(fromPeerId);
    if (!negotiation) {
      if (kind !== 'hs') {
        // A proof without a locally started negotiation is meaningless.
        return;
      }
      if (!this.hasRelayCandidateCapacity(fromPeerId)) return;
      // An inbound hs IS the announcement of a new relay-only peer.
      // Role is derived from stable peer IDs on both sides. Treating every
      // inbound handshake as the responder makes two responders whenever the
      // lexically higher peer is the only side that starts fallback.
      negotiation = this.createRelayNegotiation(fromPeerId);
    }
    if (kind === 'hs') {
      const parsed = this.parseHandshake(rawHs);
      if (parsed.sessionId !== this.options.sessionId || parsed.peer.peerId !== fromPeerId) return;
      // Do not replace a handshake while its proof is in flight. Public
      // relays can deliver a newer retry before an older proof; mixing those
      // two transcripts caused false identity failures on healthy sessions.
      if (negotiation.remoteHs && negotiation.remoteHs.nonce !== parsed.nonce) return;
      negotiation.remoteHs = parsed;
      // Always re-answer with our own handshake: both sides may start the
      // negotiation simultaneously and the first copy can arrive before the
      // other side registered the negotiation.
      negotiation.sentLocalHs = true;
      this.sendRelayEnvelope(fromPeerId, { k: 'hs', hs: negotiation.localHs });
    } else if (typeof rawPr === 'object' && rawPr !== null) {
      negotiation.remoteProof = this.parseHandshakeProof(rawPr);
    } else {
      return;
    }
    if (!negotiation.remoteHs) return;
    // Both sides know both handshakes after the hs exchange; send our own
    // proof immediately instead of waiting for the remote one (otherwise
    // both sides deadlock waiting for each other).
    if (!negotiation.sentProof) {
      negotiation.sentProof = true;
      const initiator = negotiation.role === 'initiator' ? negotiation.localHs : negotiation.remoteHs;
      const responder = negotiation.role === 'initiator' ? negotiation.remoteHs : negotiation.localHs;
      const transcript = handshakeTranscript(initiator, responder);
      const signature = signIdentityTranscript(this.identityPrivateKey, transcript);
      negotiation.localProof = {
        version: HANDSHAKE_VERSION,
        signature,
        transcriptId: handshakeTranscriptId(transcript),
      };
      this.sendRelayEnvelope(fromPeerId, {
        k: 'pr',
        pr: negotiation.localProof,
      });
    }
    // Finalize when the remote proof has also arrived.
    if (!negotiation.remoteProof) return;
    const initiator = negotiation.role === 'initiator' ? negotiation.localHs : negotiation.remoteHs;
    const responder = negotiation.role === 'initiator' ? negotiation.remoteHs : negotiation.localHs;
    const transcript = handshakeTranscript(initiator, responder);
    if (negotiation.remoteProof.transcriptId
      && negotiation.remoteProof.transcriptId !== handshakeTranscriptId(transcript)) {
      // This proof belongs to a delayed attempt. Ignore it without consuming
      // the bounded retry budget or reporting a forged-identity error.
      negotiation.remoteProof = undefined;
      return;
    }
    const identityKey = negotiation.remoteHs.peer.identityKey;
    if (!identityKey
      || !verifyIdentityTranscript(identityKey, transcript, negotiation.remoteProof.signature)) {
      throw new Error(`Relay peer ${fromPeerId} failed the identity proof.`);
    }
    const transportPeerId = RELAY_TRANSPORT_PREFIX + fromPeerId;
    const admittedPeer = this.assertPeerCanJoin(negotiation.remoteHs.peer, transportPeerId);
    // The remote proof reaching us does not prove that our first proof reached
    // the remote peer. Replay the exact authenticated proof once before
    // deleting the negotiation so a one-sided final-packet loss cannot leave
    // only one participant admitted indefinitely.
    if (negotiation.localProof) {
      try {
        this.sendRelayEnvelope(fromPeerId, { k: 'pr', pr: negotiation.localProof });
      } catch {
        // The original proof was already queued successfully. A best-effort
        // convergence replay must not revoke otherwise valid local admission.
      }
    }
    this.pendingHandshakes.set(transportPeerId, {
      version: HANDSHAKE_VERSION,
      sessionId: negotiation.remoteHs.sessionId,
      purpose: negotiation.remoteHs.purpose,
      peer: admittedPeer,
      nonce: negotiation.remoteHs.nonce,
    });
    clearTimeout(negotiation.timeout);
    this.relayNegotiations.delete(fromPeerId);
    this.relayAttempts.delete(fromPeerId);
    this.onPeerJoin(transportPeerId);
    this.routes.set(fromPeerId, 'Relay');
  }

  private sendRelayEnvelope(peerId: string, payload: Record<string, unknown>): void {
    this.relay?.send(this.createSignedRelayEnvelope(peerId, payload), peerId);
  }

  private createSignedRelayEnvelope(
    peerId: string,
    payload: Record<string, unknown>,
    sentAt = Date.now(),
  ): Buffer {
    const messageId = newId();
    const transcript = relayEnvelopeTranscript(
      this.options.sessionId,
      this.options.localPeer.peerId,
      peerId,
      messageId,
      sentAt,
      payload,
    );
    const envelope: SignedRelayEnvelope = {
      version: RELAY_ENVELOPE_VERSION,
      messageId,
      sentAt,
      targetPeerId: peerId,
      payload,
      signature: signIdentityTranscript(this.identityPrivateKey, transcript),
    };
    return Buffer.from(JSON.stringify(envelope), 'utf8');
  }

  public peerRuntime(): PeerRuntime[] {
    const activeRuntimeIds = new Set(
      [...this.connections.values()]
        .filter((connection) => connection.purpose === 'runtime')
        .map((connection) => connection.identity.peerId),
    );
    return [...this.directory.values()]
      .filter((peer) => peer.peerId === this.options.localPeer.peerId
        || activeRuntimeIds.has(peer.peerId) || this.recoveringPeers.get(peer.peerId)?.purpose === 'runtime')
      .map((peer) => {
        const transportPeerId = this.identityToTransport.get(peer.peerId);
        const connection = transportPeerId ? this.connections.get(transportPeerId) : undefined;
        const latency = this.latency.get(peer.peerId);
        const local = peer.peerId === this.options.localPeer.peerId;
        const recovering = this.recoveringPeers.get(peer.peerId)?.purpose === 'runtime';
        return {
          ...peer,
          latency: latency?.current ?? (local ? 0 : -1),
          latencyEma: latency?.ema ?? (local ? 0 : -1),
          // SessionCoordinator polls this projection. Refreshing the logical
          // lease while route recovery is bounded prevents its much shorter
          // heartbeat lease from racing the replacement route.
          lastHeartbeat: connection?.lastSeen ?? (local || recovering ? Date.now() : 0),
          missedHeartbeats: 0,
          route: local ? 'Direct' : this.routes.get(peer.peerId) ?? 'Direct',
          online: local || Boolean(connection) || recovering,
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
    for (const recovery of this.recoveringPeers.values()) clearTimeout(recovery.timer);
    this.recoveringPeers.clear();
    this.pendingHandshakes.clear();
    this.pendingInboundFrames.clear();
    this.totalPendingInboundBytes = 0;
    for (const transportPeerId of [...this.outboundQueues.keys()]) {
      this.retireOutboundQueue(transportPeerId);
    }
    this.retiredOutboundQueues.clear();
    this.seenIds.clear();
    this.seenRelayEnvelopes.clear();
    this.inboundWindows.clear();
    if (room) await room.leave();
    this.relay?.stop();
    this.relay = undefined;
    for (const negotiation of this.relayNegotiations.values()) clearTimeout(negotiation.timeout);
    this.relayNegotiations.clear();
    this.relayAttempts.clear();
    for (const upgrade of [...this.routeUpgrades.values()]) {
      if (upgrade.deadlineTimer) clearTimeout(upgrade.deadlineTimer);
      if (upgrade.verifyTimer) clearInterval(upgrade.verifyTimer);
    }
    this.routeUpgrades.clear();
    const upgradeRoom = this.upgradeRoom;
    this.upgradeRoom = undefined;
    this.upgradeAction = undefined;
    const mqttRoom = this.mqttRoom;
    this.mqttRoom = undefined;
    this.mqttAction = undefined;
    this.remoteRouteStatuses.clear();
    this.networkWatcher.stop();
    if (upgradeRoom) await upgradeRoom.leave().catch(() => undefined);
    if (mqttRoom) await mqttRoom.leave().catch(() => undefined);
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
      || proof.signature.length > 128
      || (proof.transcriptId !== undefined
        && (typeof proof.transcriptId !== 'string' || !/^[a-f0-9]{64}$/.test(proof.transcriptId)))) {
      throw new Error('Peer sent an invalid identity proof.');
    }
    return {
      version: HANDSHAKE_VERSION,
      signature: proof.signature,
      ...(proof.transcriptId ? { transcriptId: proof.transcriptId } : {}),
    };
  }

  private assertPeerCanJoin(identity: PeerIdentity, transportPeerId: string): PeerIdentity {
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
      if (!this.options.isHost()) {
        throw new Error(`Peer identity ${identity.peerId} presented a different host-assigned order.`);
      }
      // The current host owns canonical failover order. Parallel Nostr/MQTT
      // handshakes can both be signed before the first admitted route delivers
      // peerAdmission, leaving the second route with the guest's provisional
      // order. The already-pinned key proves this is the same identity; use the
      // host directory's value before duplicate-route handling. Key mismatch
      // is deliberately rejected above and can never reach this normalization.
      identity = { ...identity, joinOrder: remembered.joinOrder };
    }
    const activeTransport = this.identityToTransport.get(identity.peerId);
    // Every transport from the dedicated upgrade room is candidate-only at
    // handshake time. An attempt may have been cancelled or timed out while
    // its authenticated handshake was still settling; such a late candidate
    // must never retire the active route. onUpgradeCandidateJoin() validates
    // the current incumbent and attempt state after the join callback.
    const isUpgradeCandidate = transportPeerId.startsWith(UPGRADE_TRANSPORT_PREFIX);
    if (activeTransport && activeTransport !== transportPeerId && !isUpgradeCandidate) {
      // Both call sites verify the identity-proof signature before this point,
      // so a second handshake for a connected identity comes from the genuine
      // identity holder re-connecting. If the existing route is provably ALIVE
      // through its actual owner, this is the SAME participant discovered
      // through the other signalling family: keep the incumbent
      // (deterministic, no flapping) and let the caller drop the duplicate. A
      // dead or zombie route - lost leave events, vanished Trystero peers, or
      // an emergency relay with no locally verified path - is retired below
      // exactly as before, so lost-leave recovery is unchanged.
      const existing = this.connections.get(activeTransport);
      const routeLive = this.isTransportRouteLive(activeTransport);
      if (existing && routeLive && Date.now() - existing.lastSeen < DUPLICATE_HANDSHAKE_WINDOW_MS) {
        throw new DuplicateSignallingPeerError(identity.peerId);
      }
      this.retireIdentityRoute(activeTransport);
    }
    // An explicit make-before-break upgrade keeps the working route mapped
    // until the candidate has been verified; promotion happens later in
    // promoteCandidate() only after the stability window passes.
    for (const [pendingTransport, pending] of this.pendingHandshakes) {
      if (pendingTransport !== transportPeerId && pending.peer.peerId === identity.peerId) {
        this.retireIdentityRoute(pendingTransport);
      }
    }
    const conflictingPeer = this.connectedDisplayNameOwner(identity, transportPeerId);
    if (conflictingPeer) {
      throw new Error(`Display name is already in use: ${conflictingPeer.displayName}.`);
    }
    return identity;
  }

  /**
   * Drops one transport route of an identity whose holder has just completed
   * a fresh, signature-verified handshake on another route. Only the genuine
   * identity holder can reach that point, so this can never be abused to
   * evict a live peer; it only clears zombie mappings whose leave event was
   * lost (typically over the lossy Nostr relay) or settles a simultaneous
   * dual-path handshake in favour of the route that completed last.
   */
  private retireIdentityRoute(transportPeerId: string): void {
    const owner = this.roomForTransport(transportPeerId);
    try { owner.room?.getPeers()[owner.rawId]?.close(); } catch { /* best effort */ }
    this.pendingHandshakes.delete(transportPeerId);
    this.takePendingInboundFrames(transportPeerId);
    const connection = this.connections.get(transportPeerId);
    this.connections.delete(transportPeerId);
    this.retireOutboundQueue(transportPeerId);
    this.inboundWindows.delete(transportPeerId);
    if (!connection) return;
    this.seenIds.delete(connection.identity.peerId);
    this.latency.delete(connection.identity.peerId);
    if (this.identityToTransport.get(connection.identity.peerId) === transportPeerId) {
      this.identityToTransport.delete(connection.identity.peerId);
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
    // Centralized duplicate-signalling dedupe: the same signed identity can
    // complete handshakes in BOTH families around the same moment. Whichever
    // transport is admitted first wins while it is provably fresh; the other
    // one is closed instead of creating a second live route for the identity.
        const active = this.identityToTransport.get(handshake.peer.peerId);
    if (active && active !== transportPeerId) {
      const existing = this.connections.get(active);
      if (existing && Date.now() - existing.lastSeen < DUPLICATE_HANDSHAKE_WINDOW_MS) {
        const owner = this.roomForTransport(transportPeerId);
        try { owner.room?.getPeers()[owner.rawId]?.close(); } catch { /* already gone */ }
        return;
      }
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
    this.finishLogicalRecovery(handshake.peer.peerId);
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
    // Propagate the death to the room level so the REMOTE side also learns
    // its route died (otherwise a half-dead route stays "fresh" there and
    // blocks symmetric recovery through the surviving signalling family).
    try {
      const owner = this.roomForTransport(transportPeerId);
      owner.room?.getPeers()[owner.rawId]?.close();
    } catch { /* best-effort propagation */ }
    this.pendingHandshakes.delete(transportPeerId);
    this.takePendingInboundFrames(transportPeerId);
    const connection = this.connections.get(transportPeerId);
    if (!connection) return;
    const wasActiveIdentityRoute = this.identityToTransport.get(connection.identity.peerId) === transportPeerId;
    const signallingFamily = this.signallingFamilyForTransport(transportPeerId);
    if (wasActiveIdentityRoute && signallingFamily) {
      this.noteSignallingError(
        signallingFamily,
        new Error('Selected direct route closed.'),
        'socket',
        connection.purpose === 'bootstrap' ? 'bootstrap' : 'route',
      );
    }
    this.connections.delete(transportPeerId);
    this.retireOutboundQueue(transportPeerId);
    this.inboundWindows.delete(transportPeerId);
    this.seenIds.delete(connection.identity.peerId);
    this.latency.delete(connection.identity.peerId);
    if (wasActiveIdentityRoute) {
      this.identityToTransport.delete(connection.identity.peerId);
    }
    if (!this.stopped && wasActiveIdentityRoute) {
      this.beginLogicalRecovery(connection.identity, connection.purpose);
    }
  }

  private beginLogicalRecovery(identity: PeerIdentity, purpose: PeerConnectionPurpose): void {
    if (this.stopped || this.hasRoute(identity.peerId) || this.recoveringPeers.has(identity.peerId)) return;
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      const recovery = this.recoveringPeers.get(identity.peerId);
      if (!recovery || recovery.startedAt !== startedAt) return;
      if (this.hasRoute(identity.peerId)) {
        this.finishLogicalRecovery(identity.peerId);
        return;
      }
      this.recoveringPeers.delete(identity.peerId);
      this.emit(
        recovery.purpose === 'bootstrap' ? 'bootstrapDisconnected' : 'peerDisconnected',
        recovery.identity,
      );
    }, this.options.logicalPeerRecoveryMs ?? LOGICAL_PEER_RECOVERY_MS);
    timer.unref?.();
    this.recoveringPeers.set(identity.peerId, { identity: { ...identity }, purpose, startedAt, timer });
    this.emit('peerRecovering', { ...identity });

    // Do not wait for the periodic 20-second sweep. The already-verified full
    // data relay is the fastest safe replacement for a failed direct route.
    this.relayAttempts.delete(identity.peerId);
    this.relay?.sendAnnounce();
    this.considerRelayFallback(identity.peerId);
  }

  private finishLogicalRecovery(peerId: string): void {
    const recovery = this.recoveringPeers.get(peerId);
    if (!recovery) return;
    clearTimeout(recovery.timer);
    this.recoveringPeers.delete(peerId);
    this.emit('peerRecovered', { ...recovery.identity });
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
    // A failed WebRTC attempt is the primary trigger for the emergency
    // Nostr relay path; the sweep timer covers the no-error-at-all case.
    if (this.directory.has(details.peerId) || pending) {
      this.considerRelayFallback(details.peerId);
    }
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
      .reduce((total, item) => total + item.queuedBytes + item.inFlightBytes, 0)
      + [...this.retiredOutboundQueues].reduce((total, item) => total + item.inFlightBytes, 0);
    const totalRetainedFrames = [...this.outboundQueues.values()].reduce(
      (total, item) => total + item.realtimeFrames.length + item.bulkFrames.length + item.inFlightFrames,
      0,
    ) + [...this.retiredOutboundQueues].reduce((total, item) => total + item.inFlightFrames, 0);
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
      while (!this.stopped
        && this.connections.has(transportPeerId)
        && this.outboundQueues.get(transportPeerId) === queue) {
        const item = queue.realtimeFrames.shift() ?? queue.bulkFrames.shift();
        if (!item) break;
        queue.queuedBytes -= item.bytes.byteLength;
        queue.inFlightBytes += item.bytes.byteLength;
        queue.inFlightFrames += 1;
        try {
          const action = this.action;
          if (!action) throw new Error('Trystero transport stopped during send.');
          if (transportPeerId.startsWith(RELAY_TRANSPORT_PREFIX)) {
            const relayChannel = this.relay;
            if (!relayChannel) throw new Error('Relay fallback transport stopped during send.');
            this.sendRelayEnvelope(
              transportPeerId.slice(RELAY_TRANSPORT_PREFIX.length),
              { k: 'fr', d: item.bytes.toString('base64') },
            );
          } else if (transportPeerId.startsWith(UPGRADE_TRANSPORT_PREFIX)) {
            // Promoted direct route living in the upgrade negotiation room.
            const upgradeAction = this.upgradeAction;
            if (!upgradeAction) throw new Error('Route upgrade room stopped during send.');
            await upgradeAction.send(exactArrayBuffer(item.bytes), {
              target: transportPeerId.slice(UPGRADE_TRANSPORT_PREFIX.length),
            });
          } else if (transportPeerId.startsWith(MQTT_TRANSPORT_PREFIX)) {
            // Direct route discovered through the secondary signalling family.
            const mqttChannel = this.mqttAction;
            if (!mqttChannel) throw new Error('MQTT signalling stopped during send.');
            await mqttChannel.send(exactArrayBuffer(item.bytes), {
              target: transportPeerId.slice(MQTT_TRANSPORT_PREFIX.length),
            });
          } else {
            await action.send(exactArrayBuffer(item.bytes), { target: transportPeerId });
          }
          this.sentWindow += item.bytes.byteLength;
          this.totalSent += item.bytes.byteLength;
        } finally {
          queue.inFlightBytes -= item.bytes.byteLength;
          queue.inFlightFrames -= 1;
          if (queue.inFlightFrames === 0) this.retiredOutboundQueues.delete(queue);
        }
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.failOutboundQueue(transportPeerId, queue, failure);
    } finally {
      queue.draining = false;
      if (!this.stopped
        && this.connections.has(transportPeerId)
        && this.outboundQueues.get(transportPeerId) === queue
        && !queue.failure
        && (queue.realtimeFrames.length || queue.bulkFrames.length)) {
        void this.drain(transportPeerId, queue);
      }
    }
  }

  private failOutboundQueue(transportPeerId: string, queue: OutboundQueue, failure: Error): void {
    if (this.outboundQueues.get(transportPeerId) !== queue || queue.failure) return;
    queue.failure = failure;
    queue.realtimeFrames.length = 0;
    queue.bulkFrames.length = 0;
    queue.queuedBytes = 0;
    const connection = this.connections.get(transportPeerId);
    if (!connection) return;
    const activeTransportId = this.identityToTransport.get(connection.identity.peerId);
    if (transportPeerId.startsWith(UPGRADE_TRANSPORT_PREFIX)
      && activeTransportId !== transportPeerId) {
      const upgrade = this.routeUpgrades.get(connection.identity.peerId);
      if (upgrade?.candidateTransportId === transportPeerId) {
        this.discardCandidate(upgrade);
        this.failRouteUpgrade(upgrade, 'The candidate connection failed while sending a verification frame.');
      } else {
        this.onUpgradeCandidateLeave(transportPeerId.slice(UPGRADE_TRANSPORT_PREFIX.length));
      }
      return;
    }
    try {
      this.roomForTransport(transportPeerId).room?.getPeers()[this.roomForTransport(transportPeerId).rawId]?.close();
    } catch {
      // Local cleanup below does not depend on RTC close succeeding.
    }
    this.onPeerLeave(transportPeerId);
    this.emit('connectionError', connection.identity, failure);
  }

  private retireOutboundQueue(transportPeerId: string): void {
    const queue = this.outboundQueues.get(transportPeerId);
    if (!queue) return;
    queue.realtimeFrames.length = 0;
    queue.bulkFrames.length = 0;
    queue.queuedBytes = 0;
    this.outboundQueues.delete(transportPeerId);
    if (queue.inFlightFrames > 0) this.retiredOutboundQueues.add(queue);
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
      } else if (frame.type === 'routeStatus') {
        const status = typeof frame.meta.status === 'string' ? frame.meta.status : '';
        if (status) this.acceptRemoteRouteStatus(sourceId, status);
      } else if (frame.type === 'routeProbe') {
        // Candidate-route bidirectional health check: answer on the same
        // transport the probe arrived on.
        this.enqueue(
          transportPeerId,
          this.createFrame('routeProbeAck', {
            messageId: newId(),
            probeMessageId: messageId,
          }, new Uint8Array()),
          framePriority('routeProbeAck'),
        );
      } else if (frame.type === 'routeProbeAck') {
        const upgrade = this.routeUpgrades.get(sourceId);
        const probeMessageId = typeof frame.meta.probeMessageId === 'string'
          ? frame.meta.probeMessageId
          : '';
        if (transportPeerId.startsWith(UPGRADE_TRANSPORT_PREFIX)
          && upgrade?.status === 'verifying'
          && upgrade.candidateTransportId === transportPeerId
          && upgrade.probeMessageId === probeMessageId
          && this.isUpgradeIncumbentCurrent(upgrade)) {
          upgrade.probeAcknowledged = true;
        }
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
      const owner = this.roomForTransport(transportPeerId);
      owner.room?.getPeers()[owner.rawId]?.close();
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
    const roomRef = this.room;
    if ((!roomRef && !this.upgradeRoom && !this.mqttRoom) || this.stopped || this.pingInFlight) return;
    this.pingInFlight = true;
    try {
      await Promise.all([...this.connections.values()].map(async (connection) => {
        try {
          // Promoted routes and MQTT-family routes live in their own rooms.
          const owner = this.roomForTransport(connection.transportPeerId);
          const room = owner.room;
          if (!room) return;
          const current = await room.ping(owner.rawId);
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
    this.cleanupSeenRelayEnvelopes(now);
    this.pruneRemoteRouteStatuses();
    for (const [transportPeerId, handshake] of this.pendingHandshakes) {
      if ((handshake.admittedAt ?? now) >= now - PENDING_HANDSHAKE_TTL_MS) continue;
      this.pendingHandshakes.delete(transportPeerId);
      this.takePendingInboundFrames(transportPeerId);
      const owner = this.roomForTransport(transportPeerId);
      try { owner.room?.getPeers()[owner.rawId]?.close(); } catch { /* best effort */ }
      const error = new Error(`Expired incomplete peer admission ${transportPeerId}.`);
      const signallingFamily = this.signallingFamilyForTransport(transportPeerId);
      if (signallingFamily) {
        this.noteSignallingError(
          signallingFamily,
          error,
          'timeout',
          handshake.purpose === 'bootstrap' ? 'bootstrap' : 'route',
        );
      }
      this.emit('protocolError', error);
    }
  }

  private cleanupSeenRelayEnvelopes(now: number): void {
    const oldest = now - RELAY_ENVELOPE_MAX_AGE_MS;
    for (const [id, timestamp] of this.seenRelayEnvelopes) {
      if (timestamp < oldest) this.seenRelayEnvelopes.delete(id);
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
  if (type === 'executeRequest' || type === 'executionEvent' || type === 'executeResult') return 32 * 1024 * 1024;
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

function handshakeTranscriptId(transcript: Buffer): string {
  return createHash('sha256').update(transcript).digest('hex');
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

function relayEnvelopeTranscript(
  sessionId: string,
  sourcePeerId: string,
  targetPeerId: string,
  messageId: string,
  sentAt: number,
  payload: Record<string, unknown>,
): Buffer {
  return Buffer.from([
    'pair-notebook-relay-envelope-v2',
    sessionId,
    sourcePeerId,
    targetPeerId,
    messageId,
    String(sentAt),
    canonicalJson(payload),
  ].join('\0'), 'utf8');
}

/** Deterministic JSON used only for signed protocol transcripts. */
function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Signed relay payload contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => item === undefined ? 'null' : canonicalJson(item)).join(',')}]`;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('Signed relay payload contains an unsupported value.');
  }
  const fields = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${fields.join(',')}}`;
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

function classifySignallingError(
  error: unknown,
): NonNullable<SignallingFamilyDiagnostic['lastError']>['category'] {
  const message = formatError(error).toLowerCase();
  if (/timeout|timed out/.test(message)) return 'timeout';
  if (/dns|getaddrinfo|enotfound|eai_again/.test(message)) return 'dns';
  if (/auth|credential|forbidden|unauthori[sz]ed|connack/.test(message)) return 'authentication';
  if (/websocket|socket|econn|network|closed|disconnect/.test(message)) return 'socket';
  if (/protocol|handshake|sdp|signal|malformed|invalid/.test(message)) return 'protocol';
  return 'unknown';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Thrown when a fully verified handshake arrives for a participant whose
 * existing transport is still provably fresh: this is the same logical peer
 * discovered through the second signalling family, not a reconnection.
 */
class DuplicateSignallingPeerError extends Error {
  public constructor(public readonly identityPeerId: string) {
    super(`Peer identity ${identityPeerId} is already connected through another signalling family.`);
    this.name = 'DuplicateSignallingPeerError';
  }
}

function isDuplicatePeerError(error: unknown): boolean {
  return error instanceof DuplicateSignallingPeerError;
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


