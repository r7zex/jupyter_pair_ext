import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstat, mkdir, open, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';

import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { atomicWriteFile } from '../core/atomicFile';
import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  modifyAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import {
  AUTOSAVE_INTERVAL_MS,
  AUTOSAVE_RETENTION,
  AutosaveStatus,
  LocalAutosaveManager,
  defaultAutosaveRoot,
} from '../core/autosave';
import {
  encodeRelativeOffset,
  ResolvedCursorPosition,
  SharedCursorPosition,
  resolveRelativeOffset,
  resolveSharedCursorPosition,
} from '../core/cursorPosition';
import {
  CollaborativeProject,
  DocumentKind,
  MAX_TEXT_DOCUMENT_BYTES,
  ProjectUpdate,
  normalizeNotebookUpdateScope,
} from '../core/crdt';
import {
  appendJupyterFailureToState,
  applyJupyterEventToState,
  createJupyterRenderState,
  snapshotJupyterOutputs,
  type JupyterRenderState,
} from '../vscode/jupyterOutputState';
import { SessionCoordinator } from '../core/election';
import { CpuSnapshot, discoverHardware, HardwareInfo, ResourceSample, sampleResources } from '../core/hardware';
import { JupyterExecutionResult, JupyterKernel, JupyterKernelEvent } from '../core/pythonKernel';
import { validateIdentityPublicKey } from '../core/identity';
import { discoverPythonEnvironments, PythonEnvironment } from '../core/pythonEnvironments';
import {
  classifyFile,
  decodeUtf8ProjectFile,
  loadCrdtProject,
  MAX_TRACKED_PROJECT_ENTRIES,
  parseIpynb,
  scanDirectories,
  scanProject,
  serializeIpynb,
  shouldTrackProjectPath,
} from '../core/projectFiles';
import { metadataCellId, StableCellIdRegistry } from '../core/notebookIdentity';
import {
  MaterializedFolderInspection,
  StorageAdapter,
  safeProjectTarget,
  safeRelativePath,
} from '../core/persistence';
import {
  filesystemPathComparisonKey,
  portablePathComparisonKey,
  relativePathsNested,
} from '../core/projectPath';
import {
  SessionTerminatedError,
  readSessionTermination,
  writeSessionTermination,
} from '../core/sessionTermination';
import {
  BinaryFileVersion,
  FileLifecycleState,
  HostClock,
  NotebookComputeTarget,
  PeerIdentity,
  PeerRuntime,
  REMOTE_ORIGIN,
  SessionDescriptor,
  cleanDisplayName,
  compareClock,
  newId,
  normalizeDisplayName,
  normalizeHostClock,
  PEER_ID_PATTERN,
  validateDisplayName,
} from '../core/types';
import { WireFrame } from '../core/wire';
import {
  DEFAULT_TRANSFER_CHUNK_SIZE,
  expectedTransferChunkBytes,
  IncomingTransferShape,
  MAX_TRANSFER_BYTES,
  validateIncomingTransfer,
} from '../core/transfer';
import {
  LOGICAL_PEER_RECOVERY_MS,
  MeshMetrics,
  MeshTransport,
  RouteUpgradeState,
  RouteUpgradeStatus,
  type SignallingRefreshResult,
  type TransportLifecycleDiagnostic,
} from './mesh';
import {
  LifecycleDiagnosticRing,
  isDiagnosticCorrelationId,
  type DiagnosticCorrelationId,
  type DiagnosticReason,
  type DiagnosticRouteKind,
  type LifecycleDiagnosticEvent,
  type LifecycleDiagnosticMetadata,
  type LifecycleDiagnosticEventType,
  type RecordLifecycleDiagnosticOptions,
} from './lifecycleDiagnostics';

/**
 * Terminal close reasons are deliberately non-overlapping:
 * - host-unreachable: an established guest lost the pinned host beyond recovery;
 * - local-route-failed: this runtime could not establish its own transport readiness;
 * - explicit-leave: local user/extension disposal;
 * - session-ended: authenticated explicit end by the Session Host.
 */
export type SessionCloseReason = 'host-unreachable' | 'local-route-failed' | 'explicit-leave' | 'session-ended';

export interface SessionTerminalLifecycle {
  reason: SessionCloseReason;
  sessionId: string;
  peerId: string;
  hostId: string;
  at: number;
  /** Opaque diagnostics correlation; emitted for every terminal lifecycle event. */
  correlationId?: DiagnosticCorrelationId;
}

export class SessionClosedError extends Error {
  public constructor(public readonly lifecycle: SessionTerminalLifecycle) {
    super(`Pair Notebook session closed: ${lifecycle.reason}`);
    this.name = 'SessionClosedError';
  }

  public get reason(): SessionCloseReason {
    return this.lifecycle.reason;
  }
}

export interface PresenceState {
  peer: PeerIdentity;
  activeFile?: string | undefined;
  /** Legacy receive-only compatibility for peers that still publish a numeric notebook index. */
  activeNotebookCell?: number | undefined;
  activeNotebookCellId?: string | undefined;
  /** Line-only presence avoids unstable cursor offsets during notebook edits. */
  activeLine?: number | undefined;
  /** CRDT-relative start of the active line, so it follows inserted lines. */
  activeLineAnchor?: string | undefined;
  /** Legacy receive-only compatibility. New local packets never publish exact offsets. */
  cursor?: SharedCursorPosition | undefined;
  shareCursor: boolean;
  cursorColor: string;
  typing?: boolean | undefined;
  autosaveFolder?: string | undefined;
  hardware?: HardwareInfo | undefined;
  environments?: PythonEnvironment[] | undefined;
  resources?: ResourceSample | undefined;
  kernelStatus: 'Idle' | 'Busy' | 'Offline';
  kernelStatuses?: Record<string, 'Idle' | 'Busy' | 'Offline'> | undefined;
}

interface RuntimePresenceMetadata {
  hardware?: HardwareInfo | undefined;
  environments?: PythonEnvironment[] | undefined;
  resources?: ResourceSample | undefined;
  kernelStatus?: 'Idle' | 'Busy' | 'Offline' | undefined;
  kernelStatuses?: Record<string, 'Idle' | 'Busy' | 'Offline'> | undefined;
}

interface PendingBinary {
  relativePath: string;
  received: Set<number>;
  expectedChunks: number;
  hash: string;
  version: number;
  author: string;
  fileState?: FileLifecycleState;
  sourceId: string;
  temporaryPath: string;
  handle: import('node:fs/promises').FileHandle;
  chunkSize: number;
  bytesWritten: number;
  shape: IncomingTransferShape;
  idleTimer: NodeJS.Timeout;
}

interface RenameOrigin {
  to: string;
  toState: FileLifecycleState;
  at: number;
}

/** Small chunks let live edits overtake bulk transfers instead of waiting behind megabytes of buffered data. */
const BINARY_CHUNK_SIZE = DEFAULT_TRANSFER_CHUNK_SIZE;
/** How many recent snapshot file transfers stay retransmittable for lossy relay routes. */
const MAX_SENT_SNAPSHOT_TRANSFERS = 256;
/** A transfer that makes no progress for this long is abandoned and cleaned up. */
const BINARY_IDLE_TIMEOUT_MS = 60_000;
const MAX_ACTIVE_BINARY_TRANSFERS = 16;
const MAX_ACTIVE_BINARY_TRANSFERS_PER_PEER = 4;
const MAX_DECLARED_BINARY_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_DECLARED_BINARY_BYTES_PER_PEER = 4 * 1024 * 1024 * 1024;
const MAX_PENDING_MESSAGES = 4096;
const MAX_PENDING_MESSAGE_BYTES = 128 * 1024 * 1024;
/** Snapshot generation scans and hashes the entire host project, so it gets a much smaller queue. */
const MAX_PENDING_SNAPSHOT_REQUESTS = 4;
const MAX_STATE_CHUNK_METADATA_BYTES = 512 * 1024;
const MAX_SNAPSHOT_CHECKPOINT_FRAMES = 512;
const MAX_SNAPSHOT_CHECKPOINT_BYTES = 32 * 1024 * 1024;
const SNAPSHOT_CHECKPOINT_TIMEOUT_MS = 120_000;
const MAX_AWARENESS_CLIENTS_PER_UPDATE = 32;
const MAX_REMOTE_REVISION_ADVANCE = 1_000_000;
const MAX_EXECUTION_MANIFEST_ENTRIES = 50_000;
const MAX_PENDING_BARRIER_AUTHORIZATIONS = 128;
const BARRIER_AUTHORIZATION_TIMEOUT_MS = 60_000;
const COMPLETED_BARRIER_TIMEOUT_MS = 2 * 60_000;
const MAX_REMOTE_EXECUTION_CODE_BYTES = 32 * 1024 * 1024;
const MAX_REMOTE_INPUT_CHARACTERS = 64 * 1024;
const MAX_REMOTE_EXECUTIONS = 4;
const MAX_REMOTE_EXECUTIONS_PER_PEER = 2;
/** A stuck kernel must end visibly instead of leaving a notebook cell Busy indefinitely. */
const KERNEL_EXECUTION_TIMEOUT_MS = 10 * 60_000;
/** Leave one extra minute for the terminal output/result to cross the route. */
const REMOTE_EXECUTION_TIMEOUT_MS = KERNEL_EXECUTION_TIMEOUT_MS + 60_000;
/** A routed request must be acknowledged before VS Code leaves the cell in a running state. */
const EXECUTION_ACCEPT_TIMEOUT_MS = 45_000;
/** Host waits only this long for the requested target-cell CRDT state to arrive. */
const TARGET_CELL_CONVERGENCE_TIMEOUT_MS = 5_000;
const EXECUTION_REQUEST_RETRY_MS = 1_500;
const EXECUTION_RESULT_RETRY_MS = 1_500;
/** Keep terminal results long enough to replay them after a route replacement. */
const COMPLETED_REMOTE_EXECUTION_TIMEOUT_MS = 5 * 60_000;
const MAX_COMPLETED_REMOTE_EXECUTIONS = 256;
/** Match the controller's bounded render queue so reconnect replay cannot grow without limit. */
const MAX_REPLAYED_EXECUTION_EVENTS = 2_048;
const MAX_REPLAYED_EXECUTION_EVENT_BYTES = 32 * 1024 * 1024;
const MAX_RETAINED_REMOTE_EXECUTION_BYTES = 64 * 1024 * 1024;
const MAX_REMOTE_JUPYTER_BUFFER_BASE64_CHARACTERS = Math.ceil(16 * 1024 * 1024 * 4 / 3) + 4;
const EXECUTION_BARRIER_REPLY_TIMEOUT_MS = 60_000;
const MAX_LIVE_KERNELS = 8;
const MAX_SNAPSHOT_PROJECT_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_KNOWN_PEERS = 255;
const RESOURCE_SAMPLE_INTERVAL_MS = 5_000;
const HARDWARE_REFRESH_INTERVAL_MS = 30 * 60_000;
const REMOTE_JUPYTER_EVENT_TYPES = new Set([
  'accepted', 'iopub', 'shell', 'inputRequest', 'complete', 'commandResult',
  'completionResult', 'kernelInfoResult', 'channelError', 'commandError',
]);
/** Scratch directory for partially received transfers, inside the working copy. */
const TRANSFER_DIRECTORY = '.pair-notebook-transfers';
/**
 * Transfer identifiers come from the network, so only the shape produced by
 * `newId()` is accepted.  Anything else could escape the scratch directory
 * through a relative path.
 */
const TRANSFER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * Unreferenced notebook cell state is dropped only after this long *and* only
 * while every known participant is present (see `isGarbageCollectionSafe`).
 */
const CELL_GC_GRACE_MS = 5 * 60_000;
/** Watcher events can arrive after an extension-owned atomic write has completed. */
const INTERNAL_WRITE_GUARD_MS = 5_000;
const EDITOR_BINDING_GRACE_MS = 500;
const BACKGROUND_MESSAGE_TYPES = new Set([
  'snapshotRequest',
  'binaryStart',
  'binaryChunk',
  'binaryEnd',
  'executionBarrierCheck',
  'kernelCommand',
]);


interface PendingExecution {
  resolve: (result: JupyterExecutionResult) => void;
  reject: (error: Error) => void;
  onEvent: (event: JupyterKernelEvent) => void;
  executorId: string;
  notebookKey: string;
  timer: NodeJS.Timeout | undefined;
  accepted: boolean;
  nextEventSequence: number;
  bufferedEvents: Map<number, { event: JupyterKernelEvent; byteLength: number }>;
  bufferedEventBytes: number;
  inputRequestSequence?: number | undefined;
  deferredResult?: JupyterExecutionResult | undefined;
  expectedEventCount?: number | undefined;
}

interface RemoteExecutionEventRecord {
  sequence: number;
  payload: Uint8Array<ArrayBufferLike>;
}

interface ExecutionOwner {
  peerId: string;
  notebookKey: string;
  requestDigest?: string | undefined;
  accepted: boolean;
  cellId?: string | undefined;
  outputState?: JupyterRenderState | undefined;
  startedAt?: number | undefined;
  events?: RemoteExecutionEventRecord[] | undefined;
  eventBytes?: number | undefined;
  eventOverflow?: Error | undefined;
  replayTimer?: NodeJS.Timeout | undefined;
  inputRequestSequences?: Set<number> | undefined;
  inputReplyDigests?: Map<number, string> | undefined;
}

interface CompletedRemoteExecution {
  sourceId: string;
  requestDigest: string;
  resultPayload: Uint8Array<ArrayBufferLike>;
  events: RemoteExecutionEventRecord[];
  retainedBytes: number;
  inputReplyDigests: Map<number, string>;
  expiryTimer: NodeJS.Timeout;
  retryTimer: NodeJS.Timeout | undefined;
}

interface CompletedExecutionReceipt {
  executorId: string;
  timer: NodeJS.Timeout;
}

interface LightweightExecutionRequest {
  notebookKey: string;
  cellId: string;
  executorId: string;
  computeEpoch: number;
  cellRevision: string;
  cellDigest: string;
}

class CellStateUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CellStateUnavailableError';
  }
}

class StaleCellRevisionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'StaleCellRevisionError';
  }
}

interface ExecutionManifest {
  documents: Record<string, string>;
  binaries: Record<string, BinaryFileVersion>;
  directories: string[];
}

interface PendingBarrierReply {
  executorId: string;
  resolve: (meta: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface BarrierAuthorization {
  sourceId: string;
  notebookKey: string;
  target: NotebookComputeTarget;
  manifestDigest: string;
  timer: NodeJS.Timeout;
}

interface PendingBinaryAck {
  peerId: string;
  relativePath: string;
  expected: BinaryFileVersion;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingKernelCommand {
  executorId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingHostTransfer {
  peerId: string;
  expectedClock: HostClock;
  resolve: (clock: HostClock) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PreparedHostTransfer {
  sourceId: string;
  nextClock: HostClock;
  timer: NodeJS.Timeout;
}

interface PendingSessionEndFence {
  id: string;
  waitingFor: Set<string>;
  resolve: () => void;
  timer: NodeJS.Timeout;
}

interface PendingSnapshotCheckpoint {
  peerId: string;
  snapshotId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface SnapshotSource {
  relativePath: string;
  size: number;
  hash: string;
  bytes?: Uint8Array;
  absolutePath?: string;
}

/**
 * Metadata for a snapshot file transfer already announced to a joining peer.
 * A lossy relay route can silently drop chunk frames while their end frame
 * still arrives, so the receiver asks for exactly the missing indices and the
 * host re-reads them from this record instead of restarting the snapshot.
 */
interface SentSnapshotTransfer {
  peerId: string;
  snapshotId: string;
  relativePath: string;
  size: number;
  chunkSize: number;
  chunks: number;
  bytes?: Uint8Array;
  absolutePath?: string;
}

export interface SessionSnapshot {
  descriptor: SessionDescriptor;
  clock: HostClock;
  peers: PeerRuntime[];
  awareness: PresenceState[];
  metrics: MeshMetrics;
  startedAt: number;
  lastFlushAt: number;
  pendingDisk: number;
  kernelStatus: 'Idle' | 'Busy' | 'Offline';
  computeExecutorId: string;
  computeDevice: NotebookComputeTarget['device'];
  computeEpoch: number;
  closed: boolean;
  runtimeState: RuntimeState;
  runtimeDetail: string;
  isHost: boolean;
  waitingForHostFolder: boolean;
  autosave: AutosaveStatus;
  /** Per-participant connection view for the sidebar connection section. */
  connections: PeerConnectionView[];
  /** Signalling families with a live room right now (e.g. nostr, mqtt). */
  signallingFamilies: string[];
}

export interface PeerConnectionView {
  peerId: string;
  displayName: string;
  routeType: 'direct' | 'relay';
  latencyMs: number;
  upgradeStatus?: RouteUpgradeStatus;
  /** Rate-limited migration notice advertised by the remote participant. */
  remoteStatus?: string;
}

export type RuntimeState = 'connecting' | 'connected' | 'syncing' | 'ready' | 'executing'
  | 'waiting-for-stdin' | 'reconnecting' | 'host-unavailable' | 'executor-unavailable'
  | 'waiting-for-host-folder' | 'kernel-starting' | 'kernel-failed' | 'file-synchronization-failed';

export type BackingFolderMode = 'replace' | 'reuse-existing';
export type BackingFolderInspection = MaterializedFolderInspection;

export class BackingFolderMismatchError extends Error {
  public constructor(public readonly inspection: BackingFolderInspection) {
    super('The selected existing folder no longer matches the authoritative session state.');
    this.name = 'BackingFolderMismatchError';
  }
}

interface PendingInputReply {
  executorId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class SessionRuntime extends EventEmitter implements vscode.Disposable {
  public readonly project = new CollaborativeProject();
  public readonly awareness = new Awareness(new Y.Doc());
  public readonly notebookCellIds = new StableCellIdRegistry<vscode.NotebookCell>();
  public readonly coordinator: SessionCoordinator;
  public readonly startedAt = Date.now();
  private transport: MeshTransport;
  private lifecycleDiagnosticsRing: LifecycleDiagnosticRing | undefined;
  private latestLifecycleCorrelationByPeer = new Map<string, DiagnosticCorrelationId>();
  private executionDiagnosticCorrelations = new Map<string, DiagnosticCorrelationId>();

  private getLifecycleDiagnosticsRing(): LifecycleDiagnosticRing {
    if (!this.lifecycleDiagnosticsRing) {
      this.lifecycleDiagnosticsRing = new LifecycleDiagnosticRing(
        this.descriptor?.sessionId ?? 'uninitialized-session',
        this.descriptor?.localPeer?.peerId ?? 'unknown-peer',
      );
    }
    return this.lifecycleDiagnosticsRing;
  }

  private getExecutionDiagnosticCorrelations(): Map<string, DiagnosticCorrelationId> {
    return this.executionDiagnosticCorrelations ??= new Map<string, DiagnosticCorrelationId>();
  }

  private getLatestLifecycleCorrelationByPeer(): Map<string, DiagnosticCorrelationId> {
    return this.latestLifecycleCorrelationByPeer ??= new Map<string, DiagnosticCorrelationId>();
  }

  /** Sanitized networking + bounded lifecycle diagnostics for the diagnostics command. */
  public networkDiagnostics(): Record<string, unknown> {
    return { ...this.transport.networkDiagnostics(), lifecycleEvents: this.getLifecycleDiagnosticsRing().snapshot() };
  }

  public lifecycleDiagnostics(): LifecycleDiagnosticEvent[] {
    return this.getLifecycleDiagnosticsRing().snapshot();
  }

  public newLifecycleCorrelationId(): DiagnosticCorrelationId {
    return this.getLifecycleDiagnosticsRing().newCorrelationId();
  }

  public recordLifecycleDiagnostic(
    eventType: LifecycleDiagnosticEventType,
    options: RecordLifecycleDiagnosticOptions,
  ): void {
    this.getLifecycleDiagnosticsRing().record(eventType, options);
  }

  private storage: StorageAdapter | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private timers: NodeJS.Timeout[] = [];
  private readonly sessionDisposables: vscode.Disposable[] = [];
  private readonly binaryTransfers = new Map<string, PendingBinary>();
  private readonly binaryVersions = new Map<string, BinaryFileVersion>();
  private readonly directories = new Set<string>();
  private readonly fileStates = new Map<string, FileLifecycleState>();
  private fileRevisionCounter = 0;
  private readonly binaryAcknowledgements = new Map<string, Map<string, BinaryFileVersion>>();
  private readonly pendingBinaryAcks = new Map<string, PendingBinaryAck>();
  private readonly binarySyncs = new Map<string, Promise<void>>();
  private readonly pendingBarrierReplies = new Map<string, PendingBarrierReply>();
  private readonly pendingBarrierAuthorizations = new Map<string, BarrierAuthorization>();
  private readonly completedExecutionBarriers = new Map<string, BarrierAuthorization>();
  private readonly pendingKernelCommands = new Map<string, PendingKernelCommand>();
  private readonly pendingInputReplies = new Map<string, PendingInputReply>();
  private readonly pendingExecutions = new Map<string, PendingExecution>();
  private readonly completedRemoteExecutions = new Map<string, CompletedRemoteExecution>();
  private completedRemoteExecutionBytes = 0;
  private readonly completedExecutionReceipts = new Map<string, CompletedExecutionReceipt>();
  private targetCellConvergenceTimeoutMs = TARGET_CELL_CONVERGENCE_TIMEOUT_MS;
  private readonly pendingTransfers = new Map<string, PendingHostTransfer>();
  private readonly pendingSnapshotCheckpoints = new Map<string, PendingSnapshotCheckpoint>();
  private readonly sentSnapshotTransfers = new Map<string, SentSnapshotTransfer>();
  private readonly activeSnapshotGenerations = new Map<string, string>();
  private readonly preparedHostTransfers = new Map<string, PreparedHostTransfer>();
  private readonly awarenessOwnerByClientId = new Map<number, string>();
  private readonly awarenessClientsByPeer = new Map<string, Set<number>>();
  private pendingSessionEndFence: PendingSessionEndFence | undefined;
  private readonly suppressedDeletes = new Map<string, number>();
  /** Last accepted rename per logical source path, used to resolve rename/rename conflicts. */
  private readonly renameOrigins = new Map<string, RenameOrigin>();

  private readonly kernels = new Map<string, JupyterKernel>();
  private readonly kernelLastUsed = new Map<string, number>();
  private readonly executionOwners = new Map<string, ExecutionOwner>();
  private hardware: HardwareInfo | undefined;
  private environments: PythonEnvironment[] = [];
  private resources: ResourceSample | undefined;
  private cpuUsage: CpuSnapshot | undefined;
  private resourceSampleInFlight = false;
  private lastResourcePublishedAt = 0;
  private semanticPresencePublished = false;
  private lastPublishedActiveFile: string | undefined;
  private lastPublishedActiveNotebookCellId: string | undefined;
  private lastPublishedActiveLine: number | undefined;
  private lastPublishedActiveLineAnchor: string | undefined;
  private lastPublishedShareCursor = true;
  private lastPublishedCursorColor = '#4FC3F7';
  private lastPublishedDisplayName = '';
  private readonly remoteRuntimePresence = new Map<string, RuntimePresenceMetadata>();
  private meshMetrics: MeshMetrics = {
    bytesSentPerSecond: 0,
    bytesReceivedPerSecond: 0,
    totalBytesSent: 0,
    totalBytesReceived: 0,
    directPeers: 0,
  };
  private kernelStatus: 'Idle' | 'Busy' | 'Offline' = 'Offline';
  private readonly kernelStatuses = new Map<string, 'Idle' | 'Busy' | 'Offline'>();
  private readonly notebookActiveExecutions = new Map<string, number>();
  private activeExecutions = 0;
  private computeEpoch = 0;
  private closed = false;
  private closeReason: SessionCloseReason = 'explicit-leave';
  private terminalLifecycleEvent: SessionTerminalLifecycle | undefined;
  private terminalEventEmitted = false;
  private terminalResolve!: (event: SessionTerminalLifecycle) => void;
  private readonly terminalSignal = new Promise<SessionTerminalLifecycle>((resolve) => {
    this.terminalResolve = resolve;
  });
  private endingSession = false;
  private terminationCheckInFlight = false;
  private lastDisplayNameWarning = '';
  /** When the mesh last became "every known peer online" (0 while incomplete). */
  private fullPresenceSince = 0;
  private stateReadyResolve!: () => void;
  private readonly stateReady = new Promise<void>((resolve) => { this.stateReadyResolve = resolve; });
  private initialized = false;
  private initialStateReceived = false;
  private recoveringHost: boolean;
  private waitingForHostFolder = false;
  private messageQueue: Promise<void> = Promise.resolve();
  private backgroundMessageQueue: Promise<void> = Promise.resolve();
  private pendingIncomingMessages = 0;
  private pendingIncomingBytes = 0;
  private pendingSnapshotRequests = 0;
  private readonly kernelCommandWindows = new Map<string, { startedAt: number; count: number }>();
  private runtimeState: RuntimeState = 'connecting';
  private runtimeDetail = 'Session runtime is starting.';
  private workingCopyWriter: ((relativePath: string, bytes: Uint8Array) => Promise<boolean>) | undefined;
  private prepareWorkingCopy: (() => Promise<void>) | undefined;
  private deferWorkingCopyWrites = true;
  private workingCopyFallbackTimer: NodeJS.Timeout | undefined;
  private descriptorWriteQueue: Promise<void> = Promise.resolve();
  private autosave: LocalAutosaveManager | undefined;
  private autosaveState: AutosaveStatus = {
    enabled: false,
    folder: defaultAutosaveRoot(),
    intervalMs: AUTOSAVE_INTERVAL_MS,
    retention: AUTOSAVE_RETENTION,
    copies: 0,
    lastAt: 0,
    nextAt: 0,
  };
  private readonly internalWorkingWrites = new Map<string, Array<{ hash: string; expiresAt: number }>>();
  private readonly assignedJoinOrders = new Map<string, number>();

  public constructor(
    public readonly descriptor: SessionDescriptor,
    private readonly token: string,
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
    identityPrivateKey?: string,
  ) {
    super();
    this.lifecycleDiagnosticsRing = new LifecycleDiagnosticRing(descriptor.sessionId, descriptor.localPeer.peerId);
    descriptor.knownPeers = normalizeKnownPeers(descriptor.knownPeers, descriptor.localPeer.peerId);
    this.assignedJoinOrders.set(descriptor.localPeer.peerId, descriptor.localPeer.joinOrder);
    for (const peer of descriptor.knownPeers) this.assignedJoinOrders.set(peer.peerId, peer.joinOrder);
    descriptor.backingFolder = safeLocalFolder(descriptor.backingFolder);
    if (descriptor.backingFolder && pathsOverlap(descriptor.backingFolder, descriptor.workingFolder)) {
      descriptor.backingFolder = '';
    }
    this.recoveringHost = descriptor.role === 'host' && descriptor.freshStart === false;
    this.waitingForHostFolder = descriptor.role === 'host' && !descriptor.backingFolder;
    const restoredFileStates = isPlainRecord(descriptor.fileStates) ? Object.entries(descriptor.fileStates) : [];
    if (restoredFileStates.length > MAX_TRACKED_PROJECT_ENTRIES) {
      throw new Error(`Session marker exceeds the ${MAX_TRACKED_PROJECT_ENTRIES}-entry project limit.`);
    }
    for (const [rawKey, rawState] of restoredFileStates) {
      const key = normalizedTrackedPath(rawKey);
      const state = normalizeFileState(rawState, descriptor.localPeer.peerId);
      if (!key || !state) continue;
      this.setFileState(key, state);
      this.fileRevisionCounter = Math.max(this.fileRevisionCounter, state.version);
    }
    if (isSafeRevision(descriptor.fileRevisionCounter)) {
      this.fileRevisionCounter = Math.max(this.fileRevisionCounter, descriptor.fileRevisionCounter);
    }
    const restoredPaths = new Set(this.fileStates.keys());
    const restoredBinaryVersions = isPlainRecord(descriptor.binaryVersions) ? Object.entries(descriptor.binaryVersions) : [];
    if (restoredBinaryVersions.length > MAX_TRACKED_PROJECT_ENTRIES) {
      throw new Error(`Session marker exceeds the ${MAX_TRACKED_PROJECT_ENTRIES}-entry project limit.`);
    }
    for (const [rawKey, version] of restoredBinaryVersions) {
      const key = normalizedTrackedPath(rawKey);
      const normalized = normalizeBinaryVersion(version, descriptor.localPeer.peerId);
      if (!key || !normalized) continue;
      if (!restoredPaths.has(key) && restoredPaths.size >= MAX_TRACKED_PROJECT_ENTRIES) {
        throw new Error(`Session marker exceeds the ${MAX_TRACKED_PROJECT_ENTRIES}-entry project limit.`);
      }
      restoredPaths.add(key);
      this.binaryVersions.set(key, normalized);
    }
    assertPortablePathUniqueness([...this.fileStates.keys(), ...this.binaryVersions.keys()]);
    descriptor.computeExecutorId = descriptor.hostPeerId;
    if (isPlainRecord(descriptor.notebookCompute)) {
      const computeEntries = Object.entries(descriptor.notebookCompute);
      if (computeEntries.length > MAX_TRACKED_PROJECT_ENTRIES) {
        throw new Error(`Session marker exceeds the ${MAX_TRACKED_PROJECT_ENTRIES}-entry compute-target limit.`);
      }
      const targets: Record<string, NotebookComputeTarget> = {};
      const portableKeys = new Set<string>();
      for (const [rawKey, rawTarget] of computeEntries) {
        const key = rawKey === '*' ? '*' : normalizedTrackedPath(rawKey);
        const target = normalizeComputeTarget(rawTarget, descriptor.computeExecutorId);
        const portableKey = key === '*' ? '*' : key ? portablePathComparisonKey(key) : undefined;
        if (key && target && portableKey && !portableKeys.has(portableKey)) {
          portableKeys.add(portableKey);
          targets[key] = {
            ...target,
            executorId: descriptor.hostPeerId,
            author: descriptor.hostPeerId,
          };
        }
      }
      descriptor.notebookCompute = targets;
    } else {
      descriptor.notebookCompute = {};
    }
    if (!descriptor.notebookCompute['*']) {
      descriptor.notebookCompute['*'] = {
        executorId: descriptor.hostPeerId,
        device: 'cpu',
        epoch: 0,
        author: descriptor.hostPeerId,
      };
    }
    descriptor.notebookPythonPaths = normalizeNotebookPythonPaths(descriptor.notebookPythonPaths);
    descriptor.pythonPath = safeExecutableName(descriptor.pythonPath) ?? 'python';
    this.computeEpoch = Math.max(
      0,
      ...Object.values(descriptor.notebookCompute ?? {}).map((target) => target.epoch ?? 0),
    );
    const initialClock: HostClock = {
      sessionEpoch: descriptor.sessionEpoch,
      hostEpoch: descriptor.hostEpoch,
      hostId: descriptor.hostPeerId,
    };
    this.coordinator = new SessionCoordinator({ selfId: descriptor.localPeer.peerId, mode: descriptor.mode, clock: initialClock });
    this.transport = new MeshTransport({
      sessionId: descriptor.sessionId,
      token,
      localPeer: descriptor.localPeer,
      hostClock: () => this.coordinator.clock,
      isHost: () => !this.recoveringHost && this.coordinator.isCurrentHost(),
      hostReady: () => !this.waitingForHostFolder,
      identityPrivateKey,
    });
    this.transport.updateDirectory(descriptor.knownPeers ?? []);
  }

  public async start(): Promise<void> {
    if (this.initialized) return;
    await this.normalizeRestoredBackingFolder();
    const existingTermination = await readSessionTermination(this.descriptor, this.token);
    if (existingTermination) throw new SessionTerminatedError(existingTermination);
    this.initialized = true;
    this.transition('connecting', 'Opening peer transport.');
    const hasRecoveryPeers = this.recoveringHost && Boolean(this.descriptor.knownPeers?.length);
    if (this.descriptor.role === 'host' && !hasRecoveryPeers) {
      await loadCrdtProject(this.descriptor.workingFolder, this.project);
    }
    await this.indexBinaryFiles();
    await this.createStorage();
    await this.sweepTransferDirectory();
    this.installProjectHandlers();
    this.installTransportHandlers();
    this.installAwarenessHandlers();
    try {
      await this.transport.start();
    } catch (error) {
      // This is the exact local-route-failed boundary: our own MeshTransport
      // never reached readiness. A later loss of an established pinned host is
      // a different condition and remains host-unreachable.
      try {
        await this.disposeAsync('local-route-failed');
      } catch (cleanupError) {
        this.log.appendLine(`[error] Local-route startup cleanup failed: ${formatError(cleanupError)}`);
      }
      throw error;
    }
    this.transition('connected', 'Joined the encrypted Trystero room; discovering peers.');
    this.coordinator.upsertPeer(this.asRuntime(this.descriptor.localPeer, true));
    if (this.recoveringHost) {
      for (const peer of this.descriptor.knownPeers ?? []) this.transport.connect(peer);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const terminationAfterRecoveryWait = await readSessionTermination(this.descriptor, this.token);
      if (terminationAfterRecoveryWait) throw new SessionTerminatedError(terminationAfterRecoveryWait);
      if (!this.project.keys().length) {
        this.log.appendLine('[state:syncing] No live peer state arrived; recovering project state from the local working copy.');
        await loadCrdtProject(this.descriptor.workingFolder, this.project);
      }
      this.recoveringHost = false;
    }
    for (const key of this.project.keys()) this.storage?.schedule(key);
    if (this.descriptor.role === 'host') {
      this.stateReadyResolve();
    } else {
      this.transition('syncing', 'Waiting for initial project state from the host.');
      const host = resolveHostIdentity(this.descriptor, this.descriptor.hostPeerId);
      this.coordinator.upsertPeer(this.asRuntime(host, true));
      this.transport.connect(host);
      await withTimeout(this.stateReady, 45_000, 'Host did not provide project state within 45 seconds.');
    }
    this.installFileWatcher();
    this.installPresenceTracking();
    this.timers.push(
      setInterval(() => this.runBackground('Coordination tick', () => this.coordinationTick()), 250),
      setInterval(() => this.runBackground('Resource sampling', () => this.resourceTick()), RESOURCE_SAMPLE_INTERVAL_MS),
      setInterval(() => this.runBackground('Hardware refresh', () => this.refreshHardware()), HARDWARE_REFRESH_INTERVAL_MS),
      // Deleted notebook cells must not keep their (potentially large) output
      // payloads inside the Y.Doc forever.  The guard installed in
      // `installProjectHandlers` blocks collection while a participant is
      // absent, so a returning peer never loses a cell it kept editing.
      setInterval(() => this.runBackground('Notebook garbage collection', () => {
        this.project.collectAllGarbage(CELL_GC_GRACE_MS);
      }), 60_000),
    );

    await this.refreshHardware();
    this.descriptor.freshStart = false;
    await this.persistDescriptor();
    await this.refreshAutosaveManager();
    this.updatePresence();
    await vscode.commands.executeCommand('setContext', 'pairNotebook.inSession', true);
    await vscode.commands.executeCommand('setContext', 'pairNotebook.executionAvailable', true);
    this.emit('ready');
    if (this.waitingForHostFolder) {
      this.transition('waiting-for-host-folder', 'You are the new host. The session is paused until you choose a folder on this computer.');
    } else {
      this.transition('ready', 'Notebook and project state are synchronized.');
    }
    this.armWorkingCopyFallback();
    this.timers.push(setInterval(() => this.runBackground(
      'Session termination check',
      () => this.checkTerminationMarker(),
    ), 2_000));
  }

  public terminalLifecycle(): SessionTerminalLifecycle | undefined {
    return this.terminalLifecycleEvent ? { ...this.terminalLifecycleEvent } : undefined;
  }

  public snapshot(): SessionSnapshot {
    const states: PresenceState[] = [];
    for (const value of this.awareness.getStates().values()) {
      const state = normalizeStoredPresence(value);
      if (!state) continue;
      const runtimePresence = this.remoteRuntimePresence.get(state.peer.peerId);
      if (!runtimePresence) {
        states.push(state);
        continue;
      }
      states.push({
        ...state,
        ...(runtimePresence.hardware !== undefined ? { hardware: runtimePresence.hardware } : {}),
        ...(runtimePresence.environments !== undefined ? { environments: runtimePresence.environments } : {}),
        ...(runtimePresence.resources !== undefined ? { resources: runtimePresence.resources } : {}),
        ...(runtimePresence.kernelStatus !== undefined ? { kernelStatus: runtimePresence.kernelStatus } : {}),
        ...(runtimePresence.kernelStatuses !== undefined ? { kernelStatuses: runtimePresence.kernelStatuses } : {}),
      });
    }
    const activeNotebookKey = vscode.window.activeNotebookEditor
      ? this.relativeKey(vscode.window.activeNotebookEditor.notebook.uri)
      : undefined;
    const activeCompute = this.computeForNotebook(activeNotebookKey ?? '*');
    const executorState = states.find((state) => state.peer.peerId === activeCompute.executorId);
    const advertisedKernel = activeNotebookKey
      ? executorState?.kernelStatuses?.[activeNotebookKey] ?? executorState?.kernelStatus
      : executorState?.kernelStatus;
    return {
      descriptor: this.descriptor,
      clock: this.coordinator.clock,
      peers: this.transport.peerRuntime(),
      awareness: states,
      metrics: this.meshMetrics,
      startedAt: this.startedAt,
      lastFlushAt: this.storage?.lastFlushAt ?? 0,
      pendingDisk: this.storage?.pendingCount() ?? 0,
      kernelStatus: activeCompute.executorId === this.descriptor.localPeer.peerId
        ? (activeNotebookKey ? this.kernelStatuses.get(activeNotebookKey) ?? this.kernelStatus : this.kernelStatus)
        : advertisedKernel ?? 'Offline',
      computeExecutorId: activeCompute.executorId,
      computeDevice: activeCompute.device,
      computeEpoch: activeCompute.epoch ?? this.computeEpoch,
      closed: this.closed,
      runtimeState: this.runtimeState,
      runtimeDetail: this.runtimeDetail,
      isHost: this.coordinator.isCurrentHost(),
      waitingForHostFolder: this.waitingForHostFolder,
      autosave: { ...this.autosaveState },
      connections: this.buildConnectionViews(),
      signallingFamilies: this.transport.activeSignallingFamilies(),
    };
  }

  /** Builds the per-participant connection view shown in the sidebar. */
  private buildConnectionViews(): PeerConnectionView[] {
    const upgrades = new Map(
      this.transport.activeRouteUpgrades().map((upgrade) => [upgrade.peerId, upgrade.status] as const),
    );
    const selfId = this.descriptor.localPeer.peerId;
    return this.transport.peerRuntime()
      .filter((peer) => peer.peerId !== selfId)
      .map((peer) => {
        const upgradeStatus = upgrades.get(peer.peerId);
        const remoteStatus = this.transport.getRemoteRouteStatus(peer.peerId);
        return {
          peerId: peer.peerId,
          displayName: peer.displayName,
          routeType: peer.route === 'Relay' ? 'relay' as const : 'direct' as const,
          latencyMs: peer.connectionState === 'recovering'
            ? -1
            : peer.latencyEma >= 0 ? Math.round(peer.latencyEma) : -1,
          ...(upgradeStatus !== undefined ? { upgradeStatus } : {}),
          ...(remoteStatus !== undefined ? { remoteStatus } : {}),
        };
      });
  }

  /**
   * Runs the safe make-before-break improvement attempt for every participant
   * currently reachable only through the emergency relay. Participants on a
   * direct route are already optimal and are never touched. The current
   * connection is never disconnected by this call.
   */
  public tryImproveConnection(): { attempted: number; alreadyOptimal: boolean } {
    const targets = this.transport.improvablePeerIds();
    if (targets.length === 0) return { attempted: 0, alreadyOptimal: true };
    let attempted = 0;
    for (const peerId of targets) {
      if (this.transport.tryImproveRoute(peerId)) attempted += 1;
    }
    return { attempted, alreadyOptimal: false };
  }

  public cancelConnectionImprovement(): void {
    for (const upgrade of this.transport.activeRouteUpgrades()) {
      this.transport.cancelRouteUpgrade(upgrade.peerId);
    }
  }

  public localComputePresence(): PresenceState | undefined {
    const stored = [...this.awareness.getStates().values()]
      .map(normalizeStoredPresence)
      .find((value) => value?.peer.peerId === this.descriptor.localPeer.peerId);
    const local: PresenceState = stored ?? {
      peer: this.descriptor.localPeer,
      shareCursor: this.lastPublishedShareCursor,
      cursorColor: this.lastPublishedCursorColor,
      kernelStatus: this.kernelStatus,
    };
    return {
      ...local,
      hardware: this.coordinator.isCurrentHost() ? this.hardware : undefined,
      environments: this.coordinator.isCurrentHost() ? this.environments : [],
      resources: this.coordinator.isCurrentHost() ? this.resources : undefined,
      kernelStatus: this.coordinator.isCurrentHost() ? this.kernelStatus : local.kernelStatus,
      kernelStatuses: this.coordinator.isCurrentHost() ? Object.fromEntries(this.kernelStatuses) : local.kernelStatuses,
    };
  }

  public computeForNotebook(notebookKey: string): NotebookComputeTarget {
    return this.descriptor.notebookCompute?.[notebookKey] ?? this.descriptor.notebookCompute?.['*'] ?? {
      executorId: this.descriptor.computeExecutorId,
      device: 'cpu',
      epoch: 0,
      author: this.descriptor.computeExecutorId,
    };
  }

  public async flush(): Promise<void> {
    await this.storage?.flush();
  }

  /** Only the current host may publish an explicit save to the shared backing folder. */
  public async saveAsHost(): Promise<void> {
    if (!this.coordinator.isCurrentHost()) {
      throw new Error('Only the current Session Host can save the shared project. Your edits are already sent to the host.');
    }
    if (this.waitingForHostFolder) {
      throw new Error('Choose a new host folder before saving the shared project.');
    }
    await this.prepareWorkingCopy?.();
    await this.flush();
  }

  /**
   * Open VS Code documents must be saved through the editor API.  Replacing an
   * open .ipynb behind VS Code's back creates the "content is newer" conflict.
   */
  public setWorkingCopyWriter(
    writer: (relativePath: string, bytes: Uint8Array) => Promise<boolean>,
    prepareWorkingCopy?: () => Promise<void>,
  ): void {
    if (this.workingCopyFallbackTimer) clearTimeout(this.workingCopyFallbackTimer);
    this.workingCopyFallbackTimer = undefined;
    this.deferWorkingCopyWrites = false;
    this.workingCopyWriter = writer;
    this.prepareWorkingCopy = prepareWorkingCopy;
    this.storage?.setWorkingCopyWriter((relativePath, bytes) => this.writeWorkingCopy(relativePath, bytes));
    for (const key of this.project.keys()) this.storage?.schedule(key);
  }

  public async reconnect(): Promise<SignallingRefreshResult> {
    const correlationId = this.getLifecycleDiagnosticsRing().newCorrelationId();
    const remotePeerId = this.descriptor.role === 'peer' ? this.coordinator.clock.hostId : undefined;
    this.getLifecycleDiagnosticsRing().record('reconnect-started', {
      correlationId, ...(remotePeerId ? { remotePeerId } : {}),
      connectionState: 'reconnecting', routeKind: 'signalling', reason: 'manual-reconnect',
    });
    try {
          const selfId = this.descriptor.localPeer.peerId;
          let reconnectHost: PeerIdentity | undefined;
          if (this.descriptor.role === 'peer') {
            const hostId = this.coordinator.clock.hostId;
            if (hostId !== this.descriptor.hostPeerId || hostId === selfId) {
              throw new Error('Reconnect refused because the pinned original host identity changed locally.');
            }
            reconnectHost = resolveHostIdentity(this.descriptor, hostId);
            if (validateIdentityPublicKey(reconnectHost.identityKey)) {
              throw new Error('Reconnect requires the authenticated public identity of the pinned original host.');
            }
            // A guest reconnect targets only the pinned logical host. Other remembered
            // participants cannot substitute for it and reconnect itself never elects.
            this.transport.connect(reconnectHost);
          } else {
            for (const peer of this.descriptor.knownPeers ?? []) {
              if (peer.peerId !== selfId) this.transport.connect(peer);
            }
          }
          const refreshed = await this.transport.refreshSignalling();
          if (reconnectHost) {
            await this.waitForTransportRoute(reconnectHost.peerId, LOGICAL_PEER_RECOVERY_MS);
          }
          this.log.appendLine(
            `[debug] Manual reconnect completed for ${this.getLifecycleDiagnosticsRing().snapshot().at(-1)?.sessionIdentifier ?? 'session-unknown'} with ${refreshed.status}: `
            + `${refreshed.nostr.verifiedEndpoints}/${refreshed.nostr.requestedSockets} Nostr and `
            + `${refreshed.mqtt.verifiedEndpoints}/${refreshed.mqtt.requestedSockets} MQTT endpoints verified; `
            + (reconnectHost ? `pinned host ${reconnectHost.peerId} authenticated route is available.` : 'authenticated data routes were retained.'),
          );
          this.emit('connectionUpdated', { kind: 'manual-reconnect', ...refreshed });
      this.getLifecycleDiagnosticsRing().record('reconnect-succeeded', {
        correlationId, ...(remotePeerId ? { remotePeerId } : {}),
        connectionState: 'connected', routeKind: 'signalling', reason: 'manual-reconnect-succeeded',
      });
      return refreshed;
    } catch (error) {
      this.getLifecycleDiagnosticsRing().record('reconnect-failed', {
        correlationId, ...(remotePeerId ? { remotePeerId } : {}),
        connectionState: 'disconnected', routeKind: 'signalling', reason: 'manual-reconnect-failed',
      });
      throw error;
    }
  }

  public async transferHost(targetPeerId: string): Promise<void> {
    if (!this.coordinator.isCurrentHost()) throw new Error('Only the current Session Host can transfer the host role.');
    if (this.endingSession) throw new Error('The session is already being ended.');
    const target = this.transport.peerRuntime().find((peer) => peer.peerId === targetPeerId && peer.online);
    if (!target) throw new Error('The selected participant is offline.');
    const next: HostClock = {
      ...this.coordinator.clock,
      hostEpoch: this.coordinator.clock.hostEpoch + 1,
      hostId: targetPeerId,
    };
    const transferId = newId();
    await this.waitForHostTransfer(
      transferId, targetPeerId, next, 5000,
      'The new host did not acknowledge the transfer preparation.',
      () => this.transport.sendTo(targetPeerId, 'hostTransferPrepare', { transferId, nextClock: next }),
    );
    await this.prepareWorkingCopy?.();
    await this.flush();
    const committed = await this.waitForHostTransfer(
      transferId, targetPeerId, next, 5000,
      'The new host did not commit the transfer.',
      () => this.transport.sendTo(targetPeerId, 'hostTransferCommit', { transferId, nextClock: next }),
    );

    // The target only prepares/acknowledges the new clock until this point.
    // Disable persistence on the old host before publishing/finalizing the new
    // host, so a failed prepare/commit never strands the old host without its
    // backing folder and there is no dual-writer window.
    this.storage?.setBackingRoot(undefined);
    this.coordinator.applyAnnouncement(committed, this.descriptor.localPeer.peerId);
    await this.onHostChanged();
    this.transport.broadcast('hostAnnouncement', { clock: committed });
    try {
      this.transport.sendTo(targetPeerId, 'hostTransferFinalize', { transferId, nextClock: committed });
    } catch (error) {
      this.log.appendLine(`[debug] Host transfer finalize direct-send failed after commit: ${formatError(error)}`);
    }
    this.emit('hostTransferred', committed);
  }

  public changeCompute(executorId: string, notebookKey?: string, device: NotebookComputeTarget['device'] = 'cpu', pythonPath?: string): void {
    if (!this.coordinator.isCurrentHost()) {
      throw new Error('Only the current Session Host can configure shared compute.');
    }
    if (executorId !== this.descriptor.localPeer.peerId || executorId !== this.coordinator.clock.hostId) {
      throw new Error('Shared code execution is always owned by the current Session Host.');
    }
    const state = this.localComputePresence();
    if (!state) throw new Error('The Session Host compute environment is not available.');
    const gpuMatch = /^gpu:(\d+)$/.exec(device);
    const environments = state.environments ?? [];
    if (gpuMatch) {
      const gpuIndex = Number(gpuMatch[1]);
      const hasCudaEnvironment = environments.length
        ? environments.some((environment) => environment.jupyterReady && environment.cudaAvailable)
        : state.hardware?.python.torchCudaAvailable === true;
      const advertised = hasCudaEnvironment
        && state.hardware?.gpus.some((gpu) => gpu.index === gpuIndex);
      if (!advertised) throw new Error(`GPU ${gpuIndex} is not available on the Session Host.`);
    }
    if (pythonPath) {
      const environment = environments.find((candidate) => candidate.executable === pythonPath);
      if (!environment || !environment.jupyterReady) {
        throw new Error('The selected Session Host Python environment cannot start a Jupyter kernel.');
      }
      if (gpuMatch && !environment.cudaAvailable) {
        throw new Error('The selected Session Host Python environment does not expose CUDA for this GPU target.');
      }
    }
    const key = notebookKey === undefined ? '*' : normalizedTrackedPath(notebookKey);
    if (!key || (key !== '*' && this.project.kindOf(key) !== 'notebook')) {
      throw new Error('The compute target must reference a collaborative notebook.');
    }
    const currentEpoch = this.computeForNotebook(key).epoch ?? 0;
    const nextEpoch = currentEpoch + 1;
    if (!isSafeRevision(nextEpoch)) throw new Error('Compute selection epoch reached its supported limit.');
    const target: NotebookComputeTarget = {
      executorId, device, pythonPath, epoch: nextEpoch, author: this.descriptor.localPeer.peerId,
    };
    this.applyComputeTarget(key, target);
    this.transport.broadcast('computeChanged', { notebookKey: key, target, executorId, computeEpoch: target.epoch });
    this.persistDescriptorInBackground();
  }

  private diagnosticRouteKind(peerId: string | undefined): DiagnosticRouteKind {
    if (!peerId) return 'none';
    const peerRuntime = (this.transport as MeshTransport & { peerRuntime?: () => PeerRuntime[] }).peerRuntime;
    if (typeof peerRuntime !== 'function') return 'unknown';
    const peer = peerRuntime.call(this.transport).find((candidate) => candidate.peerId === peerId);
    return peer?.route === 'Direct' ? 'direct' : peer?.route === 'Relay' ? 'relay' : 'unknown';
  }

  private recordExecutionDiagnostic(
    eventType: LifecycleDiagnosticEventType,
    requestId: string,
    remotePeerId: string | undefined,
    reason: DiagnosticReason,
    metadata?: LifecycleDiagnosticMetadata,
  ): void {
    const correlationId = this.getExecutionDiagnosticCorrelations().get(requestId);
    if (!correlationId) return;
    this.getLifecycleDiagnosticsRing().record(eventType, {
      correlationId,
      ...(remotePeerId ? { remotePeerId } : {}),
      connectionState: 'executing',
      routeKind: this.diagnosticRouteKind(remotePeerId),
      reason,
      metadata: { requestId, ...metadata },
    });
  }

  public async executeCell(
    notebookKey: string,
    cellId: string,
    code: string,
    onEvent: (event: JupyterKernelEvent) => void,
    onRequestId?: (requestId: string) => void,
  ): Promise<JupyterExecutionResult> {
    if (this.waitingForHostFolder) {
      throw new Error('The session is paused until the new host chooses a folder.');
    }
    const requestId = newId();
    onRequestId?.(requestId);
    const target = this.computeForNotebook(notebookKey);
    const executorId = target.executorId;
    const diagnosticCorrelationId = this.getLifecycleDiagnosticsRing().newCorrelationId();
    this.getExecutionDiagnosticCorrelations().set(requestId, diagnosticCorrelationId);
    if (executorId === this.descriptor.localPeer.peerId) {
      this.recordExecutionDiagnostic('execution-request-created', requestId, undefined, 'execution-request', {
        cellId, computeEpoch: target.epoch,
      });
      this.recordExecutionDiagnostic('execution-started', requestId, undefined, 'execution-started', {
        cellId, computeEpoch: target.epoch,
      });
      try {
        const result = await this.executeLocally(notebookKey, target, requestId, code, onEvent);
        this.recordExecutionDiagnostic('execution-completed', requestId, undefined, 'execution-completed', {
          cellId, computeEpoch: target.epoch, result: result.success ? 'success' : 'failure',
        });
        return result;
      } finally {
        this.getExecutionDiagnosticCorrelations().delete(requestId);
      }
    }
    if (executorId !== this.coordinator.clock.hostId) {
      throw new Error('Guest execution is pinned to the current Session Host.');
    }
    if (!PEER_ID_PATTERN.test(cellId) || !this.project.hasNotebookCell(notebookKey, cellId)) {
      throw new Error('The requested collaborative cell is not available in canonical CRDT state.');
    }
    const cellState = this.project.cellTextState(notebookKey, cellId);
    const cellDigest = canonicalCellTextDigest(cellState.source);
    const request: LightweightExecutionRequest = {
      notebookKey,
      cellId,
      executorId,
      computeEpoch: target.epoch,
      cellRevision: cellState.revision,
      cellDigest,
    };
    this.recordExecutionDiagnostic('execution-request-created', requestId, executorId, 'execution-request', {
      cellId, revision: cellState.revision, digest: cellDigest, computeEpoch: target.epoch,
    });
    this.transition('executing', `Requesting host execution for ${notebookKey} on ${executorId}.`);
    const remote = new Promise<JupyterExecutionResult>((resolve, reject) => {
      this.pendingExecutions.set(requestId, {
        resolve,
        reject,
        onEvent,
        executorId,
        notebookKey,
        timer: undefined,
        accepted: false,
        nextEventSequence: 0,
        bufferedEvents: new Map(),
        bufferedEventBytes: 0,
      });
      void this.dispatchRemoteExecutionRequest(
        executorId,
        {
          requestId,
          ...request,
          fastPath: true,
          diagnosticCorrelationId,
        },
        new Uint8Array(),
      ).catch((error) => {
        const pending = this.pendingExecutions.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingExecutions.delete(requestId);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    return remote.finally(() => {
      this.transition('ready', `Execution finished for ${notebookKey}.`);
      this.getExecutionDiagnosticCorrelations().delete(requestId);
    });
  }

  private async dispatchRemoteExecutionRequest(
    executorId: string,
    meta: Record<string, unknown>,
    payload: Uint8Array<ArrayBufferLike>,
  ): Promise<void> {
    const requestId = String(meta.requestId ?? '');
    const notebookKey = String(meta.notebookKey ?? '');
    await this.synchronizeExecutionFiles(executorId, requestId, notebookKey, this.computeForNotebook(notebookKey));
    const awaitingAcceptance = this.pendingExecutions.get(requestId);
    if (!awaitingAcceptance || this.closed) return;
    awaitingAcceptance.timer = setTimeout(() => {
      if (this.pendingExecutions.get(requestId) !== awaitingAcceptance) return;
      this.pendingExecutions.delete(requestId);
      awaitingAcceptance.reject(new Error(
        `Compute executor ${executorId} did not acknowledge the request after route recovery. `
        + 'Retry it after the connection is stable.',
      ));
    }, EXECUTION_ACCEPT_TIMEOUT_MS);
    const deadline = Date.now() + EXECUTION_ACCEPT_TIMEOUT_MS;
    let attempt = 0;
    while (!this.closed && Date.now() < deadline) {
      const pending = this.pendingExecutions.get(requestId);
      if (!pending || pending.accepted) return;
      const remaining = deadline - Date.now();
      try {
        await this.waitForTransportRoute(executorId, Math.min(5_000, Math.max(1, remaining)));
        const current = this.pendingExecutions.get(requestId);
        if (!current || current.accepted) return;
        this.transport.sendTo(executorId, 'executeRequest', meta, payload);
        attempt += 1;
        this.recordExecutionDiagnostic('execution-request-sent', requestId, executorId, 'execution-send', { attempt });
      } catch (error) {
        if (!isRouteUnavailableError(error)) throw error;
      }
      await this.waitForRetryDelay(Math.min(EXECUTION_REQUEST_RETRY_MS, Math.max(1, deadline - Date.now())));
    }
  }

  private markRemoteExecutionAccepted(requestId: string, executorId: string): void {
    const pending = this.pendingExecutions.get(requestId);
    if (!pending || pending.executorId !== executorId || pending.accepted) return;
    clearTimeout(pending.timer);
    pending.accepted = true;
    this.recordExecutionDiagnostic('execution-accepted', requestId, executorId, 'execution-accepted');
    pending.timer = setTimeout(() => {
      if (this.pendingExecutions.get(requestId) !== pending) return;
      this.pendingExecutions.delete(requestId);
      pending.reject(new Error('Remote compute timed out after four hours.'));
    }, REMOTE_EXECUTION_TIMEOUT_MS);
  }

  private acceptRemoteExecutionEvent(
    requestId: string,
    pending: PendingExecution,
    sequence: number,
    event: JupyterKernelEvent,
    byteLength: number,
  ): void {
    if (sequence < pending.nextEventSequence) return;
    if (sequence > pending.nextEventSequence) {
      if (pending.bufferedEvents.has(sequence)) return;
      if (pending.bufferedEvents.size >= MAX_REPLAYED_EXECUTION_EVENTS
        || pending.bufferedEventBytes + byteLength > MAX_REPLAYED_EXECUTION_EVENT_BYTES) {
        throw new Error('Remote Jupyter event replay exceeded its bounded receive queue.');
      }
      pending.bufferedEvents.set(sequence, { event, byteLength });
      pending.bufferedEventBytes += byteLength;
      return;
    }
    if (event.type === 'inputRequest') pending.inputRequestSequence = sequence;
    pending.onEvent(event);
    pending.nextEventSequence += 1;
    while (true) {
      const buffered = pending.bufferedEvents.get(pending.nextEventSequence);
      if (!buffered) break;
      pending.bufferedEvents.delete(pending.nextEventSequence);
      pending.bufferedEventBytes = Math.max(0, pending.bufferedEventBytes - buffered.byteLength);
      if (buffered.event.type === 'inputRequest') pending.inputRequestSequence = pending.nextEventSequence;
      pending.onEvent(buffered.event);
      pending.nextEventSequence += 1;
    }
    if (pending.deferredResult !== undefined
      && pending.expectedEventCount === pending.nextEventSequence) {
      this.resolvePendingRemoteExecution(
        requestId,
        pending,
        pending.executorId,
        pending.deferredResult,
      );
    }
  }

  private rejectPendingRemoteExecution(requestId: string, pending: PendingExecution, message: string): void {
    if (this.pendingExecutions.get(requestId) !== pending) return;
    clearTimeout(pending.timer);
    this.pendingExecutions.delete(requestId);
    pending.reject(new Error(message));
  }

  private resolvePendingRemoteExecution(
    requestId: string,
    pending: PendingExecution,
    executorId: string,
    result: JupyterExecutionResult,
  ): void {
    if (this.pendingExecutions.get(requestId) !== pending) return;
    clearTimeout(pending.timer);
    this.pendingExecutions.delete(requestId);
    this.rememberCompletedExecutionReceipt(requestId, executorId);
    this.acknowledgeExecutionResult(requestId, executorId);
    this.recordExecutionDiagnostic('execution-completed', requestId, executorId, 'execution-completed', {
      result: result.success ? 'success' : 'failure',
    });
    pending.resolve(result);
  }

  private terminalCancellation(): Promise<never> {
    return this.terminalSignal.then((event) => {
      throw new SessionClosedError(event);
    });
  }

  private sessionClosedError(): SessionClosedError {
    const event = this.terminalLifecycleEvent ?? {
      reason: this.closeReason,
      sessionId: this.descriptor.sessionId,
      peerId: this.descriptor.localPeer.peerId,
      hostId: this.coordinator.clock.hostId,
      at: Date.now(),
    };
    return new SessionClosedError(event);
  }

  private async waitForRetryDelay(ms: number): Promise<void> {
    if (this.closed) throw this.sessionClosedError();
    await Promise.race([runtimeDelay(ms), this.terminalCancellation()]);
    if (this.closed) throw this.sessionClosedError();
  }

  private async waitForTransportRoute(peerId: string, timeoutMs: number): Promise<void> {
    if (this.closed) throw this.sessionClosedError();
    const transport = this.transport as MeshTransport & {
      waitForRoute?: ((targetPeerId: string, waitMs?: number) => Promise<void>) | undefined;
    };
    if (typeof transport.waitForRoute === 'function') {
      await Promise.race([
        transport.waitForRoute(peerId, timeoutMs),
        this.terminalCancellation(),
      ]);
    }
    if (this.closed) throw this.sessionClosedError();
  }

  private async sendToWithRouteRecovery(
    peerId: string,
    type: string,
    meta: Record<string, unknown>,
    payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
    timeoutMs = EXECUTION_ACCEPT_TIMEOUT_MS,
  ): Promise<void> {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    let lastError: unknown;
    while (!this.closed && Date.now() < deadline) {
      try {
        await this.waitForTransportRoute(peerId, Math.min(5_000, Math.max(1, deadline - Date.now())));
        this.transport.sendTo(peerId, type, meta, payload);
        return;
      } catch (error) {
        if (!isRouteUnavailableError(error)) throw error;
        lastError = error;
        await this.waitForRetryDelay(Math.min(100, Math.max(1, deadline - Date.now())));
      }
    }
    throw new Error(`Could not deliver ${type} to ${peerId} after route recovery: ${formatError(lastError)}`);
  }

  public reportWaitingForInput(notebookKey: string): void {
    this.transition('waiting-for-stdin', `Kernel is waiting for input in ${notebookKey}.`);
  }

  public reportInputResolved(notebookKey: string): void {
    this.transition('executing', `Kernel input supplied for ${notebookKey}.`);
  }

  public async replyToInput(requestId: string, value: string): Promise<void> {
    if (value.length > MAX_REMOTE_INPUT_CHARACTERS) {
      throw new Error(`Jupyter input exceeds the ${MAX_REMOTE_INPUT_CHARACTERS}-character limit.`);
    }
    const pending = this.pendingExecutions.get(requestId);
    if (pending && pending.executorId !== this.descriptor.localPeer.peerId) {
      if (pending.inputRequestSequence === undefined) {
        // A 0.5.3 peer has no event sequence or input acknowledgement.
        await this.sendToWithRouteRecovery(
          pending.executorId,
          'inputReply',
          { requestId, notebookKey: pending.notebookKey, value },
        );
      } else {
        await this.sendRemoteInputReply(
          pending.executorId,
          requestId,
          pending.notebookKey,
          pending.inputRequestSequence,
          value,
        );
      }
      return;
    }
    const owner = this.executionOwners.get(requestId);
    const key = owner?.notebookKey ?? pending?.notebookKey;
    if (key) this.kernels.get(key)?.inputReply(value);
  }

  private sendRemoteInputReply(
    executorId: string,
    requestId: string,
    notebookKey: string,
    eventSequence: number,
    value: string,
  ): Promise<void> {
    const key = inputReplyKey(requestId, eventSequence);
    if (this.pendingInputReplies.has(key)) {
      return Promise.reject(new Error('A reply for this Jupyter input prompt is already being delivered.'));
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingInputReplies.delete(key);
        reject(new Error('Jupyter input reply was not acknowledged after route recovery.'));
      }, EXECUTION_ACCEPT_TIMEOUT_MS);
      this.pendingInputReplies.set(key, { executorId, resolve, reject, timer });
      void this.dispatchRemoteInputReply(
        key,
        executorId,
        requestId,
        notebookKey,
        eventSequence,
        value,
      ).catch((error) => {
        const pending = this.pendingInputReplies.get(key);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingInputReplies.delete(key);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private async dispatchRemoteInputReply(
    key: string,
    executorId: string,
    requestId: string,
    notebookKey: string,
    eventSequence: number,
    value: string,
  ): Promise<void> {
    const deadline = Date.now() + EXECUTION_ACCEPT_TIMEOUT_MS;
    while (!this.closed && Date.now() < deadline && this.pendingInputReplies.has(key)) {
      try {
        await this.waitForTransportRoute(executorId, Math.min(5_000, Math.max(1, deadline - Date.now())));
        if (!this.pendingInputReplies.has(key)) return;
        this.transport.sendTo(executorId, 'inputReply', {
          requestId,
          notebookKey,
          eventSequence,
          value,
        });
      } catch (error) {
        if (!isRouteUnavailableError(error)) throw error;
      }
      await this.waitForRetryDelay(Math.min(EXECUTION_REQUEST_RETRY_MS, Math.max(1, deadline - Date.now())));
    }
  }

  public async cancelInput(requestId: string): Promise<void> {
    const pending = this.pendingExecutions.get(requestId);
    const owner = this.executionOwners.get(requestId);
    const notebookKey = pending?.notebookKey ?? owner?.notebookKey;
    if (!notebookKey) return;
    await this.interruptNotebook(notebookKey);
    this.transition('executing', `Input was cancelled; interrupt sent for ${notebookKey}.`);
  }

  public async interruptNotebook(notebookKey: string): Promise<void> {
    const target = this.computeForNotebook(notebookKey);
    if (target.executorId === this.descriptor.localPeer.peerId) {
      await this.kernels.get(notebookKey)?.interrupt();
    } else {
      await this.sendKernelCommand(target.executorId, notebookKey, target, 'interrupt');
    }
  }

  public async restartNotebook(notebookKey: string): Promise<void> {
    const target = this.computeForNotebook(notebookKey);
    if (target.executorId === this.descriptor.localPeer.peerId) {
      const kernel = this.kernels.get(notebookKey);
      if (kernel) await kernel.restart();
    } else {
      await this.sendKernelCommand(target.executorId, notebookKey, target, 'restart');
    }
  }

  public notebookKey(uri: vscode.Uri): string | undefined {
    return this.relativeKey(uri);
  }

  public notebookCellId(cell: vscode.NotebookCell): string | undefined {
    const key = this.relativeKey(cell.notebook.uri);
    if (!key) return undefined;
    const id = this.notebookCellIds.knownId(cell, metadataCellId(cell.metadata));
    // Membership is checked directly against the shared order/payload state:
    // this runs on every cursor move and status-bar refresh, where a full
    // notebookSnapshot would JSON-parse every cell's outputs for no benefit.
    return id && this.project.hasNotebookCell(key, id) ? id : undefined;
  }

  public resolvePresenceCursor(state: PresenceState): ResolvedCursorPosition | undefined {
    if (!state.cursor) return undefined;
    const text = state.activeFile
      ? this.presenceText(state.activeFile, state.activeNotebookCellId)
      : undefined;
    return resolveSharedCursorPosition(text, state.cursor);
  }

  /** Resolves a line anchor without exposing a character cursor to the UI. */
  public resolvePresenceLineOffset(state: PresenceState): number | undefined {
    if (!state.activeLineAnchor || !state.activeFile) return undefined;
    return resolveRelativeOffset(
      this.presenceText(state.activeFile, state.activeNotebookCellId),
      state.activeLineAnchor,
      undefined,
    );
  }

  /**
   * Rejects local edits that touch another participant's selected line. The
   * CRDT-relative anchor keeps that lock on the same logical line when a peer
   * inserts new lines above it. If two peers select the same line concurrently,
   * the stable join order breaks the tie instead of blocking both editors.
   */
  public lineLockMessage(
    key: string,
    cellId: string | undefined,
    changes: readonly { rangeOffset: number; rangeLength: number }[],
    canonicalSource: string,
  ): string | undefined {
    if (!changes.length) return undefined;
    const states = this.snapshot().awareness;
    const own = states.find((state) => state.peer.peerId === this.descriptor.localPeer.peerId);
    const ownStart = own ? this.presenceLineStart(own, canonicalSource) : undefined;
    for (const state of states) {
      if (state.peer.peerId === this.descriptor.localPeer.peerId
        || state.shareCursor === false
        || state.activeFile !== key
        || state.activeNotebookCellId !== cellId) continue;
      const lockedStart = this.presenceLineStart(state, canonicalSource);
      if (lockedStart === undefined) continue;
      // A simultaneous selection is resolved consistently on every peer.
      if (ownStart === lockedStart && comparePeerPriority(this.descriptor.localPeer, state.peer) < 0) continue;
      const lockedEnd = lineEndOffset(canonicalSource, lockedStart);
      if (changes.some((change) => changeTouchesLine(change, lockedStart, lockedEnd))) {
        return `Line is currently selected by ${state.peer.displayName}.`;
      }
    }
    return undefined;
  }

  public async refreshHardware(): Promise<void> {
    const configuration = vscode.workspace.getConfiguration('pairNotebook');
    const pythonPath = configuration.get<string>('pythonPath', this.descriptor.pythonPath || 'python');
    [this.hardware, this.environments] = await Promise.all([
      discoverHardware(pythonPath),
      discoverPythonEnvironments(this.descriptor.workingFolder, pythonPath),
    ]);
    this.publishHardwarePresence();
    this.emit('hardware', this.hardware);
  }

  public async sendSnapshot(
    peerId: string,
    completed: Record<string, string> = {},
    snapshotId = newId(),
  ): Promise<void> {
    if (!this.coordinator.isCurrentHost()) return;
    if (!TRANSFER_ID_PATTERN.test(snapshotId)) throw new Error('Joining peer sent a malformed snapshot generation id.');
    if (this.activeSnapshotGenerations.has(peerId)) {
      throw new Error('Joining peer requested a snapshot while another generation is still active.');
    }
    this.activeSnapshotGenerations.set(peerId, snapshotId);
    try {
    const snapshotClock = { ...this.coordinator.clock };
    const assertCurrentHost = () => {
      if (!this.coordinator.isCurrentHost() || !sameClock(this.coordinator.clock, snapshotClock)
        || this.activeSnapshotGenerations.get(peerId) !== snapshotId) {
        throw new Error('Session Host changed while the project snapshot was being prepared.');
      }
    };
    await this.flush();
    assertCurrentHost();
    const materialization = await this.collectMaterialization();
    const allFiles: SnapshotSource[] = [
      ...materialization.documents.map((document) => ({
        relativePath: document.relativePath,
        size: document.bytes.byteLength,
        hash: createHash('sha256').update(document.bytes).digest('hex'),
        bytes: document.bytes,
      })),
      ...materialization.binaries.map((binary) => ({
        relativePath: binary.relativePath,
        size: binary.size,
        hash: binary.hash,
        absolutePath: binary.sourcePath,
      })),
    ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const directories = materialization.directories;
    if (allFiles.length + directories.length > MAX_EXECUTION_MANIFEST_ENTRIES
      || allFiles.some((file) => file.size > MAX_TRANSFER_BYTES)
      || allFiles.reduce((total, file) => total + file.size, 0) > MAX_SNAPSHOT_PROJECT_BYTES) {
      throw new Error('Project snapshot exceeds the supported entry, file-size, or aggregate-size limit.');
    }
    assertCurrentHost();
    const files = allFiles.filter((file) => completed[file.relativePath] !== file.hash);
    const resumedFiles = allFiles
      .filter((file) => completed[file.relativePath] === file.hash)
      .map((file) => file.relativePath);
    this.transport.sendTo(peerId, 'snapshotBegin', {
      snapshotId,
      fileCount: files.length,
      totalFiles: allFiles.length,
      completedFiles: resumedFiles.length,
      projectName: this.descriptor.projectName,
      directoryCount: directories.length,
    });
    await this.sendSnapshotManifest(
      peerId,
      allFiles.map((file) => file.relativePath),
      directories,
      resumedFiles,
      snapshotId,
      assertCurrentHost,
    );

    let checkpointFrames = 0;
    let checkpointBytes = 0;
    const recordFrame = (payloadBytes = 0) => {
      checkpointFrames += 1;
      checkpointBytes += payloadBytes;
    };
    const checkpoint = async (force = false) => {
      if (!checkpointFrames && !force) return;
      if (!force && checkpointFrames < MAX_SNAPSHOT_CHECKPOINT_FRAMES
        && checkpointBytes < MAX_SNAPSHOT_CHECKPOINT_BYTES) return;
      assertCurrentHost();
      await this.awaitSnapshotCheckpoint(peerId, snapshotId);
      checkpointFrames = 0;
      checkpointBytes = 0;
    };

    // The receiver validates the complete manifest and creates every declared
    // directory before acknowledging this first application-level barrier.
    await checkpoint(true);
    for (const file of files) {
      assertCurrentHost();
      const transferId = newId();
      const chunkSize = BINARY_CHUNK_SIZE;
      const chunks = Math.max(1, Math.ceil(file.size / chunkSize));
      this.transport.sendTo(peerId, 'snapshotFileStart', {
        snapshotId,
        transferId,
        relativePath: file.relativePath,
        size: file.size,
        chunks,
        chunkSize,
        hash: file.hash,
      });
      recordFrame();
      this.rememberSentSnapshotTransfer(transferId, {
        peerId,
        snapshotId,
        relativePath: file.relativePath,
        size: file.size,
        chunkSize,
        chunks,
        ...(file.bytes ? { bytes: file.bytes } : {}),
        ...(file.absolutePath ? { absolutePath: file.absolutePath } : {}),
      });
      const sendChunk = (index: number, chunk: Uint8Array) => {
        assertCurrentHost();
        this.transport.sendTo(peerId, 'snapshotFileChunk', { snapshotId, transferId, index }, chunk);
        recordFrame(chunk.byteLength);
      };
      const drain = async () => {
        await this.transport.awaitDrain(peerId);
        await checkpoint();
      };
      if (file.bytes) {
        for (let index = 0; index < chunks; index += 1) {
          const offset = index * chunkSize;
          sendChunk(index, file.bytes.subarray(offset, Math.min(file.size, offset + chunkSize)));
          await drain();
        }
      } else if (file.absolutePath) {
        // Binary sources stay streaming, so a multi-gigabyte project never has
        // to fit into extension-host memory.
        await this.streamFileChunks(
          file.absolutePath,
          chunks,
          chunkSize,
          file.size,
          file.hash,
          sendChunk,
          drain,
        );
      } else {
        throw new Error(`Snapshot source is unavailable: ${file.relativePath}`);
      }
      assertCurrentHost();
      this.transport.sendTo(peerId, 'snapshotFileEnd', { snapshotId, transferId });
      recordFrame();
      await checkpoint();
    }
    if (checkpointFrames) await checkpoint(true);
    assertCurrentHost();
    this.transport.sendTo(peerId, 'snapshotEnd', { snapshotId });
    } finally {
      if (this.activeSnapshotGenerations.get(peerId) === snapshotId) {
        this.activeSnapshotGenerations.delete(peerId);
      }
    }
  }

  private async sendSnapshotManifest(
    peerId: string,
    expectedFiles: readonly string[],
    expectedDirectories: readonly string[],
    completedFiles: readonly string[],
    snapshotId: string,
    assertCurrentHost: () => void,
  ): Promise<void> {
    let files: string[] = [];
    let directories: string[] = [];
    let completed: string[] = [];
    let entries = 0;
    let bytes = 1024;
    let checkpointFrames = 0;
    let checkpointBytes = 0;
    const flush = async () => {
      if (!entries) return;
      assertCurrentHost();
      this.transport.sendTo(peerId, 'snapshotManifest', {
        snapshotId,
        expectedFiles: files,
        expectedDirectories: directories,
        completedFiles: completed,
      });
      await this.transport.awaitDrain(peerId);
      checkpointFrames += 1;
      checkpointBytes += bytes;
      files = [];
      directories = [];
      completed = [];
      entries = 0;
      bytes = 1024;
      if (checkpointFrames >= MAX_SNAPSHOT_CHECKPOINT_FRAMES
        || checkpointBytes >= MAX_SNAPSHOT_CHECKPOINT_BYTES) {
        await this.awaitSnapshotCheckpoint(peerId, snapshotId);
        checkpointFrames = 0;
        checkpointBytes = 0;
      }
    };
    const append = async (kind: 'file' | 'directory' | 'completed', relativePath: string) => {
      const entryBytes = Buffer.byteLength(JSON.stringify(relativePath), 'utf8') + 1;
      if (entries && bytes + entryBytes > MAX_STATE_CHUNK_METADATA_BYTES) await flush();
      if (entryBytes + 1024 > MAX_STATE_CHUNK_METADATA_BYTES) {
        throw new Error(`Snapshot manifest path is too large to send: ${relativePath}`);
      }
      if (kind === 'file') files.push(relativePath);
      else if (kind === 'directory') directories.push(relativePath);
      else completed.push(relativePath);
      entries += 1;
      bytes += entryBytes;
    };
    for (const relativePath of expectedFiles) await append('file', relativePath);
    for (const relativePath of expectedDirectories) await append('directory', relativePath);
    for (const relativePath of completedFiles) await append('completed', relativePath);
    await flush();
    assertCurrentHost();
    this.transport.sendTo(peerId, 'snapshotManifestEnd', { snapshotId });
  }

  private async awaitSnapshotCheckpoint(peerId: string, snapshotId: string): Promise<void> {
    const checkpointId = newId();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pendingSnapshotCheckpoints.get(checkpointId);
        if (!pending) return;
        this.pendingSnapshotCheckpoints.delete(checkpointId);
        pending.reject(new Error('Joining peer did not process the project snapshot in time.'));
      }, SNAPSHOT_CHECKPOINT_TIMEOUT_MS);
      this.pendingSnapshotCheckpoints.set(checkpointId, { peerId, snapshotId, resolve, reject, timer });
      try {
        this.transport.sendTo(peerId, 'snapshotCheckpoint', { snapshotId, checkpointId });
      } catch (error) {
        clearTimeout(timer);
        this.pendingSnapshotCheckpoints.delete(checkpointId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private acceptSnapshotCheckpoint(sourceId: string, snapshotId: string | undefined, checkpointId: string): void {
    if (!TRANSFER_ID_PATTERN.test(checkpointId)) {
      throw new Error('Joining peer sent a malformed snapshot checkpoint acknowledgement.');
    }
    const pending = this.pendingSnapshotCheckpoints.get(checkpointId);
    if (!pending || pending.peerId !== sourceId || (snapshotId && pending.snapshotId !== snapshotId)) return;
    clearTimeout(pending.timer);
    this.pendingSnapshotCheckpoints.delete(checkpointId);
    pending.resolve();
  }

  private rejectSnapshotCheckpoints(peerId: string, message: string, snapshotId?: string): void {
    for (const [checkpointId, pending] of [...this.pendingSnapshotCheckpoints]) {
      if (pending.peerId !== peerId || (snapshotId && pending.snapshotId !== snapshotId)) continue;
      clearTimeout(pending.timer);
      this.pendingSnapshotCheckpoints.delete(checkpointId);
      pending.reject(new Error(message));
    }
  }

  private cancelSnapshotGeneration(peerId: string, message: string): void {
    const snapshotId = this.activeSnapshotGenerations.get(peerId);
    if (!snapshotId) return;
    this.activeSnapshotGenerations.delete(peerId);
    this.rejectSnapshotCheckpoints(peerId, message, snapshotId);
    for (const [transferId, transfer] of [...this.sentSnapshotTransfers]) {
      if (transfer.peerId === peerId && transfer.snapshotId === snapshotId) {
        this.sentSnapshotTransfers.delete(transferId);
      }
    }
  }

  private rememberSentSnapshotTransfer(transferId: string, record: SentSnapshotTransfer): void {
    // Bounded: only recent transfers need retransmission, and each entry is
    // metadata (plus a reference to already-in-memory bytes), never a copy.
    while (this.sentSnapshotTransfers.size >= MAX_SENT_SNAPSHOT_TRANSFERS) {
      const oldest = this.sentSnapshotTransfers.keys().next().value;
      if (oldest === undefined) break;
      this.sentSnapshotTransfers.delete(oldest);
    }
    this.sentSnapshotTransfers.set(transferId, record);
  }

  /**
   * Answers a receiver's `snapshotFileRetry` by resending exactly the missing
   * chunk indices plus a fresh end frame. The temporary file on the receiver
   * is addressed by absolute chunk offsets, so retransmitted chunks splice in
   * without restarting the file or the snapshot.
   */
  private async resendSnapshotChunks(peerId: string, meta: Record<string, unknown>): Promise<void> {
    const snapshotId = meta.snapshotId === undefined
      ? this.activeSnapshotGenerations.get(peerId)
      : String(meta.snapshotId);
    if (!snapshotId || !TRANSFER_ID_PATTERN.test(snapshotId)) {
      throw new Error('Joining peer sent a malformed snapshot generation id.');
    }
    const transferId = String(meta.transferId ?? '');
    if (!TRANSFER_ID_PATTERN.test(transferId)) {
      throw new Error('Joining peer sent a malformed snapshot retry request.');
    }
    const record = this.sentSnapshotTransfers.get(transferId);
    if (!record || record.peerId !== peerId || record.snapshotId !== snapshotId
      || this.activeSnapshotGenerations.get(peerId) !== snapshotId || !this.coordinator.isCurrentHost()) return;
    const requested = Array.isArray(meta.indices) ? meta.indices : [];
    if (requested.length > record.chunks) {
      throw new Error('Joining peer requested more snapshot chunks than the transfer declared.');
    }
    const indices = new Set<number>();
    for (const value of requested) {
      const index = Number(value);
      if (!Number.isSafeInteger(index) || index < 0 || index >= record.chunks) {
        throw new Error('Joining peer requested an out-of-range snapshot chunk index.');
      }
      indices.add(index);
    }
    for (const index of [...indices].sort((left, right) => left - right)) {
      const chunk = await this.readSnapshotChunk(record, index);
      this.transport.sendTo(peerId, 'snapshotFileChunk', { snapshotId, transferId, index }, chunk);
    }
    await this.transport.awaitDrain(peerId);
    this.transport.sendTo(peerId, 'snapshotFileEnd', { snapshotId, transferId });
  }

  private async readSnapshotChunk(record: SentSnapshotTransfer, index: number): Promise<Buffer> {
    const start = index * record.chunkSize;
    const length = index === record.chunks - 1
      ? record.size - start
      : record.chunkSize;
    if (record.bytes) {
      if (start + length > record.bytes.byteLength) {
        throw new Error(`Snapshot source shrank during retransmission: ${record.relativePath}`);
      }
      return Buffer.from(record.bytes.subarray(start, start + length));
    }
    if (!record.absolutePath) throw new Error(`Snapshot source is unavailable: ${record.relativePath}`);
    const handle = await open(record.absolutePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, start);
      if (bytesRead !== length) {
        throw new Error(`Snapshot source changed during retransmission: ${record.relativePath}`);
      }
      return buffer;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  public async leave(): Promise<void> {
    if (this.closed) return;
    await this.disposeAsync('explicit-leave');
  }

  /** Saves the authoritative copy and closes the session for every participant. */
  public async endSession(): Promise<void> {
    if (this.closed) return;
    if (!this.coordinator.isCurrentHost()) {
      throw new Error('Only the current Session Host can end the session for everyone.');
    }
    this.endingSession = true;
    try {
      await this.awaitSessionEndFence();
      await this.messageQueue;
      await this.backgroundMessageQueue;
      if (this.waitingForHostFolder) {
        // No canonical backing root exists during host-folder selection. Keep
        // the authoritative final state and signed termination marker in the
        // extension-owned working copy so ending never forces an arbitrary
        // folder choice or discards the last merged edits.
        await this.prepareWorkingCopy?.();
        await this.flush();
      } else {
        await this.saveAsHost();
      }
      await writeSessionTermination(this.descriptor, this.token, this.descriptor.localPeer);
      this.transport.broadcast('sessionEnded', {});
      try {
        await this.transport.awaitDrainAll(0, 5000);
      } catch (error) {
        this.log.appendLine(`[debug] Session-end notification drain: ${formatError(error)}`);
      }
      await this.disposeAsync('session-ended');
    } catch (error) {
      this.endingSession = false;
      this.transport.broadcast('sessionEndingCancelled', {});
      throw error;
    }
  }

  private async awaitSessionEndFence(): Promise<void> {
    const waitingFor = new Set(this.transport.peerRuntime()
      .filter((peer) => peer.online && peer.peerId !== this.descriptor.localPeer.peerId)
      .map((peer) => peer.peerId));
    if (!waitingFor.size) return;
    await new Promise<void>((resolve) => {
      const id = newId();
      const timer = setTimeout(() => {
        const pending = this.pendingSessionEndFence;
        if (!pending || pending.id !== id) return;
        this.log.appendLine(`[debug] Session-end fence timed out waiting for: ${[...pending.waitingFor].join(', ')}.`);
        this.pendingSessionEndFence = undefined;
        resolve();
      }, 5000);
      this.pendingSessionEndFence = { id, waitingFor, resolve, timer };
      this.transport.broadcast('sessionEnding', { terminationId: id });
    });
  }

  private acknowledgeSessionEndFence(sourceId: string, terminationId: string): void {
    const pending = this.pendingSessionEndFence;
    if (!pending || pending.id !== terminationId || !pending.waitingFor.delete(sourceId)) return;
    if (pending.waitingFor.size) return;
    clearTimeout(pending.timer);
    this.pendingSessionEndFence = undefined;
    pending.resolve();
  }

  public dispose(): void {
    this.runBackground('Session shutdown', () => this.disposeAsync('explicit-leave'));
  }

  private async disposeAsync(reason: SessionCloseReason = this.closeReason): Promise<void> {
    if (this.closed) return;
    const terminalHostId = this.coordinator.clock.hostId;
    const correlationId = reason === 'host-unreachable'
      ? this.getLatestLifecycleCorrelationByPeer().get(terminalHostId) ?? this.getLifecycleDiagnosticsRing().newCorrelationId()
      : this.getLifecycleDiagnosticsRing().newCorrelationId();
    const diagnosticReason: DiagnosticReason = reason;
    this.getLifecycleDiagnosticsRing().record('runtime-close-started', {
      correlationId,
      ...(terminalHostId !== this.descriptor.localPeer.peerId ? { remotePeerId: terminalHostId } : {}),
      connectionState: 'closing', routeKind: 'none', reason: diagnosticReason,
    });
    this.closed = true;
    this.closeReason = reason;
    const terminal: SessionTerminalLifecycle = {
      reason,
      sessionId: this.descriptor.sessionId,
      peerId: this.descriptor.localPeer.peerId,
      hostId: this.coordinator.clock.hostId,
      at: Date.now(),
    };
    this.terminalLifecycleEvent = terminal;
    this.terminalResolve(terminal);
    const closedError = () => new SessionClosedError(terminal);
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    if (this.workingCopyFallbackTimer) clearTimeout(this.workingCopyFallbackTimer);
    this.workingCopyFallbackTimer = undefined;
    this.watcher?.dispose();
    this.watcher = undefined;
    for (const pending of this.pendingBinaryAcks.values()) {
      clearTimeout(pending.timer);
      pending.reject(closedError());
    }
    this.pendingBinaryAcks.clear();
    for (const pending of this.pendingBarrierReplies.values()) {
      clearTimeout(pending.timer);
      pending.reject(closedError());
    }
    this.pendingBarrierReplies.clear();
    for (const pending of this.pendingBarrierAuthorizations.values()) clearTimeout(pending.timer);
    this.pendingBarrierAuthorizations.clear();
    for (const pending of this.completedExecutionBarriers.values()) clearTimeout(pending.timer);
    this.completedExecutionBarriers.clear();
    for (const pending of this.pendingKernelCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(closedError());
    }
    this.pendingKernelCommands.clear();
    for (const pending of this.pendingInputReplies.values()) {
      clearTimeout(pending.timer);
      pending.reject(closedError());
    }
    this.pendingInputReplies.clear();
    for (const pending of this.pendingExecutions.values()) {
      clearTimeout(pending.timer);
      pending.reject(closedError());
    }
    this.pendingExecutions.clear();
    for (const completed of this.completedRemoteExecutions.values()) {
      clearTimeout(completed.expiryTimer);
      if (completed.retryTimer) clearTimeout(completed.retryTimer);
    }
    this.completedRemoteExecutions.clear();
    this.completedRemoteExecutionBytes = 0;
    for (const receipt of this.completedExecutionReceipts.values()) clearTimeout(receipt.timer);
    this.completedExecutionReceipts.clear();
    for (const pending of this.pendingTransfers.values()) {
      clearTimeout(pending.timer);
      pending.reject(closedError());
    }
    this.pendingTransfers.clear();
    for (const pending of this.pendingSnapshotCheckpoints.values()) {
      clearTimeout(pending.timer);
      pending.reject(closedError());
    }
    this.pendingSnapshotCheckpoints.clear();
    this.sentSnapshotTransfers.clear();
    this.activeSnapshotGenerations.clear();
    for (const prepared of this.preparedHostTransfers.values()) clearTimeout(prepared.timer);
    this.preparedHostTransfers.clear();
    if (this.pendingSessionEndFence) {
      clearTimeout(this.pendingSessionEndFence.timer);
      this.pendingSessionEndFence.resolve();
      this.pendingSessionEndFence = undefined;
    }
    for (const owner of this.executionOwners.values()) {
      if (owner.replayTimer) clearTimeout(owner.replayTimer);
    }
    this.executionOwners.clear();
    this.kernelCommandWindows.clear();
    for (const kernel of this.kernels.values()) kernel.stop();
    this.kernels.clear();
    this.kernelLastUsed.clear();
    // Every teardown step runs to completion even when an earlier one fails.
    // A failing final persistence must never leave the transport listening, the
    // documents alive or `pairNotebook.inSession` stuck at true, and the
    // `closed` event must always be emitted because `leave()` is not retryable.
    const failures: unknown[] = [];
    const step = async (action: () => unknown | Promise<unknown>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    };
    await step(() => {
      if (this.awareness.getLocalState() !== null) this.awareness.setLocalState(null);
    });
    for (const disposable of this.sessionDisposables.splice(0)) {
      await step(() => disposable.dispose());
    }
    for (const transferId of [...this.binaryTransfers.keys()]) {
      await step(() => this.abortBinaryTransfer(transferId));
    }
    await step(() => this.descriptorWriteQueue);
    await step(() => this.autosave?.stop());
    this.autosave = undefined;
    await step(() => this.storage?.stop(true));
    await step(() => this.transport.stop());
    await step(() => this.project.destroy());
    await step(() => this.awareness.destroy());
    await step(() => this.removeTransferDirectory());
    await step(() => vscode.commands.executeCommand('setContext', 'pairNotebook.executionAvailable', false));
    await step(() => vscode.commands.executeCommand('setContext', 'pairNotebook.inSession', false));
    await step(() => {
      if (this.terminalEventEmitted) return;
      this.terminalEventEmitted = true;
      this.getLifecycleDiagnosticsRing().record('runtime-close-completed', {
        correlationId,
        ...(terminalHostId !== this.descriptor.localPeer.peerId ? { remotePeerId: terminalHostId } : {}),
        connectionState: 'closed', routeKind: 'none', reason: diagnosticReason,
      });
      const sanitizedSession = this.getLifecycleDiagnosticsRing().snapshot().at(-1)?.sessionIdentifier ?? 'session-unknown';
      this.log.appendLine(
        `[lifecycle] terminal reason=${terminal.reason} correlation=${correlationId} session=${sanitizedSession} peer=${terminal.peerId} host=${terminal.hostId} at=${terminal.at}`,
      );
      this.emit('terminal', terminal);
    });
    // Compatibility event for existing internal/tests; product UI no longer
    // consumes this unstructured reason-only event.
    await step(() => this.emit('closed', this.closeReason));
    for (const failure of failures) {
      this.log.appendLine(`[error] Session shutdown step failed: ${formatError(failure)}`);
    }
    if (failures.length) throw failures[0];
  }

  private installProjectHandlers(): void {
    // Cell payload collection is irreversible, so the CRDT layer asks the
    // runtime whether every known participant is currently present.
    this.project.collectionGuard = (now) => this.isGarbageCollectionSafe(now);
    this.project.on('cellStateRepaired', (key: string, ids: string[]) => {
      this.log.appendLine(`[debug] Removed order entries without cell state in ${key}: ${ids.join(', ')}`);
    });
    this.project.on('update', (event: ProjectUpdate) => {
      if (event.origin !== REMOTE_ORIGIN && !this.endingSession) {
        try {
          const fileState = this.ensureLiveFileState(event.key, event.kind);
          this.transport.broadcast('projectUpdate', {
            key: event.key, kind: event.kind, scope: event.scope, fileState,
          }, event.update);
        } catch (error) {
          this.log.appendLine(`[error] Could not publish project update for ${event.key}: ${formatError(error)}`);
          this.transition('file-synchronization-failed', `Project update for ${event.key} was not published.`);
        }
      }
      this.storage?.schedule(event.key);
    });
  }

  private installTransportHandlers(): void {
    this.transport.on('lifecycleDiagnostic', (event: TransportLifecycleDiagnostic) => {
      this.getLatestLifecycleCorrelationByPeer().set(event.remotePeerId, event.correlationId);
      this.getLifecycleDiagnosticsRing().record(event.eventType, {
        correlationId: event.correlationId,
        remotePeerId: event.remotePeerId,
        connectionState: event.connectionState,
        routeKind: event.routeKind,
        reason: event.reason,
        ...(event.metadata ? { metadata: event.metadata } : {}),
      });
    });
    this.transport.on('peerConnected', (peer: PeerIdentity) => {
      if (this.coordinator.isCurrentHost()) peer = this.assignPeerJoinOrder(peer);
      this.coordinator.upsertPeer(this.asRuntime(peer, true));
      const known = new Map((this.descriptor.knownPeers ?? []).map((item) => [item.peerId, item]));
      known.set(peer.peerId, peer);
      this.descriptor.knownPeers = normalizeKnownPeers([...known.values()], this.descriptor.localPeer.peerId);
      this.persistDescriptorInBackground();
      try {
        this.sendFilesystemState(peer.peerId);
        if (this.coordinator.isCurrentHost()) {
          this.sendComputeState(peer.peerId);
          void this.sendProjectState(peer.peerId).catch((error) => {
            this.log.appendLine(`[error] Failed to send initial project state to ${peer.displayName}: ${formatError(error)}`);
          });
        } else {
          void this.sendStateVectors(peer.peerId).catch((error) => {
            this.log.appendLine(`[error] Failed to send state vectors to ${peer.displayName}: ${formatError(error)}`);
          });
        }
        if (this.awareness.getLocalState()) {
          this.transport.sendTo(peer.peerId, 'awareness', {}, encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]));
        }
        this.sendRuntimePresence(peer.peerId);
        this.replayRemoteExecutionsForPeer(peer.peerId);
      } catch (error) {
        this.log.appendLine(`[error] Failed to initialize peer ${peer.displayName}: ${formatError(error)}`);
      }
      this.emit('peerConnected', peer);
      if (this.runtimeState === 'reconnecting' || this.runtimeState === 'host-unavailable') {
        this.transition('syncing', `Reconnected to ${peer.displayName}; reconciling state vectors.`);
      }
    });
    this.transport.on('bootstrapConnected', (peer: PeerIdentity) => {
      if (this.coordinator.isCurrentHost()) {
        this.cancelSnapshotGeneration(
          peer.peerId,
          `Joining peer ${peer.displayName} replaced its authenticated snapshot route.`,
        );
        this.assignPeerJoinOrder(peer);
      }
    });
    this.transport.on('localIdentityUpdated', (peer: PeerIdentity) => {
      Object.assign(this.descriptor.localPeer, peer);
      this.assignedJoinOrders.set(peer.peerId, peer.joinOrder);
      this.coordinator.upsertPeer(this.asRuntime(this.descriptor.localPeer, true));
      this.persistDescriptorInBackground();
      this.updatePresence();
      this.emit('identityChanged', { ...this.descriptor.localPeer });
    });
    this.transport.on('peerDisconnected', (peer: PeerIdentity) => {
      this.coordinator.markDisconnected(peer.peerId);
      this.kernelCommandWindows.delete(peer.peerId);
      this.binaryAcknowledgements.delete(peer.peerId);
      this.remoteRuntimePresence.delete(peer.peerId);
      this.rejectSnapshotCheckpoints(
        peer.peerId,
        `Peer ${peer.displayName} disconnected during project snapshot transfer.`,
      );
      const endFence = this.pendingSessionEndFence;
      if (endFence?.waitingFor.delete(peer.peerId) && !endFence.waitingFor.size) {
        clearTimeout(endFence.timer);
        this.pendingSessionEndFence = undefined;
        endFence.resolve();
      }
      this.rejectSynchronizationWaiters(peer.peerId, `Peer ${peer.displayName} disconnected during file synchronization.`);
      for (const [key, authorization] of [...this.pendingBarrierAuthorizations]) {
        if (authorization.sourceId !== peer.peerId) continue;
        clearTimeout(authorization.timer);
        this.pendingBarrierAuthorizations.delete(key);
      }
      for (const [key, authorization] of [...this.completedExecutionBarriers]) {
        if (authorization.sourceId !== peer.peerId) continue;
        clearTimeout(authorization.timer);
        this.completedExecutionBarriers.delete(key);
      }
      this.clearPeerAwareness(peer.peerId);
      for (const [requestId, owner] of [...this.executionOwners]) {
        if (owner.peerId !== peer.peerId) continue;
        void this.kernels.get(owner.notebookKey)?.interrupt().catch(() => undefined);
        if (owner.replayTimer) clearTimeout(owner.replayTimer);
        this.executionOwners.delete(requestId);
      }
      for (const [requestId, completed] of [...this.completedRemoteExecutions]) {
        if (completed.sourceId === peer.peerId) this.dropCompletedRemoteExecution(requestId);
      }
      for (const [requestId, receipt] of [...this.completedExecutionReceipts]) {
        if (receipt.executorId !== peer.peerId) continue;
        clearTimeout(receipt.timer);
        this.completedExecutionReceipts.delete(requestId);
      }
      const affected = Object.entries(this.descriptor.notebookCompute ?? {})
        .filter(([, target]) => target.executorId === peer.peerId)
        .map(([key]) => key);
      if (peer.peerId === this.descriptor.computeExecutorId || affected.length) {
        this.transition('executor-unavailable', `Compute executor ${peer.displayName} disconnected.`);
        for (const notebookKey of affected) this.setKernelStatus(notebookKey, 'Offline');
        if (peer.peerId === this.descriptor.computeExecutorId) this.setKernelStatus('*', 'Offline');
        this.cancelExecutorRequests(peer.peerId, `Compute executor ${peer.displayName} disconnected.`);
      }
      if (peer.peerId === this.coordinator.clock.hostId) {
        this.transition(
          this.descriptor.mode === 'host-only' ? 'host-unavailable' : 'reconnecting',
          `Session host ${peer.displayName} disconnected.`,
        );
      }
      this.emit('peerDisconnected', peer);
    });
    this.transport.on('bootstrapDisconnected', (peer: PeerIdentity) => {
      this.cancelSnapshotGeneration(
        peer.peerId,
        `Joining peer ${peer.displayName} disconnected during project snapshot transfer.`,
      );
    });
    this.transport.on('metrics', (metrics: MeshMetrics) => { this.meshMetrics = metrics; });
    this.transport.on('message', (frame: WireFrame, sourceId: string) => {
      this.enqueueIncomingMessage(frame, sourceId);
    });
    this.transport.on('protocolError', (error) => this.log.appendLine(`[error] Protocol: ${formatError(error)}`));
    this.transport.on('connectionError', (peer, error) => {
      const detail = `Connection to ${peer.displayName} failed: ${formatError(error)}`;
      this.log.appendLine(`[debug] ${detail}`);
      // A late RTC error for a former host can arrive after a voluntary host
      // transfer. Likewise, losing an unrelated participant must not make a
      // healthy session look offline.
      // Only a current-host failure (or initial connection failure) owns the
      // global reconnecting state.
      const currentHostFailed = !this.coordinator.isCurrentHost()
        && peer.peerId === this.coordinator.clock.hostId;
      if (!this.closed && !this.waitingForHostFolder
        && (currentHostFailed || this.runtimeState === 'connecting')) {
        this.transition('reconnecting', detail);
      }
    });
    // Real-time connection-quality/migration events for the sidebar.
    this.transport.on('routeUpgradeStatus', (state: RouteUpgradeState) => {
      this.log.appendLine(`[debug] Route upgrade ${state.peerId}: ${state.status}${state.detail ? ` (${state.detail})` : ''}`);
      this.emit('connectionUpdated', { kind: 'route-upgrade', ...state });
    });
    this.transport.on('routeChanged', (peer: PeerIdentity, from: string, to: string) => {
      this.log.appendLine(`[debug] Route to ${peer.displayName} changed: ${from} -> ${to}`);
      this.emit('connectionUpdated', { kind: 'route-changed', peerId: peer.peerId, from, to });
    });
    this.transport.on('remoteRouteStatus', (peerId: string, status: string) => {
      this.emit('connectionUpdated', { kind: 'remote-status', peerId, status });
    });
    this.transport.on('networkChanged', () => {
      this.log.appendLine('[debug] Network interfaces changed; re-evaluating routes (make-before-break).');
      this.emit('connectionUpdated', { kind: 'network-changed' });
      this.emit('networkChanged');
    });
  }

  private assignPeerJoinOrder(peer: PeerIdentity): PeerIdentity {
    let joinOrder = this.assignedJoinOrders.get(peer.peerId);
    if (joinOrder === undefined) {
      const highest = Math.max(0, ...this.assignedJoinOrders.values());
      if (!Number.isSafeInteger(highest) || highest >= Number.MAX_SAFE_INTEGER) {
        throw new Error('Participant order space is exhausted.');
      }
      joinOrder = highest + 1;
      this.assignedJoinOrders.set(peer.peerId, joinOrder);
    }
    return this.transport.setPeerJoinOrder(peer.peerId, joinOrder);
  }

  private enqueueIncomingMessage(frame: WireFrame, sourceId: string): void {
    if (frame.type === 'kernelCommand' && !this.acceptKernelCommandRate(sourceId)) {
      this.log.appendLine(`[error] Protocol: dropped kernel command from ${sourceId}; command rate limit exceeded.`);
      return;
    }
    const isSnapshotRequest = frame.type === 'snapshotRequest';
    if (isSnapshotRequest && this.pendingSnapshotRequests >= MAX_PENDING_SNAPSHOT_REQUESTS) {
      this.log.appendLine(`[error] Protocol: dropped snapshot request from ${sourceId}; snapshot queue is full.`);
      return;
    }
    const retainedBytes = frame.payload.byteLength + estimateMetadataBytes(frame.meta);
    if (this.pendingIncomingMessages >= MAX_PENDING_MESSAGES
      || this.pendingIncomingBytes + retainedBytes > MAX_PENDING_MESSAGE_BYTES) {
      this.log.appendLine(`[error] Protocol: dropped ${frame.type} from ${sourceId}; inbound work queue is full.`);
      return;
    }
    this.pendingIncomingMessages += 1;
    this.pendingIncomingBytes += retainedBytes;
    if (isSnapshotRequest) this.pendingSnapshotRequests += 1;
    const release = () => {
      this.pendingIncomingMessages -= 1;
      this.pendingIncomingBytes -= retainedBytes;
      if (isSnapshotRequest) this.pendingSnapshotRequests -= 1;
    };
    if (isBackgroundMessage(frame.type)) {
      this.backgroundMessageQueue = this.backgroundMessageQueue
        .then(() => this.onMessage(frame, sourceId))
        .catch((error) => this.log.appendLine(`[error] Background message queue: ${formatError(error)}`))
        .finally(release);
      return;
    }
    this.messageQueue = this.messageQueue
      .then(() => this.onMessage(frame, sourceId))
      .catch((error) => this.log.appendLine(`[error] Message queue: ${formatError(error)}`))
      .finally(release);
  }

  private acceptKernelCommandRate(sourceId: string): boolean {
    const now = Date.now();
    let window = this.kernelCommandWindows.get(sourceId);
    if (!window || now - window.startedAt >= 60_000) {
      window = { startedAt: now, count: 0 };
      this.kernelCommandWindows.set(sourceId, window);
    }
    window.count += 1;
    return window.count <= 12;
  }

  private installAwarenessHandlers(): void {
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin !== REMOTE_ORIGIN) {
        const clients = [...added, ...updated, ...removed]
          .filter((clientId) => clientId === this.awareness.clientID);
        if (clients.length) this.transport.broadcast('awareness', {}, encodeAwarenessUpdate(this.awareness, clients));
      }
      this.emit('presence');
    });
  }

  private acceptAwarenessUpdate(payload: Uint8Array, sourceId: string): void {
    if (payload.byteLength > 1024 * 1024) throw new Error('Awareness update exceeds the size limit.');
    const identity = this.transport.peerRuntime().find((peer) => peer.peerId === sourceId);
    if (!identity) throw new Error('Awareness update came from a non-runtime peer.');
    const records = inspectAwarenessUpdate(payload);
    const seenClients = new Set<number>();
    for (const record of records) {
      if (seenClients.has(record.clientId)) throw new Error('Awareness update contains a duplicate client id.');
      seenClients.add(record.clientId);
      if (record.clientId === this.awareness.clientID) {
        throw new Error('A remote peer attempted to overwrite the local awareness state.');
      }
      const owner = this.awarenessOwnerByClientId.get(record.clientId);
      if (owner && owner !== sourceId) throw new Error('Awareness client id is already owned by another peer.');
      if (record.state === null && owner !== sourceId) {
        throw new Error('A peer attempted to remove an awareness client it does not own.');
      }
    }
    let index = 0;
    const sanitized = modifyAwarenessUpdate(payload, (state: unknown) => {
      const record = records[index++];
      if (!record || state === null) return null;
      const presence = sanitizePresenceState(state, identity);
      if (!presence) throw new Error('Peer sent a malformed awareness state.');
      return presence;
    });
    applyAwarenessUpdate(this.awareness, sanitized, REMOTE_ORIGIN);
    for (const record of records) {
      if (record.state === null) {
        if (this.awarenessOwnerByClientId.get(record.clientId) === sourceId) {
          this.awarenessOwnerByClientId.delete(record.clientId);
        }
        const clients = this.awarenessClientsByPeer.get(sourceId);
        clients?.delete(record.clientId);
        if (clients && !clients.size) this.awarenessClientsByPeer.delete(sourceId);
        continue;
      }
      this.awarenessOwnerByClientId.set(record.clientId, sourceId);
      const clients = this.awarenessClientsByPeer.get(sourceId) ?? new Set<number>();
      clients.add(record.clientId);
      this.awarenessClientsByPeer.set(sourceId, clients);
    }
  }

  /**
   * Terminal logical disconnect cleanup. Recovery intentionally does not call
   * this helper: awareness remains visible until the bounded route recovery
   * either succeeds or emits one terminal peerDisconnected event.
   */
  private clearPeerAwareness(peerId: string): void {
    const clients = new Set(this.awarenessClientsByPeer.get(peerId) ?? []);
    for (const [clientId, owner] of this.awarenessOwnerByClientId) {
      if (owner === peerId) clients.add(clientId);
    }
    if (clients.size) removeAwarenessStates(this.awareness, [...clients], REMOTE_ORIGIN);
    for (const clientId of clients) {
      if (this.awarenessOwnerByClientId.get(clientId) === peerId) {
        this.awarenessOwnerByClientId.delete(clientId);
      }
    }
    this.awarenessClientsByPeer.delete(peerId);
  }

  private installPresenceTracking(): void {
    const update = () => this.updatePresence();
    this.sessionDisposables.push(
      vscode.window.onDidChangeActiveTextEditor(update),
      vscode.window.onDidChangeTextEditorSelection(update),
      vscode.window.onDidChangeActiveNotebookEditor(update),
      vscode.window.onDidChangeNotebookEditorSelection(update),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('pairNotebook')) update();
      }),
    );
  }

  private installFileWatcher(): void {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.descriptor.workingFolder, '**/*'));
    watcher.onDidCreate((uri) => this.runBackground('Local file create', () => this.onLocalFile(uri, 'create')));
    watcher.onDidChange((uri) => this.runBackground('Local file change', () => this.onLocalFile(uri, 'change')));
    watcher.onDidDelete((uri) => this.runBackground('Local file delete', () => this.onLocalDelete(uri)));
    this.watcher = watcher;
    this.sessionDisposables.push(
      vscode.workspace.onDidCreateFiles((event) => {
        for (const uri of event.files) {
          this.runBackground('Explorer file create', () => this.onCreatedFromExplorer(uri));
        }
      }),
      vscode.workspace.onDidRenameFiles((event) => {
        for (const pair of event.files) {
          this.runBackground('Explorer file rename', () => this.onLocalRename(pair.oldUri, pair.newUri));
        }
      }),
    );
  }

  private async onMessage(frame: WireFrame, sourceId: string): Promise<void> {
    if (this.closed) return;
    try {
      const rawClock = frame.meta.clock;
      const clock = normalizeHostClock(rawClock, this.coordinator.clock.sessionEpoch);
      if (rawClock !== undefined && !clock) throw new Error(`Peer ${sourceId} sent a malformed host clock.`);
      if (clock && compareClock(clock, this.coordinator.clock) < 0 && !isClockAgnosticFrame(frame.type)) return;
      switch (frame.type) {
        case 'helloAck': {
          const peer = this.transport.peerRuntime().find((candidate) => candidate.peerId === sourceId);
          if (peer) this.coordinator.upsertPeer(peer);
          break;
        }
        case 'hostHeartbeat':
          if (clock && sourceId === this.coordinator.clock.hostId && sameClock(clock, this.coordinator.clock)) {
            this.coordinator.markHeartbeat(sourceId);
            if (frame.meta.hostStorageReady === true) await this.onHostStorageReady(sourceId);
            else if (frame.meta.hostStorageReady === false && !this.waitingForHostFolder) {
              this.waitingForHostFolder = true;
              this.transition('waiting-for-host-folder', 'The session is paused until the new host chooses a folder on their computer.');
              this.emit('hostPaused', this.coordinator.clock);
            }
          }
          break;
        case 'projectUpdate':
        case 'stateDocument':
        case 'stateDiff': {
          const key = normalizedTrackedPath(String(frame.meta.key ?? ''));
          const kind = frame.meta.kind as DocumentKind;
          if (key && (kind === 'text' || kind === 'notebook')) {
            const incomingState = normalizeFileState(frame.meta.fileState, sourceId, kind);
            if (!incomingState || !await this.acceptFileState(key, incomingState, sourceId)) break;
            if (this.effectiveFileState(key)?.deleted) break;
            let scope: ProjectUpdate['scope'] = undefined;
            if (kind === 'notebook') {
              scope = normalizeNotebookUpdateScope(frame.meta.scope);
              if (frame.meta.scope !== undefined && !scope) {
                throw new Error(`Peer ${sourceId} sent an invalid notebook update scope.`);
              }
              if (frame.type === 'projectUpdate' && !scope) {
                throw new Error(`Peer ${sourceId} sent an unscoped notebook project update.`);
              }
            }
            this.project.applyRemoteUpdate(key, kind, frame.payload, scope);
          }
          break;
        }
        case 'stateVector': {
          const key = normalizedTrackedPath(String(frame.meta.key ?? ''));
          const kind = frame.meta.kind as DocumentKind;
          if (key && (kind === 'text' || kind === 'notebook')) {
            // acceptFileState materializes a new empty CRDT document. Remember
            // whether it existed first, otherwise the branch that asks the
            // source for its full state is permanently unreachable.
            const hadDocument = this.project.has(key);
            const incomingState = normalizeFileState(frame.meta.fileState, sourceId, kind);
            if (!incomingState || !await this.acceptFileState(key, incomingState, sourceId)) break;
            const localState = this.effectiveFileState(key);
            if (localState?.deleted) {
              this.transport.sendTo(sourceId, 'fileState', { relativePath: key, state: localState });
              break;
            }
            if (!hadDocument) {
              const state = this.ensureLiveFileState(key, kind);
              if (kind === 'text') this.project.ensureText(key);
              else this.project.ensureNotebook(key);
              this.transport.sendTo(sourceId, 'stateVector', { key, kind, fileState: state }, this.project.encodeStateVector(key));
            } else {
              this.transport.sendTo(sourceId, 'stateDiff', { key, kind, fileState: this.effectiveFileState(key) }, this.project.encodeUpdate(key, frame.payload));
            }
          }
          break;
        }
        case 'filesystemState':
          await this.reconcileFilesystemState(frame, sourceId);
          break;
        case 'fileState': {
          const relativePath = normalizedTrackedPath(String(frame.meta.relativePath ?? ''));
          const state = normalizeFileState(frame.meta.state, sourceId);
          if (relativePath && state) {
            const hadDocument = this.project.has(relativePath);
            const accepted = await this.acceptFileState(relativePath, state, sourceId);
            if (accepted && !hadDocument && !state.deleted && (state.kind === 'text' || state.kind === 'notebook')) {
              this.requestDocumentState(sourceId, relativePath, state.kind);
            }
          }
          break;
        }
        case 'stateEnd':
          if (!this.initialStateReceived && this.descriptor.role === 'peer'
            && sourceId !== this.coordinator.clock.hostId) break;
          this.initialStateReceived = true;
          this.stateReadyResolve();
          // A paused session (new host has not chosen a folder yet) must stay
          // paused even when the host finishes a state reconciliation; the
          // host's later hostStorageReady message owns the resume transition.
          if (!this.waitingForHostFolder) {
            this.transition('ready', `State reconciliation with ${sourceId} completed.`);
          }
          break;
        case 'awareness':
          this.acceptAwarenessUpdate(frame.payload, sourceId);
          break;
        case 'hardwarePresence':
          this.acceptHardwarePresence(frame, sourceId);
          break;
        case 'resourcePresence':
          this.acceptResourcePresence(frame, sourceId);
          break;
        case 'kernelPresence':
          this.acceptKernelPresence(frame, sourceId);
          break;
        case 'sessionEnding': {
          if (sourceId !== this.coordinator.clock.hostId) break;
          const terminationId = String(frame.meta.terminationId ?? '');
          if (!TRANSFER_ID_PATTERN.test(terminationId)) break;
          this.endingSession = true;
          this.transition('syncing', 'The host is finalizing the session.');
          try {
            await this.prepareWorkingCopy?.();
            await this.flush();
          } catch (error) {
            this.log.appendLine(`[debug] Could not flush the local working copy before session end: ${formatError(error)}`);
          }
          await this.transport.awaitDrainAll(0, 5000).catch((error) => {
            this.log.appendLine(`[debug] Session-end peer drain: ${formatError(error)}`);
          });
          this.transport.sendTo(sourceId, 'sessionEndingAck', { terminationId });
          this.emit('sessionEnding');
          break;
        }
        case 'sessionEndingAck':
          if (this.coordinator.isCurrentHost()) {
            this.acknowledgeSessionEndFence(sourceId, String(frame.meta.terminationId ?? ''));
          }
          break;
        case 'sessionEndingCancelled':
          if (sourceId === this.coordinator.clock.hostId) {
            this.endingSession = false;
            this.transition(
              this.waitingForHostFolder ? 'waiting-for-host-folder' : 'ready',
              this.waitingForHostFolder
                ? 'Session ending was cancelled. Choose a host folder, transfer the host role, or try ending again.'
                : 'Session ending was cancelled because final persistence failed.',
            );
          }
          break;
        case 'sessionEnded': {
          if (sourceId !== this.coordinator.clock.hostId) {
            this.log.appendLine(`[debug] Ignored session-end request from non-host peer ${sourceId}.`);
            break;
          }
          const endedBy = this.transport.peerRuntime().find((peer) => peer.peerId === sourceId)
            ?? (this.descriptor.knownPeers ?? []).find((peer) => peer.peerId === sourceId)
            ?? resolveHostIdentity(this.descriptor, sourceId);
          try {
            await writeSessionTermination(this.descriptor, this.token, endedBy);
          } catch (error) {
            this.log.appendLine(`[debug] Could not persist the local session-end marker: ${formatError(error)}`);
          }
          this.emit('sessionEnded', endedBy, 'explicit-end');
          await this.disposeAsync('session-ended');
          break;
        }
        case 'snapshotCheckpointAck':
          this.acceptSnapshotCheckpoint(
            sourceId,
            frame.meta.snapshotId === undefined
              ? undefined
              : normalizeSnapshotGenerationId(frame.meta.snapshotId),
            String(frame.meta.checkpointId ?? ''),
          );
          break;
        case 'snapshotFileRetry':
          await this.resendSnapshotChunks(sourceId, frame.meta);
          break;
        case 'snapshotRequest': {
          const snapshotId = frame.meta.snapshotId === undefined
            ? newId()
            : normalizeSnapshotGenerationId(frame.meta.snapshotId);
          if (!this.coordinator.isCurrentHost()) {
            this.transport.sendTo(sourceId, 'snapshotError', { snapshotId, reason: 'stale-invite' });
            break;
          }
          try {
            await this.sendSnapshot(sourceId, normalizeCompletedSnapshot(frame.meta.completed), snapshotId);
          } catch (error) {
            // Do not expose local paths or operating-system diagnostics to an
            // untrusted invite holder. The exact failure remains in the host log.
            try {
              this.transport.sendTo(sourceId, 'snapshotError', { snapshotId, reason: 'host-snapshot-failed' });
            } catch { /* the bootstrap peer may already have disconnected */ }
            throw error;
          }
          break;
        }
        case 'binaryStart':
          await this.beginBinaryTransfer(frame, sourceId);
          break;
        case 'binaryChunk':
          // Chunks are keyed by (sourceId, transferId), so one participant can
          // never write into or complete another participant's transfer.
          await this.acceptBinaryChunk(sourceId, String(frame.meta.transferId), Number(frame.meta.index), frame.payload);
          break;

        case 'binaryEnd':
          await this.finishBinary(sourceId, String(frame.meta.transferId));
          break;
        case 'binaryAbort': {
          const transferId = String(frame.meta.transferId ?? '');
          if (TRANSFER_ID_PATTERN.test(transferId)) {
            await this.abortBinaryTransfer(transferKey(sourceId, transferId));
          }
          break;
        }
        case 'binaryAck':
          this.acceptBinaryAck(
            sourceId,
            String(frame.meta.relativePath),
            String(frame.meta.hash),
            Number(frame.meta.version),
            String(frame.meta.author ?? sourceId),
          );
          break;
        case 'binarySyncRequest': {
          const relativePath = normalizedTrackedPath(String(frame.meta.relativePath ?? ''));
          const requested = normalizeBinaryVersion(frame.meta.version, sourceId);
          const local = relativePath ? this.binaryVersions.get(relativePath) : undefined;
          if (relativePath && local && (!requested || compareBinaryVersion(local, requested) >= 0)) {
            void this.synchronizeBinaryVersion(sourceId, relativePath, local).catch((error) => {
              this.log.appendLine(`[error] Binary sync response for ${relativePath}: ${formatError(error)}`);
            });
          } else {
            this.sendFilesystemState(sourceId);
          }
          break;
        }
        case 'executionBarrierCheck':
          await this.handleExecutionBarrierCheck(frame, sourceId);
          break;
        case 'executionBarrierStatus':
          this.resolveBarrierReply(String(frame.meta.requestId), 'status', sourceId, frame.meta);
          break;
        case 'executionBarrierCommit':
          await this.handleExecutionBarrierCommit(frame, sourceId);
          break;
        case 'executionBarrierAck':
          this.resolveBarrierReply(String(frame.meta.requestId), 'ack', sourceId, frame.meta);
          break;
        case 'fileDelete': {
          const relativePath = normalizedTrackedPath(String(frame.meta.relativePath ?? ''));
          if (!relativePath) break;
          const state = normalizeFileState(frame.meta.state, sourceId);
          if (!state || !state.deleted) break;
          await this.acceptFileState(relativePath, state, sourceId);
          break;
        }
        case 'directoryCreate': {
          const relativePath = normalizedTrackedPath(String(frame.meta.relativePath ?? ''));
          if (!relativePath) break;
          const state = normalizeFileState(frame.meta.state, sourceId, 'directory');
          if (!state || state.deleted || state.kind !== 'directory') break;
          await this.acceptFileState(relativePath, state, sourceId);
          break;
        }
        case 'fileRename': {
          const from = normalizedTrackedPath(String(frame.meta.from ?? ''));
          const to = normalizedTrackedPath(String(frame.meta.to ?? ''));
          if (!from || !to || from === to) break;
          if (relativePathsNested(from, to)) {
            this.log.appendLine(`[error] Refusing overlapping rename from ${sourceId}.`);
            break;
          }
          const fromState = normalizeFileState(frame.meta.fromState, sourceId);
          const toState = normalizeFileState(frame.meta.toState, sourceId);
          if (!fromState?.deleted || !toState || toState.deleted || fromState.kind !== toState.kind) break;
          const conflict = this.resolveRenameConflict(from, to, toState);
          if (conflict.decision === 'loses') {
            // Deterministic rename/rename resolution: the losing destination is
            // tombstoned on every peer instead of becoming a second live copy.
            await this.acceptFileState(to, conflict.tombstone, sourceId);
            break;
          }
          const effectiveFrom = conflict.source;
          const acceptFrom = await this.acceptFileState(from, fromState, sourceId, false, false);
          const acceptTo = await this.acceptFileState(to, toState, sourceId, false, false);
          if (acceptFrom && acceptTo) {
            if (conflict.tombstone && conflict.losingPath) {
              await this.acceptFileState(conflict.losingPath, conflict.tombstone, sourceId, false, true);
            }
            this.renameFileStates(effectiveFrom, to, fromState, toState);
            this.renameNotebookRuntimeState(effectiveFrom, to);
            this.project.renameDocument(effectiveFrom, to);
            this.renameBinaryVersions(effectiveFrom, to);
            this.renameDirectories(effectiveFrom, to);
            this.recordRenameOrigin(from, to, toState);
            this.suppressDelete(effectiveFrom);
            await this.storage?.rename(effectiveFrom, to).catch(async (error) => {

              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
              await this.ensureLivePathMaterialized(to, toState);
            });
            this.transport.broadcast('fileState', { relativePath: from, state: fromState });
            this.transport.broadcast('fileState', { relativePath: to, state: toState });
            await this.persistDescriptor();
          } else {
            if (acceptFrom) await this.applyDeletedPath(from);
            if (acceptTo) await this.ensureLivePathMaterialized(to, toState);
          }
          break;
        }
        case 'hostAnnouncement':
          if (clock && sourceId === this.coordinator.clock.hostId) {
            for (const [transferId, prepared] of this.preparedHostTransfers) {
              if (prepared.sourceId === sourceId && sameClock(prepared.nextClock, clock)) {
                clearTimeout(prepared.timer);
                this.preparedHostTransfers.delete(transferId);
              }
            }
            const accepted = this.coordinator.applyAnnouncement(clock, sourceId);
            if (accepted) await this.onHostChanged();
          }
          break;
        case 'hostStorageReady':
          if (clock && sourceId === this.coordinator.clock.hostId && sameClock(clock, this.coordinator.clock)) {
            await this.onHostStorageReady(sourceId);
          }
          break;
        case 'hostTransferPrepare': {
          const transferId = String(frame.meta.transferId ?? '');
          const incoming = normalizeHostClock(frame.meta.nextClock, this.coordinator.clock.sessionEpoch);
          if (!TRANSFER_ID_PATTERN.test(transferId) || !incoming || sourceId !== this.coordinator.clock.hostId
            || incoming.hostId !== this.descriptor.localPeer.peerId
            || incoming.hostEpoch !== this.coordinator.clock.hostEpoch + 1) break;
          const previous = this.preparedHostTransfers.get(transferId);
          if (previous) clearTimeout(previous.timer);
          const timer = setTimeout(() => this.preparedHostTransfers.delete(transferId), 10 * 60_000);
          this.preparedHostTransfers.set(transferId, { sourceId, nextClock: incoming, timer });
          this.transport.sendTo(sourceId, 'hostTransferReady', { transferId, nextClock: incoming });
          break;
        }
        case 'hostTransferReady':
          this.resolveHostTransfer(String(frame.meta.transferId), sourceId, frame.meta.nextClock);
          break;
        case 'hostTransferCommit': {
          const transferId = String(frame.meta.transferId ?? '');
          const incoming = normalizeHostClock(frame.meta.nextClock, this.coordinator.clock.sessionEpoch);
          const prepared = this.preparedHostTransfers.get(transferId);
          if (!incoming || !prepared || prepared.sourceId !== sourceId || !sameClock(prepared.nextClock, incoming)) break;
          clearTimeout(prepared.timer);
          prepared.timer = setTimeout(() => this.preparedHostTransfers.delete(transferId), 30_000);
          this.transport.sendTo(sourceId, 'hostTransferAck', { transferId, nextClock: incoming });
          break;
        }
        case 'hostTransferAck':
          this.resolveHostTransfer(String(frame.meta.transferId), sourceId, frame.meta.nextClock);
          break;
        case 'hostTransferFinalize': {
          const transferId = String(frame.meta.transferId ?? '');
          const incoming = normalizeHostClock(frame.meta.nextClock, this.coordinator.clock.sessionEpoch);
          const prepared = this.preparedHostTransfers.get(transferId);
          if (!incoming || !prepared || prepared.sourceId !== sourceId || !sameClock(prepared.nextClock, incoming)) break;
          clearTimeout(prepared.timer);
          this.preparedHostTransfers.delete(transferId);
          if (this.coordinator.applyAnnouncement(incoming, sourceId)) await this.onHostChanged();
          break;
        }
        case 'computeChanged': {
          if (sourceId !== this.coordinator.clock.hostId) break;
          const announcedEpoch = Number(frame.meta.computeEpoch);
          const rawNotebookKey = String(frame.meta.notebookKey ?? '*');
          const notebookKey = rawNotebookKey === '*' ? '*' : normalizedTrackedPath(rawNotebookKey);
          const target = normalizeComputeTarget(
            (frame.meta.target as NotebookComputeTarget | undefined) ?? {
              executorId: String(frame.meta.executorId), device: 'cpu', epoch: announcedEpoch, author: sourceId,
            },
            sourceId,
          );
          if (!notebookKey || !target || target.author !== sourceId
            || target.executorId !== this.coordinator.clock.hostId
            || !Number.isSafeInteger(announcedEpoch) || announcedEpoch !== target.epoch) break;
          const current = this.computeForNotebook(notebookKey);
          const epochAdvance = target.epoch - current.epoch;
          const concurrentWinner = epochAdvance === 0 && compareComputeTarget(target, current) > 0;
          if ((epochAdvance === 1 || concurrentWinner) && compareComputeTarget(target, current) > 0) {
            this.applyComputeTarget(notebookKey, target);
            this.persistDescriptorInBackground();
          }
          break;
        }
        case 'computeState': {
          if (sourceId !== this.coordinator.clock.hostId) break;
          const rawTargets = frame.meta.targets;
          if (!isPlainRecord(rawTargets)) break;
          const entries = Object.entries(rawTargets);
          if (entries.length > MAX_TRACKED_PROJECT_ENTRIES) {
            throw new Error('Compute state exceeds the project entry limit.');
          }
          let changed = false;
          for (const [rawKey, rawTarget] of entries) {
            const notebookKey = rawKey === '*' ? '*' : normalizedTrackedPath(rawKey);
            const target = normalizeComputeTarget(rawTarget, sourceId);
            if (!notebookKey || !target || target.author !== sourceId
              || target.executorId !== this.coordinator.clock.hostId) continue;
            const current = this.computeForNotebook(notebookKey);
            const advance = target.epoch - current.epoch;
            if (advance < 0 || advance > MAX_REMOTE_REVISION_ADVANCE
              || compareComputeTarget(target, current) <= 0) continue;
            this.applyComputeTarget(notebookKey, target);
            changed = true;
          }
          if (changed) this.persistDescriptorInBackground();
          break;
        }
        case 'executeRequest':
          void this.handleExecutionRequest(frame, sourceId).catch((error) => {
            this.log.appendLine(`[error] Execute request: ${formatError(error)}`);
          });
          break;
        case 'executeAccepted': {
          const requestId = String(frame.meta.requestId ?? '');
          this.markRemoteExecutionAccepted(requestId, sourceId);
          break;
        }
        case 'executionEvent': {
          const requestId = String(frame.meta.requestId ?? '');
          const pending = this.pendingExecutions.get(requestId);
          if (pending && pending.executorId === sourceId) {
            this.markRemoteExecutionAccepted(requestId, sourceId);
            const decoded = decodeRemoteExecutionEvent(frame, requestId);
            if (!decoded) {
              this.rejectPendingRemoteExecution(requestId, pending, 'Remote executor sent a malformed Jupyter event.');
              break;
            }
            const rawSequence = frame.meta.eventSequence;
            if (rawSequence === undefined) {
              // Compatibility with pre-sequencing peers. Those events cannot be replayed.
              pending.onEvent(decoded.event);
              break;
            }
            const sequence = boundedNumber(rawSequence, 0, Number.MAX_SAFE_INTEGER, true);
            if (sequence === undefined) {
              this.rejectPendingRemoteExecution(requestId, pending, 'Remote executor sent an invalid Jupyter event sequence.');
              break;
            }
            try {
              this.acceptRemoteExecutionEvent(requestId, pending, sequence, decoded.event, decoded.byteLength);
            } catch (error) {
              this.rejectPendingRemoteExecution(requestId, pending, formatError(error));
            }
          }
          break;
        }
        case 'executeResult': {
          const requestId = String(frame.meta.requestId ?? '');
          const pending = this.pendingExecutions.get(requestId);
          if (pending && pending.executorId === sourceId) {
            const result = decodeRemoteExecutionResult(frame, requestId);
            if (result) {
              const rawEventCount = frame.meta.eventCount;
              const eventCount = rawEventCount === undefined
                ? undefined
                : boundedNumber(rawEventCount, 0, MAX_REPLAYED_EXECUTION_EVENTS, true);
              if (rawEventCount !== undefined && eventCount === undefined) {
                this.rejectPendingRemoteExecution(requestId, pending, 'Remote executor sent an invalid event count.');
              } else if (eventCount !== undefined && pending.nextEventSequence < eventCount) {
                pending.deferredResult = result;
                pending.expectedEventCount = eventCount;
              } else if (eventCount !== undefined && pending.nextEventSequence > eventCount) {
                this.rejectPendingRemoteExecution(requestId, pending, 'Remote executor sent an inconsistent event count.');
              } else {
                this.resolvePendingRemoteExecution(requestId, pending, sourceId, result);
              }
            } else {
              this.rejectPendingRemoteExecution(requestId, pending, 'Remote executor sent a malformed execution result.');
            }
          } else {
            const receipt = this.completedExecutionReceipts.get(requestId);
            if (receipt?.executorId === sourceId) this.acknowledgeExecutionResult(requestId, sourceId);
          }
          break;
        }
        case 'executeResultAck': {
          const requestId = String(frame.meta.requestId ?? '');
          const completed = this.completedRemoteExecutions.get(requestId);
          if (completed?.sourceId === sourceId) this.dropCompletedRemoteExecution(requestId);
          break;
        }
        case 'inputReply': {
          const requestId = String(frame.meta.requestId ?? '');
          const owner = this.executionOwners.get(requestId);
          const value = typeof frame.meta.value === 'string' ? frame.meta.value : '';
          const rawEventSequence = frame.meta.eventSequence;
          if (rawEventSequence === undefined) {
            // Compatibility with an unsequenced 0.5.3 input request.
            if (owner?.peerId === sourceId && value.length <= MAX_REMOTE_INPUT_CHARACTERS) {
              this.kernels.get(owner.notebookKey)?.inputReply(value);
            }
            break;
          }
          const eventSequence = boundedNumber(rawEventSequence, 0, MAX_REPLAYED_EXECUTION_EVENTS - 1, true);
          const digest = createHash('sha256').update(value, 'utf8').digest('hex');
          let success = false;
          let message = 'The input reply does not match an active Jupyter prompt.';
          if (eventSequence !== undefined && value.length <= MAX_REMOTE_INPUT_CHARACTERS
            && owner?.peerId === sourceId && owner.inputRequestSequences?.has(eventSequence)) {
            const previous = owner.inputReplyDigests?.get(eventSequence);
            if (previous === digest) {
              success = true;
              message = '';
            } else if (previous) {
              message = 'A different reply was already accepted for this Jupyter prompt.';
            } else {
              try {
                const kernel = this.kernels.get(owner.notebookKey);
                if (!kernel) throw new Error('The Jupyter kernel is no longer available for input.');
                kernel.inputReply(value);
                owner.inputReplyDigests?.set(eventSequence, digest);
                success = true;
                message = '';
              } catch (error) {
                message = formatError(error);
              }
            }
          } else if (eventSequence !== undefined && value.length <= MAX_REMOTE_INPUT_CHARACTERS) {
            const completed = this.completedRemoteExecutions.get(requestId);
            const previous = completed?.sourceId === sourceId
              ? completed.inputReplyDigests.get(eventSequence)
              : undefined;
            if (previous === digest) {
              success = true;
              message = '';
            } else if (previous) {
              message = 'A different reply was already accepted for this completed Jupyter prompt.';
            }
          }
          this.sendInputReplyAcknowledgement(sourceId, requestId, eventSequence, success, message);
          break;
        }
        case 'inputReplyAck': {
          const requestId = String(frame.meta.requestId ?? '');
          const eventSequence = boundedNumber(
            frame.meta.eventSequence,
            0,
            MAX_REPLAYED_EXECUTION_EVENTS - 1,
            true,
          );
          if (eventSequence === undefined) break;
          const key = inputReplyKey(requestId, eventSequence);
          const pending = this.pendingInputReplies.get(key);
          if (!pending || pending.executorId !== sourceId) break;
          clearTimeout(pending.timer);
          this.pendingInputReplies.delete(key);
          if (frame.meta.success === true) pending.resolve();
          else pending.reject(new Error(String(frame.meta.message ?? 'Remote Jupyter input was rejected.')));
          break;
        }
        case 'kernelCommand':
          await this.handleKernelCommand(frame, sourceId);
          break;
        case 'kernelCommandResult': {
          const requestId = String(frame.meta.requestId);
          const pending = this.pendingKernelCommands.get(requestId);
          if (pending && pending.executorId === sourceId) {
            clearTimeout(pending.timer);
            this.pendingKernelCommands.delete(requestId);
            if (frame.meta.success === true) pending.resolve();
            else pending.reject(new Error(String(frame.meta.message ?? 'Remote kernel command failed.')));
          }
          break;
        }
      }
    } catch (error) {
      this.log.appendLine(`[error] Message ${frame.type}: ${formatError(error)}`);
    }
  }

  private async sendProjectState(peerId: string): Promise<void> {
    for (const key of this.project.keys()) {
      const kind = this.project.kindOf(key);
      const fileState = this.fileStates.get(key);
      this.transport.sendTo(peerId, 'stateDocument', { key, kind, fileState }, this.project.encodeUpdate(key));
      this.transport.sendTo(peerId, 'stateVector', { key, kind, fileState }, this.project.encodeStateVector(key));
      await this.transport.awaitDrain(peerId);
    }
    await this.transport.awaitDrain(peerId, 0, 120_000, 0);
    this.transport.sendTo(peerId, 'stateEnd', {});
  }

  private async sendStateVectors(peerId: string): Promise<void> {
    let sent = 0;
    for (const key of this.project.keys()) {
      this.transport.sendTo(peerId, 'stateVector', {
        key,
        kind: this.project.kindOf(key),
        fileState: this.fileStates.get(key),
      }, this.project.encodeStateVector(key));
      sent += 1;
      if (sent % 256 === 0) await this.transport.awaitDrain(peerId);
    }
    await this.transport.awaitDrain(peerId);
  }

  private requestDocumentState(peerId: string, key: string, kind: DocumentKind): void {
    if (!this.project.has(key)) return;
    try {
      this.transport.sendTo(peerId, 'stateVector', {
        key,
        kind,
        fileState: this.effectiveFileState(key),
      }, this.project.encodeStateVector(key));
    } catch (error) {
      this.log.appendLine(`[debug] Could not request document state for ${key}: ${formatError(error)}`);
    }
  }

  private sendFilesystemState(peerId: string): void {
    const fileEntries = [...this.fileStates.entries()];
    const binaryEntries = [...this.binaryVersions.entries()];
    let fileStates = Object.create(null) as Record<string, FileLifecycleState>;
    let binaries = Object.create(null) as Record<string, BinaryFileVersion>;
    let bytes = 1024;
    let entries = 0;
    const flush = () => {
      if (!entries) return;
      this.transport.sendTo(peerId, 'filesystemState', { fileStates, binaries });
      fileStates = Object.create(null) as Record<string, FileLifecycleState>;
      binaries = Object.create(null) as Record<string, BinaryFileVersion>;
      bytes = 1024;
      entries = 0;
    };
    const append = <T>(kind: 'file' | 'binary', key: string, value: T) => {
      const entryBytes = metadataEntryBytes(key, value);
      if (entries && bytes + entryBytes > MAX_STATE_CHUNK_METADATA_BYTES) flush();
      if (entryBytes > MAX_STATE_CHUNK_METADATA_BYTES) {
        throw new Error(`Filesystem state entry is too large to send: ${key}`);
      }
      if (kind === 'file') fileStates[key] = value as FileLifecycleState;
      else binaries[key] = value as BinaryFileVersion;
      bytes += entryBytes;
      entries += 1;
    };
    for (const [key, value] of fileEntries) append('file', key, value);
    for (const [key, value] of binaryEntries) append('binary', key, value);
    flush();
  }

  private sendComputeState(peerId: string): void {
    let targets = Object.create(null) as Record<string, NotebookComputeTarget>;
    let bytes = 1024;
    let entries = 0;
    const flush = () => {
      if (!entries) return;
      this.transport.sendTo(peerId, 'computeState', { targets });
      targets = Object.create(null) as Record<string, NotebookComputeTarget>;
      bytes = 1024;
      entries = 0;
    };
    for (const [key, target] of Object.entries(this.descriptor.notebookCompute ?? {})) {
      const entryBytes = metadataEntryBytes(key, target);
      if (entries && bytes + entryBytes > MAX_STATE_CHUNK_METADATA_BYTES) flush();
      if (entryBytes > MAX_STATE_CHUNK_METADATA_BYTES) throw new Error(`Compute state entry is too large to send: ${key}`);
      targets[key] = target;
      bytes += entryBytes;
      entries += 1;
    }
    flush();
  }

  private applyComputeTarget(notebookKey: string, target: NotebookComputeTarget): void {
    const explicitBefore = new Set(Object.keys(this.descriptor.notebookCompute ?? {}).filter((key) => key !== '*'));
    this.computeEpoch = Math.max(this.computeEpoch, target.epoch);
    this.descriptor.notebookCompute = { ...(this.descriptor.notebookCompute ?? {}), [notebookKey]: target };
    if (notebookKey === '*') this.descriptor.computeExecutorId = target.executorId;

    const affected = notebookKey === '*'
      ? new Set([
        ...this.project.keys().filter((key) => this.project.kindOf(key) === 'notebook' && !explicitBefore.has(key)),
        ...[...this.kernels.keys()].filter((key) => !explicitBefore.has(key)),
        ...[...this.pendingExecutions.values()]
          .map((pending) => pending.notebookKey)
          .filter((key) => !explicitBefore.has(key)),
      ])
      : new Set([notebookKey]);
    for (const key of affected) {
      this.kernels.get(key)?.stop();
      this.kernels.delete(key);
      this.kernelLastUsed.delete(key);
      this.cancelNotebookExecutions(key, 'Compute changed; stale execution result discarded.');
      this.setKernelStatus(key, 'Offline');
    }
    if (notebookKey === '*') this.setKernelStatus('*', 'Offline');
    this.emit('computeChanged', target.executorId, notebookKey);
  }

  private async createStorage(): Promise<void> {
    this.storage = new StorageAdapter({
      workingRoot: this.descriptor.workingFolder,
      backingRoot: this.coordinator.isCurrentHost() && this.descriptor.backingFolder
        ? this.descriptor.backingFolder
        : undefined,
      debounceMs: vscode.workspace.getConfiguration('pairNotebook').get<number>('persistenceDebounceMs', 750),
      writeWorkingCopy: (relativePath, bytes) => this.writeWorkingCopy(relativePath, bytes),
      onWorkingCopyWrite: (relativePath, bytes) => this.rememberInternalWorkingWrite(relativePath, bytes),
      serialize: async (relativePath) => {
        const kind = this.project.kindOf(relativePath);
        if (kind === 'text') {
          const bytes = Buffer.from(this.project.text(relativePath).toString(), 'utf8');
          if (bytes.byteLength > MAX_TEXT_DOCUMENT_BYTES) {
            throw new Error(`${relativePath} exceeds the collaborative text-size limit after merging.`);
          }
          return bytes;
        }
        if (kind === 'notebook') return serializeIpynb(this.project.notebookSnapshot(relativePath));
        return readFile(path.join(this.descriptor.workingFolder, relativePath));
      },
    });
    this.storage.on('flushed', () => this.emit('storage'));
    this.storage.on('operationError', (error) => {
      this.log.appendLine(`[error] Persistence operation failed: ${formatError(error)}`);
      this.emit('storageError', error);
    });
  }

  private async onHostChanged(): Promise<void> {
    const isHost = this.coordinator.isCurrentHost();
    const wasHost = this.descriptor.role === 'host';
    const hostChanged = this.descriptor.hostPeerId !== this.coordinator.clock.hostId;
    const becameHost = isHost && !wasHost;
    this.storage?.setBackingRoot(undefined);
    if (!isHost || (hostChanged && becameHost)) {
      // A backing path is local to one computer and must never follow the role
      // to a different host (or be silently reused after a later transfer).
      this.descriptor.backingFolder = '';
    }
    this.descriptor.role = isHost ? 'host' : 'peer';
    this.descriptor.hostPeerId = this.coordinator.clock.hostId;
    this.descriptor.hostEpoch = this.coordinator.clock.hostEpoch;
    this.normalizeComputeTargetsForHost();
    if (hostChanged || becameHost) this.waitingForHostFolder = true;
    const pauseDetail = this.waitingForHostFolder
      ? isHost
        ? 'You are the new host. The session is paused until you choose a folder on this computer.'
        : 'The session is paused until the new host chooses a folder on their computer.'
      : undefined;
    // The transferred clock becomes observable immediately. Publish the matching
    // pause state before marker/autosave I/O so the UI can never briefly show a
    // reconnecting or ready session under a host that has no backing folder.
    if (pauseDetail) this.transition('waiting-for-host-folder', pauseDetail);
    await this.persistDescriptor();
    await this.refreshAutosaveManager();
    this.remoteRuntimePresence.clear();
    this.sendRuntimePresenceToAll();
    this.emit('hostChanged', this.coordinator.clock);
    if (pauseDetail) {
      this.emit('hostPaused', this.coordinator.clock);
      if (isHost) this.emit('hostFolderRequired', this.coordinator.clock);
      return;
    }
    this.storage?.setBackingRoot(isHost && this.descriptor.backingFolder ? this.descriptor.backingFolder : undefined);
    this.transition('ready', `Coordinator is ${this.coordinator.clock.hostId} at epoch ${this.coordinator.clock.hostEpoch}.`);
  }

  private normalizeComputeTargetsForHost(): void {
    const currentTargets = this.descriptor.notebookCompute ?? {};
    const nextTargets: Record<string, NotebookComputeTarget> = {};
    for (const notebookKey of Object.keys(currentTargets)) {
      nextTargets[notebookKey] = {
        executorId: this.coordinator.clock.hostId,
        device: 'cpu',
        epoch: 0,
        author: this.coordinator.clock.hostId,
      };
    }
    if (!nextTargets['*']) {
      nextTargets['*'] = {
        executorId: this.coordinator.clock.hostId,
        device: 'cpu',
        epoch: 0,
        author: this.coordinator.clock.hostId,
      };
    }
    this.computeEpoch = 0;
    this.descriptor.notebookCompute = nextTargets;
    this.descriptor.computeExecutorId = this.coordinator.clock.hostId;
    this.cancelNotebookExecutions('*', 'Host transferred; stale execution request discarded.');
    for (const key of this.kernels.keys()) {
      this.kernels.get(key)?.stop();
      this.setKernelStatus(key, 'Offline');
    }
    this.kernels.clear();
    this.kernelLastUsed.clear();
  }

  private async onHostStorageReady(sourceId: string): Promise<void> {
    if (sourceId !== this.coordinator.clock.hostId || !this.waitingForHostFolder) return;
    if (this.coordinator.isCurrentHost() && !this.descriptor.backingFolder) return;
    this.waitingForHostFolder = false;
    this.storage?.setBackingRoot(
      this.coordinator.isCurrentHost() && this.descriptor.backingFolder
        ? this.descriptor.backingFolder
        : undefined,
    );
    await this.refreshAutosaveManager();
    this.sendRuntimePresenceToAll();
    this.transition('ready', `Host storage is ready at epoch ${this.coordinator.clock.hostEpoch}.`);
    this.emit('hostResumed', this.coordinator.clock);
  }

  /**
   * Writes the complete authoritative project state (documents, binaries,
   * directories) into the backing folder and removes anything that is no longer
   * part of the project.  Public so the acceptance tests can exercise the exact
   * production barrier.
   */
  public async materializeBackingFolder(): Promise<void> {
    if (!this.storage || !this.coordinator.isCurrentHost() || !this.descriptor.backingFolder) return;
    const snapshot = await this.collectMaterialization();
    await this.storage.materializeBacking(snapshot.documents, snapshot.binaries, snapshot.directories);
  }

  private async materializeProjectFolder(targetFolder: string): Promise<void> {
    if (!this.storage || !this.coordinator.isCurrentHost()) {
      throw new Error('Only the current Session Host can create a local autosave.');
    }
    const snapshot = await this.collectMaterialization();
    await this.storage.materializeFolder(targetFolder, snapshot.documents, snapshot.binaries, snapshot.directories);
  }

  private async collectMaterialization(): Promise<{
    documents: Array<{ relativePath: string; bytes: Uint8Array }>;
    binaries: Array<{ relativePath: string; sourcePath: string; hash: string; size: number }>;
    directories: string[];
  }> {
    const documents: Array<{ relativePath: string; bytes: Uint8Array }> = [];
    const directories = new Set(
      [...this.directories].filter((directory) => !this.effectiveFileState(directory)?.deleted),
    );
    const rememberParents = (relativePath: string) => {
      const segments = relativePath.split('/');
      for (let length = 1; length < segments.length; length += 1) {
        directories.add(segments.slice(0, length).join('/'));
      }
    };
    for (const key of this.project.keys()) {
      const kind = this.project.kindOf(key);
      const state = this.effectiveFileState(key);
      if (state?.deleted || (state && state.kind !== kind)) continue;
      if (kind === 'text') {
        const bytes = Buffer.from(this.project.text(key).toString(), 'utf8');
        if (bytes.byteLength > MAX_TEXT_DOCUMENT_BYTES) {
          throw new Error(`${key} exceeds the collaborative text-size limit after merging.`);
        }
        documents.push({ relativePath: key, bytes });
      }
      else if (kind === 'notebook') documents.push({ relativePath: key, bytes: serializeIpynb(this.project.notebookSnapshot(key)) });
      rememberParents(key);
    }
    const binaries: Array<{ relativePath: string; sourcePath: string; hash: string; size: number }> = [];
    for (const [relativePath, version] of this.binaryVersions) {
      const state = this.effectiveFileState(relativePath);
      if (state?.deleted || (state && state.kind !== 'binary')) continue;
      const sourcePath = await safeProjectTarget(this.descriptor.workingFolder, relativePath, true);
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`Authoritative binary is not a regular file: ${relativePath}`);
      }
      const hash = await hashFile(sourcePath);
      if (hash !== version.hash) {
        throw new Error(`Authoritative binary changed before it could be materialized: ${relativePath}`);
      }
      binaries.push({ relativePath, sourcePath, hash, size: info.size });
      rememberParents(relativePath);
    }
    return { documents, binaries, directories: [...directories] };
  }

  public async setAutosaveFolder(folder: string): Promise<void> {
    if (!this.coordinator.isCurrentHost()) throw new Error('Only the current Session Host can choose the autosave disk.');
    const resolved = await this.assertAutosaveFolder(folder);
    await this.refreshAutosaveManager(resolved);
  }

  public async createAutosaveNow(): Promise<string> {
    if (!this.coordinator.isCurrentHost()) throw new Error('Only the current Session Host can create a local autosave.');
    if (!this.autosave) await this.refreshAutosaveManager();
    if (!this.autosave) throw new Error('Local autosaves are unavailable.');
    return this.autosave.runNow();
  }

  private async refreshAutosaveManager(folder?: string): Promise<void> {
    const explicitlySelected = folder !== undefined;
    const previous = this.autosave;
    this.autosave = undefined;
    if (previous) {
      previous.removeAllListeners();
      await previous.stop();
    }
    const configured = folder?.trim()
      || vscode.workspace.getConfiguration('pairNotebook').get<string>('autosaveFolder', '').trim()
      || defaultAutosaveRoot();
    let autosaveFolder = path.resolve(configured);
    this.autosaveState = {
      enabled: false,
      folder: autosaveFolder,
      intervalMs: AUTOSAVE_INTERVAL_MS,
      retention: AUTOSAVE_RETENTION,
      copies: 0,
      lastAt: 0,
      nextAt: 0,
    };
    if (!this.coordinator.isCurrentHost() || this.waitingForHostFolder || !this.descriptor.backingFolder || this.closed) {
      this.emit('autosave', this.autosaveState);
      return;
    }
    try {
      autosaveFolder = await this.assertAutosaveFolder(autosaveFolder);
      this.autosaveState.folder = autosaveFolder;
      const manager = new LocalAutosaveManager({
        root: autosaveFolder,
        sessionId: this.descriptor.sessionId,
        projectName: this.descriptor.projectName,
        writeSnapshot: (targetFolder) => this.materializeProjectFolder(targetFolder),
      });
      manager.on('state', (state: AutosaveStatus) => {
        const previousError = this.autosaveState.lastError;
        this.autosaveState = state;
        if (state.lastError && state.lastError !== previousError) {
          this.log.appendLine(`[error] Local autosave: ${state.lastError}`);
        }
        this.emit('autosave', state);
      });
      await manager.start();
      this.autosave = manager;
      this.autosaveState = manager.status();
    } catch (error) {
      const detail = formatError(error);
      this.autosaveState = { ...this.autosaveState, enabled: false, nextAt: 0, lastError: detail };
      this.log.appendLine(`[error] Local autosave is disabled: ${detail}`);
      this.emit('autosave', this.autosaveState);
      if (explicitlySelected) throw error;
    }
  }

  private async assertAutosaveFolder(folder: string): Promise<string> {
    const [resolved, workingFolder, backingFolder] = await Promise.all([
      canonicalFolderPath(folder),
      canonicalFolderPath(this.descriptor.workingFolder),
      this.descriptor.backingFolder ? canonicalFolderPath(this.descriptor.backingFolder) : Promise.resolve(''),
    ]);
    if (pathsOverlap(resolved, workingFolder)) {
      throw new Error('The autosave folder must be outside the isolated working copy.');
    }
    if (backingFolder && pathsOverlap(resolved, backingFolder)) {
      throw new Error('The autosave folder must be separate from the shared Dropbox backing folder.');
    }
    return resolved;
  }


  private coordinationTick(): void {
    for (const peer of this.transport.peerRuntime()) {
      this.coordinator.upsertPeer(peer);
      this.assignedJoinOrders.set(peer.peerId, peer.joinOrder);
    }
    this.coordinator.evaluate();
    if (this.coordinator.closed && !this.closed) {
      // Host loss is not an explicit session-end message. The terminal event
      // below is the single lifecycle source for UI cleanup and notification.
      this.runBackground('Host-only session shutdown', () => this.disposeAsync('host-unreachable'));
    }
  }

  private async checkTerminationMarker(): Promise<boolean> {
    if (this.closed || this.terminationCheckInFlight
      || (this.endingSession && this.coordinator.isCurrentHost())) return false;
    this.terminationCheckInFlight = true;
    try {
      const termination = await readSessionTermination(this.descriptor, this.token);
      if (!termination || this.closed) return false;
      const endedBy = this.transport.peerRuntime().find((peer) => peer.peerId === termination.endedByPeerId)
        ?? (this.descriptor.knownPeers ?? []).find((peer) => peer.peerId === termination.endedByPeerId)
        ?? {
          ...this.descriptor.localPeer,
          peerId: termination.endedByPeerId,
          displayName: termination.endedByDisplayName,
        };
      this.emit('sessionEnded', endedBy, 'explicit-end');
      await this.disposeAsync('session-ended');
      return true;
    } catch (error) {
      this.log.appendLine(`[debug] Could not check the shared session-end marker: ${formatError(error)}`);
      return false;
    } finally {
      this.terminationCheckInFlight = false;
    }
  }

  private async resourceTick(): Promise<void> {
    if (this.resourceSampleInFlight || this.closed) return;
    this.resourceSampleInFlight = true;
    try {
      const result = await sampleResources(this.cpuUsage);
      this.cpuUsage = result.cpu;
      this.resources = result.sample;
      this.publishResourcePresence();
    } finally {
      this.resourceSampleInFlight = false;
    }
  }

  /** Publishes only semantic file/cell/line presence plus renderer metadata. */
  private updatePresence(): void {
    const configuration = vscode.workspace.getConfiguration('pairNotebook');
    const requestedDisplayName = configuration.get<string>('displayName', '').trim()
      || this.descriptor.localPeer.displayName
      || os.userInfo().username;
    const desiredDisplayName = cleanDisplayName(requestedDisplayName);
    const displayNameError = validateDisplayName(desiredDisplayName);
    if (displayNameError) {
      const warning = `Invalid configured display name: ${displayNameError}`;
      if (warning !== this.lastDisplayNameWarning) this.log.appendLine(`[error] ${warning}`);
      this.lastDisplayNameWarning = warning;
    } else if (desiredDisplayName !== this.descriptor.localPeer.displayName) {
      try {
        this.transport.updateLocalPeer({ ...this.descriptor.localPeer, displayName: desiredDisplayName });
        this.lastDisplayNameWarning = '';
        this.persistDescriptorInBackground();
      } catch (error) {
        const warning = formatError(error);
        if (warning !== this.lastDisplayNameWarning) this.log.appendLine(`[error] Display name was not changed: ${warning}`);
        this.lastDisplayNameWarning = warning;
      }
    }
    // Presence is now line-only. Keep the legacy wire fields fixed so older
    // participants can still see activity, but no local setting can turn a
    // line lock into an unannounced editable cursor.
    const shareCursor = true;
    const cursorColor = '#4FC3F7';
    const activeText = vscode.window.activeTextEditor;
    const activeNotebook = vscode.window.activeNotebookEditor;
    let activeFile: string | undefined;
    let activeNotebookCellId: string | undefined;
    let activeLine: number | undefined;
    let activeLineAnchor: string | undefined;
    const notebookKey = activeNotebook ? this.relativeKey(activeNotebook.notebook.uri) : undefined;
    if (activeNotebook && notebookKey) {
      activeFile = notebookKey;
      const selectedIndex = activeNotebook.selection.start;
      const focusedCell = activeText?.document.uri.scheme === 'vscode-notebook-cell'
        ? activeNotebook.notebook.getCells?.().find((cell) =>
          cell.document.uri.toString() === activeText.document.uri.toString())
        : undefined;
      const selectedIndexIsValid = Number.isInteger(selectedIndex)
        && selectedIndex >= 0
        && (typeof activeNotebook.notebook.cellCount !== 'number' || selectedIndex < activeNotebook.notebook.cellCount);
      const selectedCell = focusedCell
        ?? (selectedIndexIsValid ? activeNotebook.notebook.cellAt(selectedIndex) : undefined);
      if (selectedCell) activeNotebookCellId = this.notebookCellId(selectedCell);
      if (selectedCell && activeText?.document.uri.toString() === selectedCell.document.uri.toString()) {
        activeLine = lineFromSelection(activeText.selection.active);
        activeLineAnchor = this.lineAnchorForEditor(activeText.document, activeLine, notebookKey, activeNotebookCellId);
      }
    } else if (activeText) {
      const textKey = this.relativeKey(activeText.document.uri);
      if (textKey) {
        activeFile = textKey;
        activeLine = lineFromSelection(activeText.selection.active);
        activeLineAnchor = this.lineAnchorForEditor(activeText.document, activeLine, textKey, undefined);
      }
    }
    const displayName = this.descriptor.localPeer.displayName;
    if (this.semanticPresencePublished
      && this.lastPublishedActiveFile === activeFile
      && this.lastPublishedActiveNotebookCellId === activeNotebookCellId
      && this.lastPublishedActiveLine === activeLine
      && this.lastPublishedActiveLineAnchor === activeLineAnchor
      && this.lastPublishedShareCursor === shareCursor
      && this.lastPublishedCursorColor === cursorColor
      && this.lastPublishedDisplayName === displayName) return;
    this.semanticPresencePublished = true;
    this.lastPublishedActiveFile = activeFile;
    this.lastPublishedActiveNotebookCellId = activeNotebookCellId;
    this.lastPublishedActiveLine = activeLine;
    this.lastPublishedActiveLineAnchor = activeLineAnchor;
    this.lastPublishedShareCursor = shareCursor;
    this.lastPublishedCursorColor = cursorColor;
    this.lastPublishedDisplayName = displayName;
    // Deliberately no cursor offsets/anchors/columns/selections and no compute telemetry.
    this.awareness.setLocalState({
      peer: this.descriptor.localPeer,
      activeFile,
      activeNotebookCellId,
      activeLine,
      activeLineAnchor,
      shareCursor,
      cursorColor,
      typing: false,
    });
  }

  private lineAnchorForEditor(
    document: vscode.TextDocument,
    line: number | undefined,
    key: string,
    cellId: string | undefined,
  ): string | undefined {
    if (line === undefined || typeof document.offsetAt !== 'function') return undefined;
    try {
      return encodeRelativeOffset(this.presenceText(key, cellId) ?? new Y.Text(), document.offsetAt(new vscode.Position(line, 0)));
    } catch {
      return undefined;
    }
  }

  private publishResourcePresence(peerId?: string): void {
    const now = Date.now();
    if (!peerId && now - this.lastResourcePublishedAt < RESOURCE_SAMPLE_INTERVAL_MS) return;
    if (!peerId) this.lastResourcePublishedAt = now;
    const meta = { resources: this.coordinator.isCurrentHost() ? this.resources ?? null : null };
    if (peerId) this.transport.sendTo(peerId, 'resourcePresence', meta);
    else this.transport.broadcast('resourcePresence', meta);
    this.emit('resources', this.resources);
  }

  private publishHardwarePresence(peerId?: string): void {
    const meta = this.coordinator.isCurrentHost()
      ? { hardware: this.hardware ?? null, environments: this.environments }
      : { hardware: null, environments: [] };
    if (peerId) this.transport.sendTo(peerId, 'hardwarePresence', meta);
    else this.transport.broadcast('hardwarePresence', meta);
  }

  private publishKernelPresence(peerId?: string): void {
    const meta = this.coordinator.isCurrentHost()
      ? { kernelStatus: this.kernelStatus, kernelStatuses: Object.fromEntries(this.kernelStatuses) }
      : { kernelStatus: 'Offline' as const, kernelStatuses: {} };
    if (peerId) this.transport.sendTo(peerId, 'kernelPresence', meta);
    else this.transport.broadcast('kernelPresence', meta);
  }

  private sendRuntimePresence(peerId: string): void {
    this.publishHardwarePresence(peerId);
    this.publishResourcePresence(peerId);
    this.publishKernelPresence(peerId);
  }

  private sendRuntimePresenceToAll(): void {
    this.publishHardwarePresence();
    this.lastResourcePublishedAt = 0;
    this.publishResourcePresence();
    this.publishKernelPresence();
  }

  private acceptHardwarePresence(frame: WireFrame, sourceId: string): void {
    if (sourceId !== this.coordinator.clock.hostId) return;
    const hardware = frame.meta.hardware === null ? undefined : sanitizeHardware(frame.meta.hardware);
    const environments = sanitizeEnvironments(frame.meta.environments) ?? [];
    if (frame.meta.hardware !== null && !hardware) throw new Error('Peer sent malformed hardware presence.');
    const previous = this.remoteRuntimePresence.get(sourceId) ?? {};
    this.remoteRuntimePresence.set(sourceId, { ...previous, hardware, environments });
    this.emit('hardware', hardware);
  }

  private acceptResourcePresence(frame: WireFrame, sourceId: string): void {
    if (sourceId !== this.coordinator.clock.hostId) return;
    const resources = frame.meta.resources === null ? undefined : sanitizeResources(frame.meta.resources);
    if (frame.meta.resources !== null && !resources) throw new Error('Peer sent malformed resource presence.');
    const previous = this.remoteRuntimePresence.get(sourceId) ?? {};
    this.remoteRuntimePresence.set(sourceId, { ...previous, resources });
    this.emit('resources', resources);
  }

  private acceptKernelPresence(frame: WireFrame, sourceId: string): void {
    if (sourceId !== this.coordinator.clock.hostId) return;
    const kernelStatus = normalizeKernelStatus(frame.meta.kernelStatus);
    if (!kernelStatus) throw new Error('Peer sent malformed kernel presence.');
    const kernelStatuses = sanitizeKernelStatuses(frame.meta.kernelStatuses);
    const previous = this.remoteRuntimePresence.get(sourceId) ?? {};
    this.remoteRuntimePresence.set(sourceId, { ...previous, kernelStatus, kernelStatuses });
    this.emit('kernel', kernelStatus, '*');
  }

  private presenceText(key: string, cellId?: string): Y.Text | undefined {
    if (!this.project.has(key)) return undefined;
    const kind = this.project.kindOf(key);
    if (kind === 'text' && cellId === undefined) return this.project.text(key);
    if (kind !== 'notebook' || !cellId) return undefined;
    try {
      return this.project.cellSource(key, cellId);
    } catch {
      return undefined;
    }
  }

  private presenceLineStart(state: PresenceState, source: string): number | undefined {
    const offset = this.resolvePresenceLineOffset(state)
      ?? offsetForLine(source, state.activeLine);
    return offset === undefined ? undefined : lineStartOffset(source, offset);
  }

  private async onCreatedFromExplorer(uri: vscode.Uri): Promise<void> {
    try {
      if ((await stat(uri.fsPath)).isDirectory()) await this.onLocalDirectory(uri);
    } catch {
      // The generic watcher will handle files that still exist.
    }
  }

  private async onLocalDirectory(uri: vscode.Uri): Promise<void> {
    const relativePath = this.relativeKey(uri);
    if (!relativePath) return;
    try {
      const target = await safeProjectTarget(this.descriptor.workingFolder, relativePath, true);
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isDirectory()) return;
    } catch {
      return;
    }
    const previous = this.effectiveFileState(relativePath);
    const state = this.ensureLiveFileState(relativePath, 'directory');
    this.directories.add(relativePath);
    if (!previous || previous.deleted || previous.kind !== 'directory') {
      this.transport.broadcast('directoryCreate', { relativePath, state });
      if (this.coordinator.isCurrentHost()) await this.storage?.createDirectory(relativePath);
      await this.persistDescriptor();
    }
  }

  private renameNotebookRuntimeState(from: string, to: string): void {
    const moved = (key: string) => key === from ? to : key.startsWith(`${from}/`) ? `${to}${key.slice(from.length)}` : key;
    const move = <T>(map: Map<string, T>, replace?: (value: T) => void) => {
      for (const [key, value] of [...map]) {
        const next = moved(key);
        if (next === key) continue;
        const previous = map.get(next);
        if (previous !== undefined && previous !== value) replace?.(previous);
        map.delete(key);
        map.set(next, value);
      }
    };
    move(this.kernels, (kernel) => kernel.stop());
    move(this.kernelStatuses);
    move(this.kernelLastUsed);
    move(this.notebookActiveExecutions);
    for (const owner of this.executionOwners.values()) owner.notebookKey = moved(owner.notebookKey);
    for (const pending of this.pendingExecutions.values()) pending.notebookKey = moved(pending.notebookKey);
    for (const settings of [this.descriptor.notebookCompute, this.descriptor.notebookPythonPaths]) {
      if (!settings) continue;
      for (const key of Object.keys(settings)) {
        const next = moved(key);
        if (next === key) continue;
        Object.assign(settings, { [next]: settings[key] });
        delete settings[key];
      }
    }
  }

  private async onLocalRename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    const rawFrom = this.relativeKey(oldUri, true);
    const rawTo = this.relativeKey(newUri, true);
    if (!rawFrom || !rawTo || rawFrom === rawTo) return;
    if (relativePathsNested(rawFrom, rawTo)) {
      this.log.appendLine('[error] Ignored a project rename whose source and destination overlap.');
      return;
    }
    const fromTracked = shouldTrackProjectPath(rawFrom);
    const toTracked = shouldTrackProjectPath(rawTo);
    if (fromTracked && !toTracked) {
      await this.applyLocalDeletion(rawFrom);
      return;
    }
    if (!fromTracked && toTracked) {
      await this.onLocalFile(newUri, 'create');
      return;
    }
    if (!fromTracked || !toTracked) return;

    const kind = this.effectiveFileState(rawFrom)?.kind
      ?? this.fileStates.get(rawFrom)?.kind
      ?? (this.directories.has(rawFrom) ? 'directory' : this.binaryVersions.has(rawFrom) ? 'binary' : 'text');
    const fromState = this.nextFileState(kind, true);
    const toState = this.nextFileState(kind, false);

    this.renameFileStates(rawFrom, rawTo, fromState, toState);
    this.renameNotebookRuntimeState(rawFrom, rawTo);
    this.project.renameDocument(rawFrom, rawTo);
    this.renameBinaryVersions(rawFrom, rawTo);
    this.renameDirectories(rawFrom, rawTo);
    this.recordRenameOrigin(rawFrom, rawTo, toState);
    this.transport.broadcast('fileRename', { from: rawFrom, to: rawTo, fromState, toState });

    if (this.coordinator.isCurrentHost()) await this.storage?.rename(rawFrom, rawTo, true);
    await this.persistDescriptor();
  }

  private async onLocalFile(uri: vscode.Uri, operation: 'create' | 'change'): Promise<void> {
    const relativePath = this.relativeKey(uri);
    if (!relativePath) return;
    // Open editors are already observed through VS Code's document APIs. Reading
    // their just-saved disk image here can race with a newer keystroke and
    // mistakenly roll the CRDT back to the older serialized notebook.
    if (operation === 'change' && this.isOpenInEditor(relativePath)) return;
    let absolutePath: string;
    let info;
    try {
      absolutePath = await safeProjectTarget(this.descriptor.workingFolder, relativePath, true);
      info = await lstat(absolutePath);
    } catch { return; }
    // A symlink (including one in a parent directory) could otherwise make a
    // watcher event publish files from outside the shared project.
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      if (operation === 'create') await this.onLocalDirectory(uri);
      return;
    }
    if (!info.isFile()) return;
    if (info.size > MAX_TRANSFER_BYTES) {
      throw new Error(`Project file exceeds the ${MAX_TRANSFER_BYTES}-byte transfer limit: ${relativePath}`);
    }
    // Only collaborative documents are read into memory; a binary of any size
    // is hashed and sent as a stream instead.
    let kind = classifyFile(relativePath, info.size);
    let bytes: Buffer | undefined;
    let decodedText: string | undefined;
    let notebookSnapshot: ReturnType<typeof parseIpynb> | undefined;
    if (kind === 'text' || kind === 'notebook') {
      try { bytes = await readFile(absolutePath); } catch { return; }
      if (this.matchesInternalWorkingWrite(relativePath, bytes)) return;
      decodedText = decodeUtf8ProjectFile(bytes);
      if (decodedText === undefined) kind = 'binary';
      else if (kind === 'notebook') {
        try {
          notebookSnapshot = parseIpynb(decodedText);
        } catch {
          kind = 'binary';
        }
      }
    }
    const previousState = this.effectiveFileState(relativePath);
    const lifecycleChanged = !previousState || previousState.deleted || previousState.kind !== kind;
    const state = this.ensureLiveFileState(relativePath, kind);
    if (lifecycleChanged) this.transport.broadcast('fileState', { relativePath, state });

    if (kind === 'text' && decodedText !== undefined) {
      this.deleteBinaryVersions(relativePath);
      const value = decodedText;
      if (!this.project.has(relativePath) || this.project.kindOf(relativePath) !== 'text') {
        this.project.deleteDocument(relativePath);
        this.project.ensureText(relativePath);
      }
      if (this.project.text(relativePath).toString() !== value) this.project.replaceText(relativePath, value);
      else if (lifecycleChanged) this.storage?.schedule(relativePath);
    } else if (kind === 'notebook' && notebookSnapshot) {
      this.deleteBinaryVersions(relativePath);
      const snapshot = notebookSnapshot;
      if (!this.project.has(relativePath) || this.project.kindOf(relativePath) !== 'notebook') {
        this.project.deleteDocument(relativePath);
        this.project.ensureNotebook(relativePath, snapshot);
      } else if (JSON.stringify(this.project.notebookSnapshot(relativePath)) !== JSON.stringify(snapshot)) {
        this.project.reconcileNotebook(relativePath, snapshot);
      } else if (lifecycleChanged) this.storage?.schedule(relativePath);
    } else if (kind === 'binary') {
      this.project.deleteDocument(relativePath);
      let lastChangeError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const currentInfo = await lstat(absolutePath);
          if (currentInfo.isSymbolicLink() || !currentInfo.isFile()) return;
          if (currentInfo.size > MAX_TRANSFER_BYTES) {
            throw new Error(`Project file exceeds the ${MAX_TRANSFER_BYTES}-byte transfer limit: ${relativePath}`);
          }
          const hash = await hashFile(absolutePath);
          if (this.binaryVersions.get(relativePath)?.hash === hash) break;
          await this.broadcastBinary(relativePath, absolutePath, hash, currentInfo.size);
          lastChangeError = undefined;
          break;
        } catch (error) {
          lastChangeError = error;
          if (!/changed while/i.test(formatError(error)) || attempt === 2) throw error;
        }
      }
      if (lastChangeError) throw lastChangeError;
    }
    if (lifecycleChanged) await this.persistDescriptor();
  }

  private async onLocalDelete(uri: vscode.Uri): Promise<void> {
    const relativePath = this.relativeKey(uri, true);
    if (!relativePath || !shouldTrackProjectPath(relativePath)) return;
    // Windows atomic replacement may briefly emit a delete between removing the
    // old target and renaming the completed temporary file. If the path exists
    // again by the time the watcher runs, it was not a user deletion.
    try {
      await stat(uri.fsPath);
      return;
    } catch {
      // The path is genuinely absent.
    }
    if (this.consumeSuppressedDelete(relativePath)) return;
    await this.applyLocalDeletion(relativePath);
  }

  private async applyLocalDeletion(relativePath: string): Promise<void> {
    const tracked = this.project.has(relativePath)
      || [...this.binaryVersions.keys()].some((key) => key === relativePath || key.startsWith(`${relativePath}/`))
      || [...this.directories].some((key) => key === relativePath || key.startsWith(`${relativePath}/`))
      || Boolean(this.effectiveFileState(relativePath));
    if (!tracked) return;
    const kind = this.effectiveFileState(relativePath)?.kind
      ?? (this.directories.has(relativePath) ? 'directory' : this.binaryVersions.has(relativePath) ? 'binary' : 'text');
    const state = this.nextFileState(kind, true);
    this.setFileState(relativePath, state);
    await this.applyDeletedPath(relativePath, false);
    this.transport.broadcast('fileDelete', { relativePath, state });
    await this.persistDescriptor();
  }

  /**
   * Publishes a local binary to every peer by streaming it from disk: only one
   * chunk is ever held in memory, regardless of the file size.
   */
  private async broadcastBinary(relativePath: string, absolutePath: string, hash: string, size: number): Promise<void> {
    const transferId = newId();
    const chunkSize = BINARY_CHUNK_SIZE;
    const chunks = Math.max(1, Math.ceil(size / chunkSize));
    const previous = this.binaryVersions.get(relativePath);
    if (previous && previous.hash !== hash && previous.version >= Number.MAX_SAFE_INTEGER) {
      throw new Error(`Binary revision counter reached its supported limit: ${relativePath}`);
    }
    const version: BinaryFileVersion = previous?.hash === hash
      ? previous
      : { hash, version: (previous?.version ?? 0) + 1, author: this.descriptor.localPeer.peerId };
    const state = this.ensureLiveFileState(relativePath, 'binary');
    this.transport.broadcast('binaryStart', {
      transferId, relativePath, chunks, chunkSize, hash, version: version.version, author: version.author, size, fileState: state,
    });
    try {
      await this.streamFileChunks(absolutePath, chunks, chunkSize, size, hash, (index, chunk) => {
        this.transport.broadcast('binaryChunk', { transferId, index }, chunk);
        // Flow control: never queue an unbounded amount of a large file.
      }, () => this.transport.awaitDrainAll());
      // The host's durable copy is committed before receivers are allowed to
      // publish the transfer. A concurrent local rewrite fails hash validation
      // and causes the whole transfer to be retried from the new contents.
      if (this.coordinator.isCurrentHost()) {
        await this.storage?.mirrorBinaryToBacking(relativePath, hash);
      }
      this.binaryVersions.set(relativePath, version);
      this.transport.broadcast('binaryEnd', { transferId });
    } catch (error) {
      this.transport.broadcast('binaryAbort', { transferId });
      throw error;
    }
    await this.persistDescriptor();
  }

  /**
   * Reads a file chunk by chunk into a single reusable buffer and hands each
   * chunk to `send`, awaiting `drain` in between.  The wire encoder copies the
   * payload, so reusing the buffer is safe.
   */
  private async streamFileChunks(
    absolutePath: string,
    chunks: number,
    chunkSize: number,
    expectedSize: number,
    expectedHash: string,
    send: (index: number, chunk: Buffer) => void,
    drain: () => Promise<void>,
  ): Promise<void> {
    const handle = await open(absolutePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(chunkSize);
      const hash = createHash('sha256');
      for (let index = 0; index < chunks; index += 1) {
        const { bytesRead } = await handle.read(buffer, 0, chunkSize, index * chunkSize);
        const expectedBytes = index === chunks - 1
          ? expectedSize - index * chunkSize
          : chunkSize;
        if (bytesRead !== expectedBytes) {
          throw new Error(`Binary changed while being streamed: ${absolutePath}`);
        }
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        send(index, chunk);
        await drain();
      }
      const finalInfo = await handle.stat();
      if (finalInfo.size !== expectedSize || hash.digest('hex') !== expectedHash) {
        throw new Error(`Binary changed while being streamed: ${absolutePath}`);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * Cell payload deletion is irreversible for an absent peer, so it is only
   * allowed while every known participant has been continuously connected for a
   * full grace period.
   */
  private isGarbageCollectionSafe(now: number): boolean {
    const online = new Set(this.transport.peerRuntime().filter((peer) => peer.online).map((peer) => peer.peerId));
    const absent = (this.descriptor.knownPeers ?? [])
      .some((peer) => peer.peerId !== this.descriptor.localPeer.peerId && !online.has(peer.peerId));
    if (absent) {
      this.fullPresenceSince = 0;
      return false;
    }
    if (!this.fullPresenceSince) {
      this.fullPresenceSince = now;
      return false;
    }
    return now - this.fullPresenceSince >= CELL_GC_GRACE_MS;
  }

  /**
   * Deletes `.part` files left behind by a crash.  A completed transfer always
   * consumes its temporary file, so anything found at startup is stale.
   */
  private async sweepTransferDirectory(): Promise<void> {
    const directory = await safeProjectTarget(this.descriptor.workingFolder, TRANSFER_DIRECTORY, true);
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.part')) continue;
      await rm(path.join(directory, entry), { force: true }).catch(() => undefined);
    }
  }

  /** Removes the transfer scratch directory during shutdown. */
  private async removeTransferDirectory(): Promise<void> {
    await rm(await safeProjectTarget(this.descriptor.workingFolder, TRANSFER_DIRECTORY, true), { recursive: true, force: true });
  }


  private ensureLiveFileState(relativePath: string, kind: FileLifecycleState['kind']): FileLifecycleState {
    const exact = this.fileStates.get(relativePath);
    const effective = this.effectiveFileState(relativePath);
    if (exact && !exact.deleted && exact.kind === kind && effective === exact) return exact;
    this.assertNoPortableLivePathConflict(relativePath);
    const state = this.nextFileState(kind, false);
    this.setFileState(relativePath, state);
    return state;
  }

  private assertNoPortableLivePathConflict(relativePath: string): void {
    const knownPaths = new Set([
      ...this.fileStates.keys(),
      ...this.project.keys(),
      ...this.binaryVersions.keys(),
      ...this.directories,
    ]);
    for (const existingPath of knownPaths) {
      if (existingPath === relativePath || !portablePathCaseConflict(existingPath, relativePath)) continue;
      const lifecycle = this.effectiveFileState(existingPath);
      const structurallyLive = this.project.has(existingPath)
        || this.binaryVersions.has(existingPath)
        || this.directories.has(existingPath);
      if (lifecycle ? !lifecycle.deleted : structurallyLive) {
        throw new Error(
          `Project path conflicts by portable spelling with an existing path: ${existingPath}, ${relativePath}`,
        );
      }
    }
  }

  private setFileState(relativePath: string, state: FileLifecycleState): void {
    if (!this.fileStates.has(relativePath) && this.fileStates.size >= MAX_TRACKED_PROJECT_ENTRIES) {
      throw new Error(`Session exceeds the ${MAX_TRACKED_PROJECT_ENTRIES}-entry project limit.`);
    }
    this.fileStates.set(relativePath, state);
  }

  private nextFileState(
    kind: FileLifecycleState['kind'],
    deleted: boolean,
    author = this.descriptor.localPeer.peerId,
  ): FileLifecycleState {
    if (this.fileRevisionCounter >= Number.MAX_SAFE_INTEGER - 1) {
      throw new Error('Project revision counter reached its supported limit.');
    }
    this.fileRevisionCounter += 1;
    return { version: this.fileRevisionCounter, author, kind, deleted };
  }

  private effectiveFileState(relativePath: string): FileLifecycleState | undefined {
    let winner = this.fileStates.get(relativePath);
    const parts = relativePath.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const ancestor = this.fileStates.get(parts.slice(0, index).join('/'));
      if (!ancestor?.deleted) continue;
      if (!winner || compareFileState(ancestor, winner) > 0) winner = ancestor;
    }
    return winner;
  }

  private async acceptFileState(
    relativePath: string,
    incoming: FileLifecycleState,
    sourceId: string,
    applyEffects = true,
    propagate = true,
  ): Promise<boolean> {
    const normalizedPath = normalizedTrackedPath(relativePath);
    if (!normalizedPath) {
      this.log.appendLine(`[error] Refusing file state with an unsafe project path from ${sourceId}.`);
      return false;
    }
    relativePath = normalizedPath;
    if (sourceId !== this.descriptor.localPeer.peerId
      && incoming.version > this.fileRevisionCounter + MAX_REMOTE_REVISION_ADVANCE) {
      this.log.appendLine(`[error] Refusing implausible file revision ${incoming.version} from ${sourceId}.`);
      return false;
    }
    const effective = this.effectiveFileState(relativePath);
    if (effective && compareFileState(incoming, effective) < 0) return false;
    const exact = this.fileStates.get(relativePath);
    const changed = !exact || compareFileState(incoming, exact) !== 0
      || exact.deleted !== incoming.deleted || exact.kind !== incoming.kind;
    if (changed) {
      if (!incoming.deleted && applyEffects) this.assertNoPortableLivePathConflict(relativePath);
      this.setFileState(relativePath, incoming);
      this.fileRevisionCounter = Math.max(this.fileRevisionCounter, incoming.version);
      if (applyEffects) {
        if (incoming.deleted) await this.applyDeletedPath(relativePath);
        else await this.ensureLivePathMaterialized(relativePath, incoming);
      }
      if (propagate) this.transport.broadcast('fileState', { relativePath, state: incoming });
      await this.persistDescriptor();
    }
    const winner = this.effectiveFileState(relativePath);
    return Boolean(winner && compareFileState(incoming, winner) === 0);
  }

  private async ensureLivePathMaterialized(relativePath: string, state: FileLifecycleState): Promise<void> {
    const previousKind = this.project.kindOf(relativePath);
    if (previousKind && previousKind !== state.kind) this.project.deleteDocument(relativePath);
    if (state.kind !== 'binary') this.deleteBinaryVersions(relativePath);
    if (state.kind !== 'directory') this.directories.delete(relativePath);
    if (state.kind === 'directory') {
      this.directories.add(relativePath);
      await this.storage?.createDirectory(relativePath);
    } else if (state.kind === 'text') {
      if (!this.project.has(relativePath)) this.project.ensureText(relativePath);
      this.storage?.schedule(relativePath);
    } else if (state.kind === 'notebook') {
      if (!this.project.has(relativePath)) this.project.ensureNotebook(relativePath);
      this.storage?.schedule(relativePath);
    }
  }

  private async applyDeletedPath(relativePath: string, suppressWatcher = true): Promise<void> {
    if (suppressWatcher) this.suppressDelete(relativePath);
    this.project.deleteDocument(relativePath);
    this.deleteBinaryVersions(relativePath);
    this.deleteDirectories(relativePath);
    await this.storage?.remove(relativePath);
  }

  private suppressDelete(relativePath: string): void {
    this.suppressedDeletes.set(relativePath, Date.now() + 5000);
  }

  private consumeSuppressedDelete(relativePath: string): boolean {
    const now = Date.now();
    for (const [key, expiresAt] of [...this.suppressedDeletes]) {
      if (expiresAt <= now) {
        this.suppressedDeletes.delete(key);
        continue;
      }
      if (relativePath === key || relativePath.startsWith(`${key}/`)) {
        this.suppressedDeletes.delete(key);
        return true;
      }
    }
    return false;
  }

  private renameFileStates(
    from: string,
    to: string,
    fromState: FileLifecycleState,
    toState: FileLifecycleState,
  ): void {
    const descendants = [...this.fileStates.entries()]
      .filter(([key]) => key !== from && key.startsWith(`${from}/`));
    // Tombstone the complete old tree before publishing any destination path.
    // This ordering permits a case-only directory rename while still rejecting
    // an unrelated live tree that differs only by path casing.
    for (const [oldKey, state] of descendants) {
      this.setFileState(oldKey, {
        version: Math.max(state.version, fromState.version),
        author: fromState.author,
        kind: state.kind,
        deleted: true,
      });
    }
    this.setFileState(from, fromState);
    for (const [oldKey, state] of descendants) {
      const suffix = oldKey.slice(from.length);
      const newKey = `${to}${suffix}`;
      this.assertNoPortableLivePathConflict(newKey);
      this.setFileState(newKey, state.deleted ? {
        version: Math.max(state.version, toState.version),
        author: toState.author,
        kind: state.kind,
        deleted: true,
      } : {
        version: Math.max(state.version, toState.version),
        author: toState.author,
        kind: state.kind,
        deleted: false,
      });
    }
    this.assertNoPortableLivePathConflict(to);
    this.setFileState(to, toState);
    this.fileRevisionCounter = Math.max(this.fileRevisionCounter, fromState.version, toState.version);
  }

  /** Remembers the accepted destination of a rename so conflicts can be resolved. */
  private recordRenameOrigin(from: string, to: string, toState: FileLifecycleState): void {
    const now = Date.now();
    this.renameOrigins.set(from, { to, toState, at: now });
    for (const [key, origin] of [...this.renameOrigins]) {
      if (now - origin.at > 10 * 60_000) this.renameOrigins.delete(key);
    }
  }

  /**
   * Resolves concurrent renames of one logical source path.  Both peers see both
   * renames and pick the same winner (highest lifecycle state), so normal
   * collaboration can never end up with two accidental live copies: the losing
   * destination is deterministically tombstoned everywhere.
   */
  private resolveRenameConflict(
    from: string,
    to: string,
    toState: FileLifecycleState,
  ): { decision: 'applies'; source: string; losingPath?: string; tombstone?: FileLifecycleState }
    | { decision: 'loses'; source: string; tombstone: FileLifecycleState } {
    const previous = this.renameOrigins.get(from);
    if (!previous || previous.to === to) return { decision: 'applies', source: from };
    if (compareFileState(toState, previous.toState) > 0) {
      // The incoming destination wins: move the earlier destination instead of
      // the (already gone) original path and tombstone the earlier destination.
      return {
        decision: 'applies',
        source: previous.to,
        losingPath: previous.to,
        tombstone: {
          version: previous.toState.version,
          author: previous.toState.author,
          kind: previous.toState.kind,
          deleted: true,
        },
      };
    }
    return {
      decision: 'loses',
      source: from,
      tombstone: { version: toState.version, author: toState.author, kind: toState.kind, deleted: true },
    };
  }

  private async reconcileFilesystemState(frame: WireFrame, sourceId: string): Promise<void> {
    if (!isPlainRecord(frame.meta.fileStates) || !isPlainRecord(frame.meta.binaries)) {
      throw new Error('Peer sent a malformed filesystem-state manifest.');
    }
    const stateEntries = Object.entries(frame.meta.fileStates);
    const binaryEntries = Object.entries(frame.meta.binaries);
    if (stateEntries.length + binaryEntries.length > MAX_EXECUTION_MANIFEST_ENTRIES) {
      throw new Error('Peer filesystem-state manifest exceeds the entry limit.');
    }
    for (const [rawPath, raw] of stateEntries) {
      const state = normalizeFileState(raw, sourceId);
      const relativePath = normalizedTrackedPath(rawPath);
      if (!state || !relativePath) continue;
      const hadDocument = this.project.has(relativePath);
      const accepted = await this.acceptFileState(relativePath, state, sourceId);
      if (accepted && !hadDocument && !state.deleted && (state.kind === 'text' || state.kind === 'notebook')) {
        this.requestDocumentState(sourceId, relativePath, state.kind);
      }
    }
    for (const [rawPath, raw] of binaryEntries) {
      const relativePath = normalizedTrackedPath(rawPath);
      if (!relativePath || this.effectiveFileState(relativePath)?.deleted) continue;
      const remote = normalizeBinaryVersion(raw, sourceId);
      if (!remote || remote.version > this.fileRevisionCounter + MAX_REMOTE_REVISION_ADVANCE) continue;
      const local = this.binaryVersions.get(relativePath);
      if (!local || compareBinaryVersion(remote, local) > 0) {
        this.transport.sendTo(sourceId, 'binarySyncRequest', { relativePath, version: remote });
      } else if (compareBinaryVersion(local, remote) > 0) {
        void this.synchronizeBinaryVersion(sourceId, relativePath, local).catch((error) => {
          this.log.appendLine(`[error] Binary reconnect sync for ${relativePath}: ${formatError(error)}`);
        });
      }
    }
  }

  private async reconcileExecutionManifest(manifest: ExecutionManifest): Promise<void> {
    const expectedDirectories = new Set(manifest?.directories ?? []);
    // The execution barrier may add versions that the requester proved it has,
    // but it never turns an absent manifest entry into a delete operation.
    // Deletions must arrive through the normal versioned filesystem protocol.
    for (const directory of expectedDirectories) {
      if (!this.directories.has(directory)) {
        this.ensureLiveFileState(directory, 'directory');
        this.directories.add(directory);
        await this.storage?.createDirectory(directory);
      }
    }
    await this.persistDescriptor();
  }

  /** Retained for protocol-compatible peers that still explicitly request a file barrier. */
  public async synchronizeExecutionFiles(
    executorId: string,
    requestId: string,
    notebookKey: string,
    target: NotebookComputeTarget,
  ): Promise<ExecutionManifest> {
    let lastError = 'remote versions did not converge';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const manifest = this.executionManifest();
      const statusPromise = this.waitForBarrierReply(requestId, 'status', executorId);
      void this.dispatchExecutionBarrierFrame(
        executorId,
        requestId,
        'status',
        'executionBarrierCheck',
        { requestId, notebookKey, target, manifest },
      );
      const status = await statusPromise;
      if (status.success !== true) {
        throw new Error(`File synchronization was refused by the executor: ${String(status.message ?? 'invalid barrier request')}`);
      }
      const missingDocuments = requestedManifestPaths(status.missingDocuments, manifest.documents);
      const missingBinaries = requestedManifestPaths(status.missingBinaries, manifest.binaries);
      for (const key of missingDocuments) {
        const kind = this.project.kindOf(key);
        if (!kind) throw new Error(`File synchronization failed: local document ${key} disappeared.`);
        await this.sendToWithRouteRecovery(executorId, 'stateDocument', {
          key,
          kind,
          fileState: this.fileStates.get(key),
        }, this.project.encodeUpdate(key));
      }
      await Promise.all(missingBinaries.map(async (relativePath) => {
        const version = manifest.binaries[relativePath];
        if (!version) throw new Error(`File synchronization failed: invalid binary request for ${relativePath}.`);
        await this.synchronizeBinaryVersion(executorId, relativePath, version);
      }));
      const ackPromise = this.waitForBarrierReply(requestId, 'ack', executorId);
      void this.dispatchExecutionBarrierFrame(
        executorId,
        requestId,
        'ack',
        'executionBarrierCommit',
        { requestId, notebookKey, target, manifest },
      );
      const ack = await ackPromise;
      if (ack.success === true) return manifest;
      lastError = String(ack.message ?? 'remote hash verification failed');
    }
    throw new Error(`File synchronization failed before execution: ${lastError}`);
  }

  private executionManifest(): ExecutionManifest {
    const documents = Object.create(null) as Record<string, string>;
    for (const key of this.project.keys()) documents[key] = this.projectDocumentHash(key);
    return {
      documents,
      binaries: Object.fromEntries(this.binaryVersions),
      directories: [...this.directories].sort(),
    };
  }

  private projectDocumentHash(key: string): string {
    const kind = this.project.kindOf(key);
    if (kind === 'text') return createHash('sha256').update(this.project.text(key).toString(), 'utf8').digest('hex');
    if (kind === 'notebook') return createHash('sha256').update(serializeIpynb(this.project.notebookSnapshot(key))).digest('hex');
    throw new Error(`Unknown collaborative document: ${key}`);
  }

  private async handleExecutionBarrierCheck(frame: WireFrame, sourceId: string): Promise<void> {
    const requestId = String(frame.meta.requestId ?? '');
    const notebookKey = normalizedTrackedPath(String(frame.meta.notebookKey ?? ''));
    const target = normalizeComputeTarget(frame.meta.target, sourceId);
    const manifest = normalizeExecutionManifest(frame.meta.manifest, sourceId);
    const targetError = notebookKey && target ? this.remoteComputeTargetError(notebookKey, target) : 'Malformed execution target.';
    if (!TRANSFER_ID_PATTERN.test(requestId) || !notebookKey || !target || !manifest || targetError) {
      this.transport.sendTo(sourceId, 'executionBarrierStatus', {
        requestId,
        success: false,
        message: targetError || 'Malformed execution barrier manifest.',
      });
      return;
    }
    if (Object.values(manifest.binaries)
      .some((version) => version.version > this.fileRevisionCounter + MAX_REMOTE_REVISION_ADVANCE)) {
      this.transport.sendTo(sourceId, 'executionBarrierStatus', {
        requestId, success: false, message: 'Execution manifest contains an implausible binary revision.',
      });
      return;
    }
    const extraDocuments = this.project.keys().filter((key) => !(key in manifest.documents));
    const extraBinaries = [...this.binaryVersions.keys()].filter((key) => !(key in manifest.binaries));
    const desiredDirectories = new Set(manifest.directories);
    const extraDirectories = [...this.directories].filter((key) => !desiredDirectories.has(key));
    if (extraDocuments.length || extraBinaries.length || extraDirectories.length) {
      this.transport.sendTo(sourceId, 'executionBarrierStatus', {
        requestId,
        success: false,
        message: 'The requester is missing local project entries; wait for normal project synchronization and retry.',
      });
      return;
    }
    const sourceAuthorizations = [
      ...this.pendingBarrierAuthorizations.values(),
      ...this.completedExecutionBarriers.values(),
    ]
      .filter((authorization) => authorization.sourceId === sourceId).length;
    if (this.pendingBarrierAuthorizations.size + this.completedExecutionBarriers.size >= MAX_PENDING_BARRIER_AUTHORIZATIONS
      || sourceAuthorizations >= 16) {
      this.transport.sendTo(sourceId, 'executionBarrierStatus', {
        requestId, success: false, message: 'Too many pending execution barriers.',
      });
      return;
    }
    const authorizationKey = barrierAuthorizationKey(sourceId, requestId);
    this.dropBarrierAuthorization(authorizationKey);
    const manifestDigest = executionManifestDigest(manifest);
    const timer = setTimeout(() => this.pendingBarrierAuthorizations.delete(authorizationKey), BARRIER_AUTHORIZATION_TIMEOUT_MS);
    this.pendingBarrierAuthorizations.set(authorizationKey, {
      sourceId, notebookKey, target, manifestDigest, timer,
    });
    const missingDocuments = Object.entries(manifest.documents)
      .filter(([key, hash]) => !this.project.has(key) || this.projectDocumentHash(key) !== hash)
      .map(([key]) => key);
    const missingBinaries = Object.entries(manifest.binaries)
      .filter(([key, version]) => {
        const local = this.binaryVersions.get(key);
        const normalized = normalizeBinaryVersion(version, sourceId);
        return !local || !normalized || !sameBinaryVersion(local, normalized);
      })
      .map(([key]) => key);
    const missingDirectories = [...desiredDirectories].filter((key) => !this.directories.has(key));
    this.transport.sendTo(sourceId, 'executionBarrierStatus', {
      requestId,
      success: true,
      missingDocuments,
      missingBinaries,
      missingDirectories,
    });
  }

  private async handleExecutionBarrierCommit(frame: WireFrame, sourceId: string): Promise<void> {
    const requestId = String(frame.meta.requestId ?? '');
    const notebookKey = normalizedTrackedPath(String(frame.meta.notebookKey ?? ''));
    const target = normalizeComputeTarget(frame.meta.target, sourceId);
    const manifest = normalizeExecutionManifest(frame.meta.manifest, sourceId);
    const authorizationKey = barrierAuthorizationKey(sourceId, requestId);
    const pending = this.pendingBarrierAuthorizations.get(authorizationKey);
    const manifestDigest = manifest ? executionManifestDigest(manifest) : '';
    const completed = this.completedExecutionBarriers.get(authorizationKey);
    if (completed && notebookKey && target && manifest
      && completed.sourceId === sourceId
      && completed.notebookKey === notebookKey
      && sameComputeTarget(completed.target, target)
      && completed.manifestDigest === manifestDigest) {
      this.transport.sendTo(sourceId, 'executionBarrierAck', { requestId, success: true, message: '' });
      return;
    }
    const authorized = Boolean(pending && notebookKey && target && manifest
      && pending.sourceId === sourceId
      && pending.notebookKey === notebookKey
      && sameComputeTarget(pending.target, target)
      && pending.manifestDigest === manifestDigest);
    if (!authorized || !pending || !notebookKey || !target || !manifest) {
      this.transport.sendTo(sourceId, 'executionBarrierAck', {
        requestId, success: false, message: 'Execution barrier commit was not authorized by a matching check.',
      });
      return;
    }
    clearTimeout(pending.timer);
    this.pendingBarrierAuthorizations.delete(authorizationKey);
    await this.reconcileExecutionManifest(manifest);
    await this.flush();
    const badDocuments = Object.entries(manifest.documents)
      .filter(([key, hash]) => !this.project.has(key) || this.projectDocumentHash(key) !== hash)
      .map(([key]) => key);
    const badBinaries = Object.entries(manifest.binaries)
      .filter(([key, version]) => {
        const local = this.binaryVersions.get(key);
        const normalized = normalizeBinaryVersion(version, sourceId);
        return !local || !normalized || !sameBinaryVersion(local, normalized);
      })
      .map(([key]) => key);
    const extraDocuments = this.project.keys().filter((key) => !(key in manifest.documents));
    const extraBinaries = [...this.binaryVersions.keys()].filter((key) => !(key in manifest.binaries));
    const desiredDirectories = new Set(manifest.directories);
    const badDirectories = [...desiredDirectories].filter((key) => !this.directories.has(key));
    const extraDirectories = [...this.directories].filter((key) => !desiredDirectories.has(key));
    const success = !badDocuments.length && !badBinaries.length && !badDirectories.length
      && !extraDocuments.length && !extraBinaries.length && !extraDirectories.length;
    if (success) {
      const previous = this.completedExecutionBarriers.get(authorizationKey);
      if (previous) clearTimeout(previous.timer);
      const timer = setTimeout(() => this.completedExecutionBarriers.delete(authorizationKey), COMPLETED_BARRIER_TIMEOUT_MS);
      this.completedExecutionBarriers.set(authorizationKey, {
        sourceId, notebookKey, target, manifestDigest, timer,
      });
    }
    this.transport.sendTo(sourceId, 'executionBarrierAck', {
      requestId,
      success,
      message: success ? '' : `Mismatched paths: ${[
        ...badDocuments,
        ...badBinaries,
        ...badDirectories,
        ...extraDocuments,
        ...extraBinaries,
        ...extraDirectories,
      ].join(', ')}`,
    });
  }

  private dropBarrierAuthorization(key: string): void {
    for (const authorizations of [this.pendingBarrierAuthorizations, this.completedExecutionBarriers]) {
      const authorization = authorizations.get(key);
      if (authorization) clearTimeout(authorization.timer);
      authorizations.delete(key);
    }
  }

  private remoteComputeTargetError(notebookKey: string, target: NotebookComputeTarget): string | undefined {
    if (target.executorId !== this.descriptor.localPeer.peerId
      || !sameComputeTarget(target, this.computeForNotebook(notebookKey))) {
      return 'The shared compute target changed or names a different executor.';
    }
    return this.computeTargetAvailabilityError(target);
  }

  private computeTargetAvailabilityError(target: NotebookComputeTarget): string | undefined {
    if (target.executorId !== this.coordinator.clock.hostId) {
      return 'The shared compute target does not name the current Session Host.';
    }
    const localExecutor = target.executorId === this.descriptor.localPeer.peerId;
    const presence = localExecutor
      ? this.localComputePresence()
      : this.snapshot().awareness.find((state) => state.peer.peerId === target.executorId);
    const online = localExecutor || this.transport.peerRuntime()
      .some((peer) => peer.peerId === target.executorId && peer.online);
    if (!presence || !online) return 'The Session Host compute executor is offline.';
    if (target.device !== 'cpu') {
      const gpuIndex = Number(target.device.slice(4));
      if (!presence.hardware?.gpus.some((gpu) => gpu.index === gpuIndex)) return 'The requested GPU is not available on the Session Host.';
    }
    if (target.pythonPath) {
      const environment = presence.environments?.find((candidate) => candidate.executable === target.pythonPath);
      if (!environment?.jupyterReady) return 'The requested Python environment is not an advertised Jupyter environment.';
      if (target.device.startsWith('gpu:') && !environment.cudaAvailable) {
        return 'The requested Python environment does not expose CUDA.';
      }
    }
    return undefined;
  }

  private async synchronizeBinaryVersion(
    peerId: string,
    relativePath: string,
    version: BinaryFileVersion,
  ): Promise<void> {
    const acknowledged = this.binaryAcknowledgements.get(peerId)?.get(relativePath);
    if (acknowledged && sameBinaryVersion(acknowledged, version)) return;
    const key = binaryAckKey(peerId, relativePath, version.hash, version.version, version.author);
    const existing = this.binarySyncs.get(key);
    if (existing) return existing;
    const sync = (async () => {
      // Hash and send straight from disk: a multi-gigabyte binary must never be
      // materialized in the extension host's memory.
      const absolutePath = await safeProjectTarget(this.descriptor.workingFolder, relativePath, true);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`Binary synchronization source is not a regular project file: ${relativePath}`);
      }
      const actualHash = await hashFile(absolutePath);
      if (actualHash !== version.hash) throw new Error(`Binary file changed during synchronization: ${relativePath}`);
      const ack = this.waitForBinaryAck(peerId, relativePath, version);
      const transferId = newId();
      const chunkSize = BINARY_CHUNK_SIZE;
      const chunks = Math.max(1, Math.ceil(info.size / chunkSize));
      try {
        this.transport.sendTo(peerId, 'binaryStart', {
          transferId,
          relativePath,
          chunks,
          chunkSize,
          hash: version.hash,
          version: version.version,
          author: version.author,
          size: info.size,
          fileState: this.fileStates.get(relativePath),
        });
        await this.streamFileChunks(absolutePath, chunks, chunkSize, info.size, version.hash, (index, chunk) => {
          this.transport.sendTo(peerId, 'binaryChunk', { transferId, index }, chunk);
        }, async () => {
          // Respect socket backpressure and extend the acknowledgement deadline
          // while the transfer is genuinely progressing.
          await this.transport.awaitDrain(peerId);
          this.refreshBinaryAck(peerId, relativePath, version);
        });
        this.transport.sendTo(peerId, 'binaryEnd', { transferId });
      } catch (error) {
        try { this.transport.sendTo(peerId, 'binaryAbort', { transferId }); } catch { /* peer may be gone */ }
        this.dropBinaryAck(peerId, relativePath, version);
        throw error;
      }

      await ack;
    })();
    this.binarySyncs.set(key, sync);
    try {
      await sync;
    } finally {
      if (this.binarySyncs.get(key) === sync) this.binarySyncs.delete(key);
    }
  }

  private waitForBinaryAck(
    peerId: string,
    relativePath: string,
    version: BinaryFileVersion,
  ): Promise<void> {
    const key = binaryAckKey(peerId, relativePath, version.hash, version.version, version.author);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingBinaryAcks.delete(key);
        reject(new Error(`File synchronization timed out waiting for ${relativePath} acknowledgement.`));
      }, EXECUTION_BARRIER_REPLY_TIMEOUT_MS);
      this.pendingBinaryAcks.set(key, { peerId, relativePath, expected: version, resolve, reject, timer });
    });
  }

  /** Restarts an acknowledgement deadline after observable transfer progress. */
  private refreshBinaryAck(peerId: string, relativePath: string, version: BinaryFileVersion): void {
    const key = binaryAckKey(peerId, relativePath, version.hash, version.version, version.author);
    const pending = this.pendingBinaryAcks.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      this.pendingBinaryAcks.delete(key);
      pending.reject(new Error(`File synchronization timed out waiting for ${relativePath} acknowledgement.`));
    }, 60_000);
  }

  private dropBinaryAck(peerId: string, relativePath: string, version: BinaryFileVersion): void {

    const key = binaryAckKey(peerId, relativePath, version.hash, version.version, version.author);
    const pending = this.pendingBinaryAcks.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingBinaryAcks.delete(key);
  }

  private acceptBinaryAck(
    peerId: string,
    relativePath: string,
    hash: string,
    version: number,
    author: string,
  ): void {
    const safePath = normalizedTrackedPath(relativePath);
    const revision = normalizeBinaryVersion({ hash, version, author }, peerId);
    if (!safePath || !revision) return;
    const acknowledgements = this.binaryAcknowledgements.get(peerId) ?? new Map<string, BinaryFileVersion>();
    acknowledgements.set(safePath, revision);
    this.binaryAcknowledgements.set(peerId, acknowledgements);
    const key = binaryAckKey(peerId, safePath, revision.hash, revision.version, revision.author);
    const pending = this.pendingBinaryAcks.get(key);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingBinaryAcks.delete(key);
      pending.resolve();
    }
    for (const [pendingKey, candidate] of [...this.pendingBinaryAcks]) {
      if (candidate.peerId !== peerId || candidate.relativePath !== safePath) continue;
      if (compareBinaryVersion(revision, candidate.expected) <= 0) continue;
      clearTimeout(candidate.timer);
      this.pendingBinaryAcks.delete(pendingKey);
      candidate.reject(new Error(`Peer ${peerId} already has a newer binary revision for ${safePath}.`));
    }
    this.emit('binaryAck', peerId, safePath, revision.hash, revision.version, revision.author);
  }

  private waitForBarrierReply(
    requestId: string,
    phase: 'status' | 'ack',
    executorId: string,
  ): Promise<Record<string, unknown>> {
    const key = `${requestId}:${phase}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingBarrierReplies.delete(key);
        reject(new Error(`File synchronization timed out waiting for executor ${phase}.`));
      }, 20_000);
      this.pendingBarrierReplies.set(key, { executorId, resolve, reject, timer });
    });
  }

  private async dispatchExecutionBarrierFrame(
    executorId: string,
    requestId: string,
    phase: 'status' | 'ack',
    type: 'executionBarrierCheck' | 'executionBarrierCommit',
    meta: Record<string, unknown>,
  ): Promise<void> {
    const key = `${requestId}:${phase}`;
    const deadline = Date.now() + EXECUTION_BARRIER_REPLY_TIMEOUT_MS;
    while (!this.closed && Date.now() < deadline) {
      const pending = this.pendingBarrierReplies.get(key);
      if (!pending || pending.executorId !== executorId) return;
      try {
        await this.waitForTransportRoute(executorId, Math.min(5_000, Math.max(1, deadline - Date.now())));
        if (this.pendingBarrierReplies.get(key) !== pending) return;
        this.transport.sendTo(executorId, type, meta);
      } catch (error) {
        if (!isRouteUnavailableError(error)) {
          clearTimeout(pending.timer);
          this.pendingBarrierReplies.delete(key);
          pending.reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      await this.waitForRetryDelay(Math.min(EXECUTION_REQUEST_RETRY_MS, Math.max(1, deadline - Date.now())));
    }
  }

  private resolveBarrierReply(
    requestId: string,
    phase: 'status' | 'ack',
    sourceId: string,
    meta: Record<string, unknown>,
  ): void {
    const key = `${requestId}:${phase}`;
    const pending = this.pendingBarrierReplies.get(key);
    if (!pending || pending.executorId !== sourceId) return;
    clearTimeout(pending.timer);
    this.pendingBarrierReplies.delete(key);
    pending.resolve(meta);
  }

  private rejectSynchronizationWaiters(peerId: string, reason: string): void {
    for (const [key, pending] of [...this.pendingBinaryAcks]) {
      if (pending.peerId !== peerId) continue;
      clearTimeout(pending.timer);
      this.pendingBinaryAcks.delete(key);
      pending.reject(new Error(reason));
    }
    for (const [key, pending] of [...this.pendingBarrierReplies]) {
      if (pending.executorId !== peerId) continue;
      clearTimeout(pending.timer);
      this.pendingBarrierReplies.delete(key);
      pending.reject(new Error(reason));
    }
    for (const [key, pending] of [...this.pendingKernelCommands]) {
      if (pending.executorId !== peerId) continue;
      clearTimeout(pending.timer);
      this.pendingKernelCommands.delete(key);
      pending.reject(new Error(reason));
    }
  }

  /**
   * Opens a temporary receive file for an incoming binary transfer.  The
   * identifier arrives from the network, so it is validated and never used to
   * build a path directly; the transfer is additionally keyed by its source peer
   * so no other participant can interfere with it.
   */
  private async beginBinaryTransfer(frame: WireFrame, sourceId: string): Promise<void> {
    const transferId = String(frame.meta.transferId ?? '');
    if (!TRANSFER_ID_PATTERN.test(transferId)) {
      this.log.appendLine(`[error] Refusing binary transfer with an unsupported transfer id from ${sourceId}.`);
      return;
    }
    let relativePath: string;
    try {
      relativePath = safeRelativePath(String(frame.meta.relativePath ?? '')).split(path.sep).join('/');
    } catch {
      this.log.appendLine(`[error] Refusing binary transfer with an unsafe path from ${sourceId}.`);
      return;
    }
    if (!shouldTrackProjectPath(relativePath)) {
      this.log.appendLine(`[error] Refusing binary transfer targeting an internal project path from ${sourceId}.`);
      return;
    }
    let shape: IncomingTransferShape;
    try {
      shape = validateIncomingTransfer(frame.meta, BINARY_CHUNK_SIZE);
    } catch (error) {
      this.log.appendLine(`[error] Refusing invalid binary transfer of ${relativePath} from ${sourceId}: ${formatError(error)}`);
      return;
    }
    const revision = normalizeBinaryVersion({
      hash: shape.hash,
      version: frame.meta.version,
      author: frame.meta.author,
    }, sourceId);
    if (!revision) {
      this.log.appendLine(`[error] Refusing binary transfer with an invalid revision from ${sourceId}.`);
      return;
    }
    const key = transferKey(sourceId, transferId);
    await this.abortBinaryTransfer(key);
    const fileState = normalizeFileState(frame.meta.fileState, sourceId, 'binary');
    if (!fileState || fileState.deleted || fileState.kind !== 'binary') {
      this.log.appendLine(`[error] Refusing binary transfer without a valid live file state from ${sourceId}.`);
      return;
    }
    const largestRevision = Math.max(revision.version, fileState?.version ?? 0);
    if (largestRevision > this.fileRevisionCounter + MAX_REMOTE_REVISION_ADVANCE) {
      this.log.appendLine(`[error] Refusing binary transfer with an implausible revision from ${sourceId}.`);
      return;
    }
    const peerTransfers = [...this.binaryTransfers.values()].filter((transfer) => transfer.sourceId === sourceId);
    const totalDeclaredBytes = [...this.binaryTransfers.values()]
      .reduce((total, transfer) => total + transfer.shape.size, 0);
    const peerDeclaredBytes = peerTransfers.reduce((total, transfer) => total + transfer.shape.size, 0);
    if (this.binaryTransfers.size >= MAX_ACTIVE_BINARY_TRANSFERS
      || peerTransfers.length >= MAX_ACTIVE_BINARY_TRANSFERS_PER_PEER
      || totalDeclaredBytes + shape.size > MAX_DECLARED_BINARY_BYTES
      || peerDeclaredBytes + shape.size > MAX_DECLARED_BINARY_BYTES_PER_PEER
      || peerTransfers.some((transfer) => transfer.relativePath === relativePath)) {
      this.log.appendLine(`[error] Refusing binary transfer that exceeds the concurrency or storage quota from ${sourceId}.`);
      return;
    }
    const directory = await safeProjectTarget(this.descriptor.workingFolder, TRANSFER_DIRECTORY, true);
    await mkdir(directory, { recursive: true });
    // The file name is a digest of (source, transfer) so it always stays inside
    // the scratch directory whatever the peer sent.
    const temporaryPath = path.join(directory, transferFileName(sourceId, transferId));
    let handle;
    try {
      handle = await open(temporaryPath, 'wx');
    } catch (error) {
      this.log.appendLine(`[error] Refusing binary transfer whose temporary path is already occupied: ${formatError(error)}`);
      return;
    }
    const transfer: PendingBinary = {
      relativePath,
      received: new Set<number>(),
      expectedChunks: shape.expectedChunks,
      hash: shape.hash,
      version: revision.version,
      author: revision.author,
      fileState,
      sourceId,
      temporaryPath,
      handle,
      chunkSize: shape.chunkSize,
      bytesWritten: 0,
      shape,
      idleTimer: setTimeout(() => this.runBackground(
        'Idle binary transfer cleanup',
        () => this.abortBinaryTransfer(key),
      ), BINARY_IDLE_TIMEOUT_MS),
    };
    this.binaryTransfers.set(key, transfer);
  }

  /** Writes a received chunk straight to disk so memory stays bounded. */
  private async acceptBinaryChunk(sourceId: string, transferId: string, index: number, payload: Uint8Array): Promise<void> {
    const key = transferKey(sourceId, transferId);
    const transfer = this.binaryTransfers.get(key);
    if (!transfer || transfer.sourceId !== sourceId) return;
    const expectedBytes = expectedTransferChunkBytes(transfer.shape, index);
    if (expectedBytes < 0 || payload.byteLength !== expectedBytes) {
      this.log.appendLine(`[error] Aborting malformed binary transfer ${transfer.relativePath} from ${sourceId}.`);
      await this.abortBinaryTransfer(key);
      return;
    }
    if (transfer.received.has(index)) return; // duplicate chunk
    await transfer.handle.write(Buffer.from(payload), 0, payload.byteLength, index * transfer.chunkSize);
    transfer.received.add(index);
    transfer.bytesWritten += payload.byteLength;
    // Any progress restarts the idle timeout, so a slow relayed transfer
    // is never cancelled merely because the whole transfer takes a long time.
    clearTimeout(transfer.idleTimer);
    transfer.idleTimer = setTimeout(() => this.runBackground(
      'Idle binary transfer cleanup',
      () => this.abortBinaryTransfer(key),
    ), BINARY_IDLE_TIMEOUT_MS);
  }

  /** Drops transfer state and removes the partial file; never publishes it. */
  private async abortBinaryTransfer(key: string): Promise<void> {
    const transfer = this.binaryTransfers.get(key);
    if (!transfer) return;
    this.binaryTransfers.delete(key);
    clearTimeout(transfer.idleTimer);
    await transfer.handle.close().catch(() => undefined);
    await rm(transfer.temporaryPath, { force: true }).catch(() => undefined);
  }

  private async finishBinary(sourceId: string, transferId: string): Promise<void> {
    const key = transferKey(sourceId, transferId);
    const transfer = this.binaryTransfers.get(key);
    if (!transfer || transfer.sourceId !== sourceId) return;
    this.binaryTransfers.delete(key);
    clearTimeout(transfer.idleTimer);
    await transfer.handle.close().catch(() => undefined);
    try {
      if (transfer.received.size !== transfer.expectedChunks || transfer.bytesWritten !== transfer.shape.size) {
        throw new Error('Binary transfer is incomplete.');
      }
      // Verify by streaming the received file, never by loading it into memory.
      const hash = await hashFile(transfer.temporaryPath);
      if (hash !== transfer.hash) throw new Error('Binary transfer hash mismatch.');
      const incoming: BinaryFileVersion = { hash, version: transfer.version, author: transfer.author };

      const lifecycle = transfer.fileState ?? {
        version: Math.max(this.fileRevisionCounter + 1, transfer.version),
        author: transfer.author,
        kind: 'binary' as const,
        deleted: false,
      };
      if (!await this.acceptFileState(transfer.relativePath, lifecycle, transfer.sourceId)) {
        this.sendFilesystemState(transfer.sourceId);
        return;
      }
      const current = this.binaryVersions.get(transfer.relativePath);
      if (current && compareBinaryVersion(incoming, current) < 0) {
        this.transport.sendTo(transfer.sourceId, 'binaryAck', {
          relativePath: transfer.relativePath,
          hash: current.hash,
          version: current.version,
          author: current.author,
        });
        return;
      }
      // Atomically move the streamed file into the working copy (and backing
      // folder) instead of re-reading the whole payload.
      this.rememberInternalWorkingHash(transfer.relativePath, hash);
      if (!this.storage) throw new Error('Binary storage is not initialized.');
      await this.storage.mirrorBinaryFile(transfer.relativePath, transfer.temporaryPath, hash);
      this.binaryVersions.set(transfer.relativePath, incoming);
      await this.persistDescriptor();
      if (transfer.sourceId) {
        this.transport.sendTo(transfer.sourceId, 'binaryAck', {
          relativePath: transfer.relativePath,
          hash,
          version: transfer.version,
          author: transfer.author,
        });
      }
    } finally {
      // Success, rejection and failure all end without a leftover `.part` file;
      // after a successful publish the path no longer exists, so this is a no-op.
      await rm(transfer.temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async indexBinaryFiles(): Promise<void> {
    const hasPersistedRevisionState = Boolean(
      Object.keys(this.descriptor.fileStates ?? {}).length
      || Object.keys(this.descriptor.binaryVersions ?? {}).length,
    );
    // A peer's very first local copy comes from the host snapshot.  Treat it as
    // revision zero so an already-running session revision always wins if the
    // copy became stale between snapshot download and runtime connection.  On
    // later starts the persisted revision maps below preserve genuine offline
    // edits and let them participate in normal Lamport ordering.
    const initialPeerBaseline = this.descriptor.role === 'peer' && !hasPersistedRevisionState;
    const seedAuthor = initialPeerBaseline ? this.descriptor.hostPeerId : this.descriptor.localPeer.peerId;
    const seedVersion = initialPeerBaseline ? 0 : 1;
    const [projectFiles, projectDirectories] = await Promise.all([
      scanProject(this.descriptor.workingFolder),
      scanDirectories(this.descriptor.workingFolder),
    ]);
    if (projectFiles.length + projectDirectories.length > MAX_TRACKED_PROJECT_ENTRIES) {
      throw new Error(`Project exceeds the ${MAX_TRACKED_PROJECT_ENTRIES}-entry limit.`);
    }
    assertPortablePathUniqueness([
      ...projectFiles.map((file) => file.relativePath),
      ...projectDirectories,
    ]);
    for (const file of projectFiles) {
      const currentState = this.fileStates.get(file.relativePath);
      if (!currentState || currentState.deleted || currentState.kind !== file.kind) {
        const state = currentState?.deleted
          ? this.nextFileState(file.kind, false)
          : {
            version: Math.max(seedVersion, currentState?.version ?? seedVersion),
            author: currentState?.author ?? seedAuthor,
            kind: file.kind,
            deleted: false,
          };
        this.setFileState(file.relativePath, state);
        this.fileRevisionCounter = Math.max(this.fileRevisionCounter, state.version);
      }
      if (file.kind === 'binary') {
        const saved = this.binaryVersions.get(file.relativePath);
        if (saved?.hash === file.hash) continue;
        this.binaryVersions.set(file.relativePath, saved
          ? { hash: file.hash, version: saved.version + 1, author: this.descriptor.localPeer.peerId }
          : { hash: file.hash, version: seedVersion, author: seedAuthor });
      }
    }
    for (const directory of projectDirectories) {
      this.directories.add(directory);
      const current = this.fileStates.get(directory);
      if (!current || current.deleted || current.kind !== 'directory') {
        const state = current?.deleted
          ? this.nextFileState('directory', false)
          : {
            version: Math.max(seedVersion, current?.version ?? seedVersion),
            author: current?.author ?? seedAuthor,
            kind: 'directory' as const,
            deleted: false,
          };
        this.setFileState(directory, state);
        this.fileRevisionCounter = Math.max(this.fileRevisionCounter, state.version);
      }
    }
  }

  private renameBinaryVersions(from: string, to: string): void {
    for (const [key, version] of [...this.binaryVersions]) {
      if (key !== from && !key.startsWith(`${from}/`)) continue;
      this.binaryVersions.delete(key);
      this.binaryVersions.set(key === from ? to : `${to}${key.slice(from.length)}`, version);
    }
  }

  private renameDirectories(from: string, to: string): void {
    for (const key of [...this.directories]) {
      if (key !== from && !key.startsWith(`${from}/`)) continue;
      this.directories.delete(key);
      this.directories.add(key === from ? to : `${to}${key.slice(from.length)}`);
    }
  }

  private deleteDirectories(relativePath: string): void {
    for (const key of [...this.directories]) {
      if (key === relativePath || key.startsWith(`${relativePath}/`)) this.directories.delete(key);
    }
  }

  private cancelNotebookExecutions(notebookKey: string, reason: string): void {
    for (const [requestId, pending] of this.pendingExecutions) {
      if (notebookKey !== '*' && pending.notebookKey !== notebookKey) continue;
      clearTimeout(pending.timer);
      this.pendingExecutions.delete(requestId);
      pending.reject(new Error(reason));
    }
  }

  private cancelExecutorRequests(executorId: string, reason: string): void {
    for (const [key, pending] of this.pendingInputReplies) {
      if (pending.executorId !== executorId) continue;
      clearTimeout(pending.timer);
      this.pendingInputReplies.delete(key);
      pending.reject(new Error(reason));
    }
    for (const [requestId, pending] of this.pendingExecutions) {
      if (pending.executorId !== executorId) continue;
      clearTimeout(pending.timer);
      this.pendingExecutions.delete(requestId);
      pending.reject(new Error(reason));
    }
  }

  private deleteBinaryVersions(relativePath: string): void {
    for (const key of [...this.binaryVersions.keys()]) {
      if (key === relativePath || key.startsWith(`${relativePath}/`)) this.binaryVersions.delete(key);
    }
  }

  private reserveRemoteExecutionOwner(
    requestId: string,
    sourceId: string,
    notebookKey: string,
    requestDigest: string,
    cellId?: string,
  ): ExecutionOwner | undefined {
    const remoteOwners = [...this.executionOwners.values()]
      .filter((owner) => owner.peerId !== this.descriptor.localPeer.peerId);
    if (remoteOwners.length >= MAX_REMOTE_EXECUTIONS
      || remoteOwners.filter((owner) => owner.peerId === sourceId).length >= MAX_REMOTE_EXECUTIONS_PER_PEER) {
      return undefined;
    }
    const owner: ExecutionOwner = {
      peerId: sourceId,
      notebookKey,
      requestDigest,
      accepted: false,
      cellId,
      events: [],
      eventBytes: 0,
      inputRequestSequences: new Set(),
      inputReplyDigests: new Map(),
    };
    this.executionOwners.set(requestId, owner);
    return owner;
  }

  private sendExecutionAccepted(peerId: string, requestId: string): void {
    try {
      this.transport.sendTo(peerId, 'executeAccepted', { requestId });
    } catch (error) {
      // The requester repeats the same idempotent request until this acknowledgement arrives.
      this.log.appendLine(`[debug] Could not acknowledge execution ${requestId}: ${formatError(error)}`);
    }
  }

  private sendRemoteExecutionEvents(peerId: string, requestId: string, events: RemoteExecutionEventRecord[]): void {
    for (const event of events) {
      this.transport.sendTo(peerId, 'executionEvent', {
        requestId,
        eventSequence: event.sequence,
      }, event.payload);
    }
  }

  private deliverActiveRemoteExecution(requestId: string): void {
    const owner = this.executionOwners.get(requestId);
    if (!owner || !owner.events || this.closed || !owner.accepted) return;
    if (owner.replayTimer) {
      clearTimeout(owner.replayTimer);
      owner.replayTimer = undefined;
    }
    this.sendExecutionAccepted(owner.peerId, requestId);
    try {
      this.sendRemoteExecutionEvents(owner.peerId, requestId, owner.events);
      return;
    } catch (error) {
      this.log.appendLine(`[debug] Execution events ${requestId} await route recovery: ${formatError(error)}`);
    }
    if (this.executionOwners.get(requestId) !== owner) return;
    owner.replayTimer = setTimeout(() => {
      owner.replayTimer = undefined;
      this.deliverActiveRemoteExecution(requestId);
    }, executionDeliveryRetryMs(owner.eventBytes ?? 0));
  }

  private replayRemoteExecutionsForPeer(peerId: string): void {
    for (const [requestId, owner] of this.executionOwners) {
      if (owner.peerId !== peerId || !owner.events) continue;
      this.recordExecutionDiagnostic('execution-replayed', requestId, peerId, 'execution-replay', {
        ...(owner.cellId ? { cellId: owner.cellId } : {}),
      });
      this.deliverActiveRemoteExecution(requestId);
    }
    for (const [requestId, completed] of this.completedRemoteExecutions) {
      if (completed.sourceId !== peerId) continue;
      this.recordExecutionDiagnostic('execution-replayed', requestId, peerId, 'execution-replay');
      this.deliverCompletedRemoteExecution(requestId);
    }
  }

  private rememberCompletedRemoteExecution(
    sourceId: string,
    requestId: string,
    requestDigest: string,
    result: JupyterExecutionResult,
    events: RemoteExecutionEventRecord[] = [],
    inputReplyDigests: Map<number, string> = new Map(),
  ): void {
    this.dropCompletedRemoteExecution(requestId);
    let resultPayload: Uint8Array<ArrayBufferLike>;
    try {
      resultPayload = encodeRemoteExecutionResult(result);
    } catch (error) {
      resultPayload = encodeRemoteExecutionResult({
        requestId,
        success: false,
        content: {
          status: 'error',
          ename: 'OutputReplayLimit',
          evalue: formatError(error),
        },
      });
    }
    const retainedBytes = resultPayload.byteLength
      + events.reduce((total, event) => total + event.payload.byteLength, 0);
    while (this.completedRemoteExecutions.size >= MAX_COMPLETED_REMOTE_EXECUTIONS
      || this.completedRemoteExecutionBytes + retainedBytes > MAX_RETAINED_REMOTE_EXECUTION_BYTES) {
      const oldest = this.completedRemoteExecutions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.dropCompletedRemoteExecution(oldest);
    }
    const expiryTimer = setTimeout(
      () => this.dropCompletedRemoteExecution(requestId),
      COMPLETED_REMOTE_EXECUTION_TIMEOUT_MS,
    );
    this.completedRemoteExecutions.set(requestId, {
      sourceId,
      requestDigest,
      resultPayload,
      events,
      retainedBytes,
      inputReplyDigests: new Map(inputReplyDigests),
      expiryTimer,
      retryTimer: undefined,
    });
    this.completedRemoteExecutionBytes += retainedBytes;
    this.deliverCompletedRemoteExecution(requestId);
  }

  private deliverCompletedRemoteExecution(requestId: string): void {
    const completed = this.completedRemoteExecutions.get(requestId);
    if (!completed || this.closed) return;
    if (completed.retryTimer) {
      clearTimeout(completed.retryTimer);
      completed.retryTimer = undefined;
    }
    try {
      this.sendRemoteExecutionEvents(completed.sourceId, requestId, completed.events);
      this.transport.sendTo(completed.sourceId, 'executeResult', {
        requestId,
        eventCount: completed.events.length,
      }, completed.resultPayload);
    } catch (error) {
      this.log.appendLine(`[debug] Execution result ${requestId} awaits route recovery: ${formatError(error)}`);
    }
    if (this.completedRemoteExecutions.get(requestId) !== completed) return;
    completed.retryTimer = setTimeout(() => {
      completed.retryTimer = undefined;
      this.deliverCompletedRemoteExecution(requestId);
    }, executionDeliveryRetryMs(completed.retainedBytes));
  }

  private dropCompletedRemoteExecution(requestId: string): void {
    const completed = this.completedRemoteExecutions.get(requestId);
    if (!completed) return;
    clearTimeout(completed.expiryTimer);
    if (completed.retryTimer) clearTimeout(completed.retryTimer);
    this.completedRemoteExecutions.delete(requestId);
    this.getExecutionDiagnosticCorrelations().delete(requestId);
    this.completedRemoteExecutionBytes = Math.max(
      0,
      this.completedRemoteExecutionBytes - completed.retainedBytes,
    );
  }

  private rememberCompletedExecutionReceipt(requestId: string, executorId: string): void {
    const previous = this.completedExecutionReceipts.get(requestId);
    if (previous) clearTimeout(previous.timer);
    while (!previous && this.completedExecutionReceipts.size >= MAX_COMPLETED_REMOTE_EXECUTIONS) {
      const oldest = this.completedExecutionReceipts.keys().next().value as string | undefined;
      if (!oldest) break;
      const receipt = this.completedExecutionReceipts.get(oldest);
      if (receipt) clearTimeout(receipt.timer);
      this.completedExecutionReceipts.delete(oldest);
    }
    const timer = setTimeout(
      () => this.completedExecutionReceipts.delete(requestId),
      COMPLETED_REMOTE_EXECUTION_TIMEOUT_MS,
    );
    this.completedExecutionReceipts.set(requestId, { executorId, timer });
  }

  private acknowledgeExecutionResult(requestId: string, executorId: string): void {
    try {
      this.transport.sendTo(executorId, 'executeResultAck', { requestId });
    } catch (error) {
      // The executor retains and repeats the result, so a later copy will trigger another acknowledgement.
      this.log.appendLine(`[debug] Could not acknowledge execution result ${requestId}: ${formatError(error)}`);
    }
  }

  private sendInputReplyAcknowledgement(
    peerId: string,
    requestId: string,
    eventSequence: number | undefined,
    success: boolean,
    message: string,
  ): void {
    if (eventSequence === undefined) return;
    try {
      this.transport.sendTo(peerId, 'inputReplyAck', {
        requestId,
        eventSequence,
        success,
        message,
      });
    } catch (error) {
      // The requester repeats the same digest-bound reply until this acknowledgement arrives.
      this.log.appendLine(`[debug] Could not acknowledge Jupyter input ${requestId}: ${formatError(error)}`);
    }
  }

  private async waitForAuthoritativeCellState(
    request: LightweightExecutionRequest,
    requestId: string,
    sourceId: string,
  ): Promise<{ source: string; revision: string; digest: string }> {
    const inspect = (): { source: string; revision: string; digest: string } | undefined => {
      if (this.project.kindOf(request.notebookKey) !== 'notebook'
        || !this.project.hasNotebookCell(request.notebookKey, request.cellId)) {
        return undefined;
      }
      const state = this.project.cellTextState(request.notebookKey, request.cellId);
      return {
        source: state.source,
        revision: state.revision,
        digest: canonicalCellTextDigest(state.source),
      };
    };
    const classify = (
      state: { source: string; revision: string; digest: string } | undefined,
    ): 'match' | 'host-ahead' | 'wait' => {
      if (!state) return 'wait';
      if (state.revision === request.cellRevision && state.digest === request.cellDigest) return 'match';
      const hostSequence = cellTextRevisionSequence(state.revision);
      const requestSequence = cellTextRevisionSequence(request.cellRevision);
      if (hostSequence !== undefined && requestSequence !== undefined && hostSequence > requestSequence) {
        return 'host-ahead';
      }
      return 'wait';
    };

    const diagnosticMetadata: LifecycleDiagnosticMetadata = {
      cellId: request.cellId,
      revision: request.cellRevision,
      digest: request.cellDigest,
      computeEpoch: request.computeEpoch,
    };
    const initial = inspect();
    const initialClass = classify(initial);
    if (initialClass === 'match') {
      this.recordExecutionDiagnostic('execution-cell-state-ready', requestId, sourceId, 'cell-state-ready', diagnosticMetadata);
      return initial!;
    }
    if (initialClass === 'host-ahead') {
      throw new StaleCellRevisionError('The host canonical cell is newer than the requested guest revision.');
    }

    this.recordExecutionDiagnostic('execution-cell-state-wait', requestId, sourceId, 'cell-state-wait', diagnosticMetadata);
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        clearTimeout(timer);
        this.project.off('update', onUpdate);
        this.off('closed', onClosed);
      };
      const finishResolve = (state: { source: string; revision: string; digest: string }): void => {
        if (settled) return;
        settled = true;
        cleanup();
        this.recordExecutionDiagnostic('execution-cell-state-ready', requestId, sourceId, 'cell-state-ready', diagnosticMetadata);
        resolve(state);
      };
      const finishReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const check = (): void => {
        const state = inspect();
        const classification = classify(state);
        if (classification === 'match') {
          finishResolve(state!);
        } else if (classification === 'host-ahead') {
          finishReject(new StaleCellRevisionError(
            'The host canonical cell advanced beyond the requested guest revision while waiting.',
          ));
        }
      };
      const onUpdate = (event: ProjectUpdate): void => {
        if (event.kind !== 'notebook' || event.key !== request.notebookKey) return;
        // Targeted cell-text updates are the normal wake-up path. An unscoped
        // bootstrap/state-vector update is also checked because it can contain
        // the requested cell state; metadata/output/other-cell updates are ignored.
        if (event.scope !== undefined
          && (event.scope.type !== 'cellText' || event.scope.cellId !== request.cellId)) {
          return;
        }
        check();
      };
      const onClosed = (): void => finishReject(this.sessionClosedError());
      const timer = setTimeout(() => {
        finishReject(new CellStateUnavailableError(
          'Timed out waiting for the requested target-cell CRDT state on the Session Host.',
        ));
      }, Math.max(1, this.targetCellConvergenceTimeoutMs));
      this.project.on('update', onUpdate);
      this.once('closed', onClosed);
      // Re-check after subscribing so an update racing the initial inspection
      // cannot be missed.
      check();
    });
  }

  private async handleExecutionRequest(frame: WireFrame, sourceId: string): Promise<void> {
    const requestId = String(frame.meta.requestId ?? '');
    const notebookKey = normalizedTrackedPath(String(frame.meta.notebookKey ?? ''));
    let diagnosticCorrelationId: DiagnosticCorrelationId | undefined = undefined;
    const rejectRequest = (ename: string, evalue: string): void => {
      if (!TRANSFER_ID_PATTERN.test(requestId)) return;
      try {
        const result = {
          requestId,
          success: false,
          content: { status: 'error', ename, evalue },
        } satisfies JupyterExecutionResult;
        this.transport.sendTo(sourceId, 'executeResult', {
          requestId,
          eventCount: 0,
        }, encodeRemoteExecutionResult(result));
      } catch (error) {
        this.log.appendLine(`[debug] Could not reject execution ${requestId}: ${formatError(error)}`);
      }
      if (diagnosticCorrelationId) {
        this.recordExecutionDiagnostic('execution-completed', requestId, sourceId, 'execution-completed', { result: ename });
        if (this.getExecutionDiagnosticCorrelations().get(requestId) === diagnosticCorrelationId) {
          this.getExecutionDiagnosticCorrelations().delete(requestId);
        }
      }
    };

    // MeshTransport authenticates and binds sourceId before onMessage dispatches
    // here; this private boundary additionally rejects malformed/self identities.
    if (!PEER_ID_PATTERN.test(sourceId) || sourceId === this.descriptor.localPeer.peerId) {
      rejectRequest('InvalidExecutionRequest', 'The execution request source is not a valid authenticated remote peer.');
      return;
    }

    const fastPath = frame.meta.fastPath === true;
    const lightweight = fastPath ? normalizeLightweightExecutionRequest(frame.meta) : undefined;
    const legacyTarget = fastPath ? undefined : normalizeComputeTarget(frame.meta.target, sourceId);
    const legacyManifest = fastPath ? undefined : normalizeExecutionManifest({
      documents: frame.meta.documentManifest,
      binaries: frame.meta.binaryManifest,
      directories: frame.meta.directoryManifest,
    }, sourceId);

    if (!TRANSFER_ID_PATTERN.test(requestId) || !notebookKey
      || (fastPath
        ? !lightweight
          || lightweight.notebookKey !== notebookKey
          || frame.payload.byteLength !== 0
          || frame.meta.target !== undefined
          || frame.meta.documentManifest !== undefined
          || frame.meta.binaryManifest !== undefined
          || frame.meta.directoryManifest !== undefined
        : !legacyTarget || !legacyManifest)) {
      rejectRequest('InvalidExecutionRequest', 'The remote execution request is malformed.');
      return;
    }

    const requestDigest = fastPath
      ? lightweightExecutionRequestDigest(lightweight!)
      : legacyRemoteExecutionRequestDigest(notebookKey, legacyTarget!, legacyManifest!, frame.payload);
    const advertisedCorrelation = frame.meta.diagnosticCorrelationId;
    diagnosticCorrelationId = this.getExecutionDiagnosticCorrelations().get(requestId)
      ?? (isDiagnosticCorrelationId(advertisedCorrelation)
        ? advertisedCorrelation
        : this.getLifecycleDiagnosticsRing().newCorrelationId());
    this.getExecutionDiagnosticCorrelations().set(requestId, diagnosticCorrelationId);

    const completed = this.completedRemoteExecutions.get(requestId);
    if (completed) {
      if (completed.sourceId === sourceId && completed.requestDigest === requestDigest) {
        this.recordExecutionDiagnostic('execution-replayed', requestId, sourceId, 'execution-replay');
        this.sendExecutionAccepted(sourceId, requestId);
        this.deliverCompletedRemoteExecution(requestId);
      } else {
        rejectRequest('InvalidExecutionRequest', 'The execution request id was already used for different content.');
      }
      return;
    }
    const activeOwner = this.executionOwners.get(requestId);
    if (activeOwner) {
      if (activeOwner.peerId === sourceId && activeOwner.requestDigest === requestDigest) {
        this.recordExecutionDiagnostic('execution-replayed', requestId, sourceId, 'execution-replay', {
          ...(activeOwner.cellId ? { cellId: activeOwner.cellId } : {}),
        });
        this.deliverActiveRemoteExecution(requestId);
      } else {
        rejectRequest('ExecutionBusy', 'The execution request id is already active with different request identity.');
      }
      return;
    }

    const expectedTarget = this.computeForNotebook(notebookKey);
    let target: NotebookComputeTarget;
    let code: string;
    let materializeWorkspace: boolean;
    let executionOwner: ExecutionOwner | undefined;

    if (fastPath) {
      const request = lightweight!;
      if (request.executorId !== this.descriptor.localPeer.peerId
        || request.executorId !== this.coordinator.clock.hostId
        || request.computeEpoch !== expectedTarget.epoch
        || expectedTarget.executorId !== this.descriptor.localPeer.peerId) {
        rejectRequest('ComputeTargetChanged', 'Compute target changed before the execution request arrived.');
        return;
      }
      if (this.project.kindOf(notebookKey) !== 'notebook') {
        rejectRequest('CellStateUnavailable', 'The requested collaborative notebook is not available on the Session Host.');
        return;
      }
      if (!this.project.hasNotebookCell(notebookKey, request.cellId)) {
        rejectRequest('CellStateUnavailable', 'The requested shared cell is not available on the Session Host.');
        return;
      }
      // Reserve exactly-once ownership before any asynchronous convergence
      // wait. Identical duplicates observe this reservation instead of
      // creating a second waiter/kernel execution.
      executionOwner = this.reserveRemoteExecutionOwner(
        requestId, sourceId, notebookKey, requestDigest, request.cellId,
      );
      if (!executionOwner) {
        rejectRequest('ExecutionBusy', 'The executor has reached its remote execution concurrency limit.');
        return;
      }
      let canonical: { source: string; revision: string; digest: string };
      try {
        canonical = await this.waitForAuthoritativeCellState(request, requestId, sourceId);
      } catch (error) {
        if (this.executionOwners.get(requestId) === executionOwner) {
          this.executionOwners.delete(requestId);
        }
        if (error instanceof StaleCellRevisionError) {
          rejectRequest('StaleCellRevision', error.message);
        } else if (error instanceof CellStateUnavailableError) {
          rejectRequest('CellStateUnavailable', error.message);
        } else {
          throw error;
        }
        return;
      }
      const currentTarget = this.computeForNotebook(notebookKey);
      if (request.executorId !== this.coordinator.clock.hostId
        || request.executorId !== this.descriptor.localPeer.peerId
        || request.computeEpoch !== currentTarget.epoch
        || currentTarget.executorId !== this.descriptor.localPeer.peerId) {
        if (this.executionOwners.get(requestId) === executionOwner) this.executionOwners.delete(requestId);
        rejectRequest('ComputeTargetChanged', 'Compute target changed while waiting for canonical cell state.');
        return;
      }
      target = currentTarget;
      if (Buffer.byteLength(canonical.source, 'utf8') > MAX_REMOTE_EXECUTION_CODE_BYTES) {
        if (this.executionOwners.get(requestId) === executionOwner) this.executionOwners.delete(requestId);
        rejectRequest('InvalidExecutionRequest', 'The canonical remote code cell exceeds the execution-size limit.');
        return;
      }
      // The host executes only its own canonical CRDT cell text after exact
      // revision+digest convergence. Guest payload is never a code source.
      code = canonical.source;
      this.dropBarrierAuthorization(barrierAuthorizationKey(sourceId, requestId));
      materializeWorkspace = true;
    } else {
      target = legacyTarget!;
      const manifest = legacyManifest!;
      if (target.executorId !== this.descriptor.localPeer.peerId || !sameComputeTarget(target, expectedTarget)) {
        rejectRequest('ComputeTargetChanged', 'Compute target changed before the execution request arrived.');
        return;
      }
      const authorizationKey = barrierAuthorizationKey(sourceId, requestId);
      const authorization = this.completedExecutionBarriers.get(authorizationKey);
      if (!authorization || authorization.notebookKey !== notebookKey
        || !sameComputeTarget(authorization.target, target)
        || authorization.manifestDigest !== executionManifestDigest(manifest)) {
        rejectRequest('FileVersionBarrier', 'Execution request has no matching completed file barrier.');
        return;
      }
      clearTimeout(authorization.timer);
      this.completedExecutionBarriers.delete(authorizationKey);

      if (this.project.kindOf(notebookKey) !== 'notebook') {
        rejectRequest('InvalidExecutionRequest', 'The requested collaborative notebook does not exist.');
        return;
      }
      if (frame.payload.byteLength > MAX_REMOTE_EXECUTION_CODE_BYTES) {
        rejectRequest('InvalidExecutionRequest', 'The remote code cell exceeds the execution-size limit.');
        return;
      }
      try {
        code = new TextDecoder('utf-8', { fatal: true }).decode(frame.payload);
      } catch {
        rejectRequest('InvalidExecutionRequest', 'The remote code cell is not valid UTF-8.');
        return;
      }

      const missingBinaries = Object.entries(manifest.binaries).filter(([relativePath, version]) => {
        const local = this.binaryVersions.get(relativePath);
        return !local || !sameBinaryVersion(local, version);
      });
      const extraBinaries = [...this.binaryVersions.keys()].filter((relativePath) => !(relativePath in manifest.binaries));
      const missingDocuments = Object.entries(manifest.documents).filter(([key, hash]) =>
        !this.project.has(key) || this.projectDocumentHash(key) !== hash);
      const extraDocuments = this.project.keys().filter((key) => !(key in manifest.documents));
      const directoryManifest = new Set(manifest.directories);
      const missingDirectories = [...directoryManifest].filter((key) => !this.directories.has(key));
      const extraDirectories = [...this.directories].filter((key) => !directoryManifest.has(key));
      const mismatch = [
        ...missingBinaries.map(([key]) => key),
        ...extraBinaries,
        ...missingDocuments.map(([key]) => key),
        ...extraDocuments,
        ...missingDirectories,
        ...extraDirectories,
      ];
      if (mismatch.length) {
        this.rememberCompletedRemoteExecution(sourceId, requestId, requestDigest, {
          requestId,
          success: false,
          content: {
            status: 'error',
            ename: 'FileVersionBarrier',
            evalue: `Executor project barrier mismatch: ${mismatch.join(', ')}`,
          },
        });
        return;
      }
      materializeWorkspace = true;
    }

    const targetError = this.computeTargetAvailabilityError(target);
    if (targetError) {
      if (executionOwner && this.executionOwners.get(requestId) === executionOwner) {
        this.executionOwners.delete(requestId);
      }
      rejectRequest(computeAvailabilityErrorName(targetError), targetError);
      return;
    }
    if (!executionOwner) {
      executionOwner = this.reserveRemoteExecutionOwner(
        requestId, sourceId, notebookKey, requestDigest,
      );
      if (!executionOwner) {
        rejectRequest('ExecutionBusy', 'The executor has reached its remote execution concurrency limit.');
        return;
      }
    }

    // A new request reaches this point only after authority checks and, for
    // lightweight framing, exact host-canonical target-cell convergence.
    if (fastPath && executionOwner.cellId) {
      executionOwner.outputState = createJupyterRenderState();
      executionOwner.startedAt = Date.now();
      this.project.setCellExecution(notebookKey, executionOwner.cellId, { requestId });
      this.project.setCellOutputs(notebookKey, executionOwner.cellId, []);
    }
    executionOwner.accepted = true;
    this.recordExecutionDiagnostic('execution-accepted', requestId, sourceId, 'execution-accepted', {
      ...(executionOwner.cellId ? { cellId: executionOwner.cellId } : {}),
    });
    this.sendExecutionAccepted(sourceId, requestId);
    let timeout: NodeJS.Timeout | undefined;
    let result: JupyterExecutionResult;
    try {
      this.recordExecutionDiagnostic('execution-started', requestId, sourceId, 'execution-started', {
        ...(executionOwner.cellId ? { cellId: executionOwner.cellId } : {}),
      });
      const execution = this.executeLocally(
        notebookKey,
        target,
        requestId,
        code,
        (event) => {
          if (executionOwner.eventOverflow) return;
          let payload: Uint8Array<ArrayBufferLike>;
          try {
            payload = encodeRemoteExecutionEvent(event);
          } catch (error) {
            executionOwner.eventOverflow = error instanceof Error ? error : new Error(String(error));
            void this.kernels.get(executionOwner.notebookKey)?.interrupt().catch(() => undefined);
            return;
          }
          const events = executionOwner.events ?? [];
          const nextBytes = (executionOwner.eventBytes ?? 0) + payload.byteLength;
          if (events.length >= MAX_REPLAYED_EXECUTION_EVENTS
            || nextBytes > MAX_REPLAYED_EXECUTION_EVENT_BYTES) {
            executionOwner.eventOverflow = new Error(
              'Remote Jupyter output exceeded the bounded reconnect replay queue.',
            );
            void this.kernels.get(executionOwner.notebookKey)?.interrupt().catch(() => undefined);
            return;
          }
          const record = { sequence: events.length, payload } satisfies RemoteExecutionEventRecord;
          events.push(record);
          executionOwner.events = events;
          executionOwner.eventBytes = nextBytes;
          if (event.type === 'inputRequest') executionOwner.inputRequestSequences?.add(record.sequence);

          if (executionOwner.outputState && executionOwner.cellId) {
            const authoritative = applyJupyterEventToState(executionOwner.outputState, event);
            if (authoritative.executionOrder !== undefined) {
              this.project.setCellExecution(executionOwner.notebookKey, executionOwner.cellId, {
                requestId,
                executionOrder: authoritative.executionOrder,
              });
            }
            if (authoritative.outputsChanged) {
              this.project.setCellOutputs(
                executionOwner.notebookKey,
                executionOwner.cellId,
                snapshotJupyterOutputs(executionOwner.outputState),
              );
            }
          }
          try {
            this.transport.sendTo(sourceId, 'executionEvent', {
              requestId,
              eventSequence: record.sequence,
            }, record.payload);
          } catch (error) {
            this.log.appendLine(`[debug] Jupyter event ${record.sequence} awaits route recovery: ${formatError(error)}`);
            this.deliverActiveRemoteExecution(requestId);
          }
        },
        materializeWorkspace,
      );
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          void this.kernels.get(executionOwner.notebookKey)?.interrupt().catch(() => undefined);
          reject(new Error('Remote execution timed out after four hours.'));
        }, REMOTE_EXECUTION_TIMEOUT_MS);
      });
      result = await Promise.race([execution, timedOut]);
    } catch (error) {
      result = {
        requestId,
        success: false,
        content: { status: 'error', ename: 'KernelError', evalue: formatError(error) },
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      if (executionOwner.replayTimer) clearTimeout(executionOwner.replayTimer);
      this.executionOwners.delete(requestId);
    }
    if (executionOwner.eventOverflow) {
      result = {
        requestId,
        success: false,
        content: {
          status: 'error',
          ename: 'OutputReplayLimit',
          evalue: executionOwner.eventOverflow.message,
        },
      };
    }
    if (executionOwner.outputState && executionOwner.cellId) {
      appendJupyterFailureToState(executionOwner.outputState, result);
      this.project.setCellOutputs(
        executionOwner.notebookKey,
        executionOwner.cellId,
        snapshotJupyterOutputs(executionOwner.outputState),
      );
      const resultCount = Number(result.content.execution_count);
      const executionOrder = executionOwner.outputState.executionOrder
        ?? (Number.isFinite(resultCount) ? resultCount : undefined);
      this.project.setCellExecution(executionOwner.notebookKey, executionOwner.cellId, {
        requestId,
        ...(executionOrder !== undefined ? { executionOrder } : {}),
        success: result.success,
        timing: {
          startTime: executionOwner.startedAt ?? Date.now(),
          endTime: Date.now(),
        },
      });
    }
    this.recordExecutionDiagnostic('execution-completed', requestId, sourceId, 'execution-completed', {
      ...(executionOwner.cellId ? { cellId: executionOwner.cellId } : {}),
      result: result.success ? 'success' : 'failure',
    });
    this.rememberCompletedRemoteExecution(
      sourceId,
      requestId,
      requestDigest,
      result,
      executionOwner.events ?? [],
      executionOwner.inputReplyDigests ?? new Map(),
    );
  }

  private async handleKernelCommand(frame: WireFrame, sourceId: string): Promise<void> {
    const requestId = String(frame.meta.requestId ?? '');
    const notebookKey = normalizedTrackedPath(String(frame.meta.notebookKey ?? ''));
    const target = normalizeComputeTarget(frame.meta.target, sourceId);
    const rejectCommand = (message: string): void => {
      if (!TRANSFER_ID_PATTERN.test(requestId)) return;
      this.transport.sendTo(sourceId, 'kernelCommandResult', { requestId, success: false, message });
    };
    if (!TRANSFER_ID_PATTERN.test(requestId) || !notebookKey || !target
      || (frame.meta.command !== 'interrupt' && frame.meta.command !== 'restart')) {
      rejectCommand('The remote kernel command is malformed.');
      return;
    }
    const targetError = this.remoteComputeTargetError(notebookKey, target);
    if (targetError) {
      rejectCommand(targetError);
      return;
    }
    const kernel = this.kernels.get(notebookKey);
    if (!kernel) {
      this.transport.sendTo(sourceId, 'kernelCommandResult', {
        requestId, success: false, message: `No running kernel exists for ${notebookKey}.`,
      });
      return;
    }
    try {
      if (frame.meta.command === 'interrupt') await kernel.interrupt();
      else if (frame.meta.command === 'restart') await kernel.restart();
      else throw new Error(`Unknown kernel command: ${String(frame.meta.command)}`);
      this.transport.sendTo(sourceId, 'kernelCommandResult', {
        requestId, notebookKey, command: frame.meta.command, success: true,
      });
    } catch (error) {
      this.transport.sendTo(sourceId, 'kernelCommandResult', {
        requestId, success: false, message: formatError(error),
      });
    }
  }

  private waitForHostTransfer(
    transferId: string,
    peerId: string,
    expectedClock: HostClock,
    timeoutMs: number,
    timeoutMessage: string,
    send: () => void,
  ): Promise<HostClock> {
    return new Promise<HostClock>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTransfers.delete(transferId);
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      this.pendingTransfers.set(transferId, { peerId, expectedClock, resolve, reject, timer });
      try {
        send();
      } catch (error) {
        clearTimeout(timer);
        this.pendingTransfers.delete(transferId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private resolveHostTransfer(transferId: string, sourceId: string, value: unknown): void {
    const clock = normalizeHostClock(value, this.coordinator.clock.sessionEpoch);
    const pending = this.pendingTransfers.get(transferId);
    if (!clock || !pending || pending.peerId !== sourceId || !sameClock(pending.expectedClock, clock)) return;
    clearTimeout(pending.timer);
    this.pendingTransfers.delete(transferId);
    pending.resolve(clock);
  }

  private sendKernelCommand(
    executorId: string,
    notebookKey: string,
    target: NotebookComputeTarget,
    command: 'interrupt' | 'restart',
  ): Promise<void> {
    const requestId = newId();
    return new Promise<void>((resolve, reject) => {
      const commandTimeoutMs = command === 'restart' ? 40_000 : 10_000;
      const routeTimeoutMs = EXECUTION_ACCEPT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pendingKernelCommands.delete(requestId);
        reject(new Error(`Remote kernel ${command} could not be delivered after route recovery.`));
      }, routeTimeoutMs + commandTimeoutMs);
      this.pendingKernelCommands.set(requestId, { executorId, resolve, reject, timer });
      void this.sendToWithRouteRecovery(
        executorId,
        'kernelCommand',
        { requestId, notebookKey, target, command },
        new Uint8Array(),
        routeTimeoutMs,
      ).then(() => {
        const pending = this.pendingKernelCommands.get(requestId);
        if (!pending || pending.executorId !== executorId) return;
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => {
          if (this.pendingKernelCommands.get(requestId) !== pending) return;
          this.pendingKernelCommands.delete(requestId);
          pending.reject(new Error(`Remote kernel ${command} timed out after delivery.`));
        }, commandTimeoutMs);
      }).catch((error) => {
        const pending = this.pendingKernelCommands.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingKernelCommands.delete(requestId);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private async executeLocally(
    notebookKey: string,
    target: NotebookComputeTarget,
    requestId: string,
    code: string,
    onEvent: (event: JupyterKernelEvent) => void,
    materializeWorkspace = true,
  ): Promise<JupyterExecutionResult> {
    const onRename = (from: string, to: string) => { if (notebookKey === from) notebookKey = to; };
    this.project.on('documentRenamed', onRename);
    try {
    // Python reads the physical working copy, including files whose current
    // canonical content is still owned by an unsaved VS Code editor.
    if (materializeWorkspace) {
      await this.prepareWorkingCopy?.();
      await this.flush();
    }
    let kernel = this.kernels.get(notebookKey);
    if (!kernel) {
      if (this.kernels.size >= MAX_LIVE_KERNELS) {
        const idleCandidate = [...this.kernels.keys()]
          .filter((key) => (this.notebookActiveExecutions.get(key) ?? 0) === 0)
          .sort((a, b) => (this.kernelLastUsed.get(a) ?? 0) - (this.kernelLastUsed.get(b) ?? 0))[0];
        if (!idleCandidate) throw new Error(`All ${MAX_LIVE_KERNELS} kernel slots are busy.`);
        this.kernels.get(idleCandidate)?.stop();
        this.kernels.delete(idleCandidate);
        this.kernelLastUsed.delete(idleCandidate);
        this.kernelStatuses.delete(idleCandidate);
      }
      this.transition('kernel-starting', `Starting Jupyter kernel for ${notebookKey}.`);
      const configuration = vscode.workspace.getConfiguration('pairNotebook');
      const pythonPath = target.pythonPath
        ?? this.descriptor.notebookPythonPaths?.[notebookKey]
        ?? configuration.get<string>('pythonPath', this.descriptor.pythonPath || 'python');
      const gpuMatch = /^gpu:(\d+)$/.exec(target.device);
      kernel = new JupyterKernel(
        pythonPath,
        vscode.Uri.joinPath(this.context.extensionUri, 'media', 'jupyter_kernel_bridge.py').fsPath,
        this.descriptor.workingFolder,
        gpuMatch ? Number(gpuMatch[1]) : undefined,
      );
      kernel.on('stderr', (message) => this.log.appendLine(`[jupyter] ${String(message).trimEnd()}`));
      kernel.on('protocolError', (error) => this.log.appendLine(`[error] Jupyter protocol: ${formatError(error)}`));
      kernel.on('exit', () => {
        const currentKey = [...this.kernels].find(([, candidate]) => candidate === kernel)?.[0];
        if (!currentKey) return;
        this.kernels.delete(currentKey);
        this.kernelLastUsed.delete(currentKey);
        this.setKernelStatus(currentKey, 'Offline');
      });
      this.kernels.set(notebookKey, kernel);
    }
    this.kernelLastUsed.set(notebookKey, Date.now());
    const listener = (event: JupyterKernelEvent) => {
      if (event.requestId === requestId) onEvent(event);
    };
    kernel.on('event', listener);
    this.executionOwners.set(requestId, this.executionOwners.get(requestId) ?? {
      peerId: this.descriptor.localPeer.peerId,
      notebookKey,
      accepted: true,
    });
    this.activeExecutions += 1;
    this.notebookActiveExecutions.set(notebookKey, (this.notebookActiveExecutions.get(notebookKey) ?? 0) + 1);
    this.setKernelStatus(notebookKey, 'Busy');
    this.transition('executing', `Executing ${notebookKey} locally.`);
    let executionTimeout: NodeJS.Timeout | undefined;
    try {
      const timedOut = new Promise<never>((_resolve, reject) => {
        executionTimeout = setTimeout(() => {
          void kernel.interrupt().catch(() => undefined);
          reject(new Error('Pair kernel execution timed out after ten minutes and was interrupted.'));
        }, KERNEL_EXECUTION_TIMEOUT_MS);
      });
      return await Promise.race([
        kernel.execute(requestId, code),
        timedOut,
        this.terminalCancellation(),
      ]);
    } catch (error) {
      if (!(error instanceof SessionClosedError)) {
        this.transition('kernel-failed', formatError(error));
      }
      throw error;
    } finally {
      if (executionTimeout) clearTimeout(executionTimeout);
      kernel.off('event', listener);
      if (this.executionOwners.get(requestId)?.peerId === this.descriptor.localPeer.peerId) this.executionOwners.delete(requestId);
      this.activeExecutions = Math.max(0, this.activeExecutions - 1);
      const notebookExecutions = Math.max(0, (this.notebookActiveExecutions.get(notebookKey) ?? 1) - 1);
      if (notebookExecutions) this.notebookActiveExecutions.set(notebookKey, notebookExecutions);
      else this.notebookActiveExecutions.delete(notebookKey);
      this.setKernelStatus(notebookKey, notebookExecutions ? 'Busy' : 'Idle');
      if (this.runtimeState !== 'kernel-failed') {
        this.transition(this.activeExecutions ? 'executing' : 'ready', this.activeExecutions
          ? 'Another notebook execution is still active.'
          : `Execution finished for ${notebookKey}.`);
      }
    }
    } finally { this.project.off('documentRenamed', onRename); }
  }

  private setKernelStatus(notebookKey: string, status: 'Idle' | 'Busy' | 'Offline'): void {
    this.kernelStatuses.set(notebookKey, status);
    const values = [...this.kernelStatuses.values()];
    this.kernelStatus = values.includes('Busy') ? 'Busy' : values.includes('Idle') ? 'Idle' : 'Offline';
    this.emit('kernel', status, notebookKey);
    this.publishKernelPresence();
  }

  private relativeKey(uri: vscode.Uri, includeIgnored = false): string | undefined {
    if (uri.scheme !== 'file') return undefined;
    const relative = path.relative(this.descriptor.workingFolder, uri.fsPath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
    let key: string;
    try {
      key = safeRelativePath(relative).split(path.sep).join('/');
    } catch {
      return undefined;
    }
    if (!includeIgnored && !shouldTrackProjectPath(key)) return undefined;
    return key;
  }

  private asRuntime(peer: PeerIdentity, online: boolean): PeerRuntime {
    return {
      ...peer,
      latency: peer.peerId === this.descriptor.localPeer.peerId ? 0 : -1,
      latencyEma: peer.peerId === this.descriptor.localPeer.peerId ? 0 : -1,
      lastHeartbeat: Date.now(),
      missedHeartbeats: 0,
      route: peer.peerId === this.descriptor.localPeer.peerId ? 'Direct' : 'Unknown',
      online,
      connectionState: online ? 'connected' : 'disconnected',
    };
  }

  private transition(state: RuntimeState, detail: string): void {
    if (this.runtimeState === state && this.runtimeDetail === detail) return;
    this.runtimeState = state;
    this.runtimeDetail = detail;
    this.log.appendLine(`[state:${state}] ${detail}`);
    this.emit('state', state, detail);
  }

  public async inspectBackingFolder(folder: string): Promise<BackingFolderInspection> {
    if (!this.coordinator.isCurrentHost()) throw new Error('Only the current Session Host can inspect a shared backing folder.');
    const resolved = await this.validateBackingFolder(folder);
    if (!this.storage) throw new Error('Session storage is not ready.');
    const snapshot = await this.collectMaterialization();
    return this.storage.inspectMaterializedFolder(
      resolved,
      snapshot.documents,
      snapshot.binaries,
      snapshot.directories,
    );
  }

  public async setBackingFolder(folder: string, mode: BackingFolderMode = 'replace'): Promise<void> {
    if (!this.coordinator.isCurrentHost()) throw new Error('Only the current Session Host can choose the shared backing folder.');
    const resolved = await this.validateBackingFolder(folder);
    if (!this.storage) throw new Error('Session storage is not ready.');
    const previous = this.descriptor.backingFolder;
    if (mode === 'reuse-existing') {
      const snapshot = await this.collectMaterialization();
      const inspection = await this.storage.bindExistingBacking(
        resolved,
        snapshot.documents,
        snapshot.binaries,
        snapshot.directories,
      );
      if (!inspection.matches) throw new BackingFolderMismatchError(inspection);
    } else {
      this.storage.setBackingRoot(resolved);
    }
    this.descriptor.backingFolder = resolved;
    try {
      if (mode === 'replace') await this.materializeBackingFolder();
      await this.persistDescriptor();
      await this.onHostStorageReady(this.descriptor.localPeer.peerId);
      this.transport.broadcast('hostStorageReady', { clock: this.coordinator.clock });
    } catch (error) {
      this.descriptor.backingFolder = previous;
      this.storage.setBackingRoot(previous && !this.waitingForHostFolder ? previous : undefined);
      throw error;
    }
  }

  private async validateBackingFolder(folder: string): Promise<string> {
    const [resolved, workingFolder, autosaveFolder] = await Promise.all([
      canonicalFolderPath(folder),
      canonicalFolderPath(this.descriptor.workingFolder),
      canonicalFolderPath(this.autosaveState.folder),
    ]);
    if (pathsOverlap(resolved, workingFolder)) {
      throw new Error('The shared backing folder must be outside the isolated working copy.');
    }
    if (pathsOverlap(resolved, autosaveFolder)) {
      throw new Error('The shared backing folder must be separate from the local autosave folder.');
    }
    return resolved;
  }

  private async normalizeRestoredBackingFolder(): Promise<void> {
    if (!this.descriptor.backingFolder) return;
    const [backingFolder, workingFolder] = await Promise.all([
      canonicalFolderPath(this.descriptor.backingFolder),
      canonicalFolderPath(this.descriptor.workingFolder),
    ]);
    if (pathsOverlap(backingFolder, workingFolder)) {
      this.descriptor.backingFolder = '';
      this.waitingForHostFolder = this.coordinator.isCurrentHost();
      this.log.appendLine('[error] Restored backing folder overlaps the isolated working copy; select a separate host folder.');
      return;
    }
    this.descriptor.backingFolder = backingFolder;
  }

  private async persistDescriptor(): Promise<void> {
    if (this.closed) return this.descriptorWriteQueue;
    this.descriptor.fileStates = Object.fromEntries(this.fileStates);
    this.descriptor.fileRevisionCounter = this.fileRevisionCounter;
    this.descriptor.binaryVersions = Object.fromEntries(this.binaryVersions);
    const marker = path.join(this.descriptor.workingFolder, '.pair-notebook-session.json');
    const contents = `${JSON.stringify(this.descriptor, null, 2)}\n`;
    const previous = this.descriptorWriteQueue;
    const write = previous.catch(() => undefined).then(() => atomicWriteFile(marker, contents));
    this.descriptorWriteQueue = write;
    return write;
  }

  private persistDescriptorInBackground(): void {
    this.runBackground('Session descriptor persistence', () => this.persistDescriptor());
  }

  private runBackground(label: string, action: () => unknown | Promise<unknown>): void {
    try {
      void Promise.resolve(action()).catch((error) => {
        this.log.appendLine(`[error] ${label}: ${formatError(error)}`);
      });
    } catch (error) {
      this.log.appendLine(`[error] ${label}: ${formatError(error)}`);
    }
  }

  private async writeWorkingCopy(relativePath: string, bytes: Uint8Array): Promise<boolean> {
    if (this.workingCopyWriter) return this.workingCopyWriter(relativePath, bytes);
    // SessionRuntime starts before restored notebook tabs have necessarily been
    // rebound by VS Code. Defer every working-copy document until
    // EditorSynchronizer is attached; the backing copy can still be written
    // directly from CRDT bytes, and setWorkingCopyWriter() requeues all paths.
    // Headless/integration runtimes fall back to atomic disk writes after the
    // short binding window, so the runtime remains usable without the UI layer.
    return this.deferWorkingCopyWrites;
  }

  private armWorkingCopyFallback(): void {
    if (this.workingCopyWriter || this.workingCopyFallbackTimer || this.closed) return;
    this.workingCopyFallbackTimer = setTimeout(() => {
      this.workingCopyFallbackTimer = undefined;
      this.deferWorkingCopyWrites = false;
      for (const key of this.project.keys()) this.storage?.schedule(key);
    }, EDITOR_BINDING_GRACE_MS);
    this.workingCopyFallbackTimer.unref?.();
  }

  private isOpenInEditor(relativePath: string): boolean {
    return vscode.workspace.notebookDocuments.some((document) => this.relativeKey(document.uri) === relativePath)
      || vscode.workspace.textDocuments.some((document) =>
        document.uri.scheme !== 'vscode-notebook-cell' && this.relativeKey(document.uri) === relativePath);
  }

  private rememberInternalWorkingWrite(relativePath: string, bytes: Uint8Array): void {
    this.rememberInternalWorkingHash(relativePath, createHash('sha256').update(bytes).digest('hex'));
  }

  private rememberInternalWorkingHash(relativePath: string, hash: string): void {
    const now = Date.now();
    const recent = (this.internalWorkingWrites.get(relativePath) ?? [])
      .filter((entry) => entry.expiresAt > now && entry.hash !== hash);
    recent.push({ hash, expiresAt: now + INTERNAL_WRITE_GUARD_MS });
    this.internalWorkingWrites.set(relativePath, recent.slice(-8));
  }

  private matchesInternalWorkingWrite(relativePath: string, bytes: Uint8Array): boolean {
    const now = Date.now();
    const recent = (this.internalWorkingWrites.get(relativePath) ?? []).filter((entry) => entry.expiresAt > now);
    if (!recent.length) {
      this.internalWorkingWrites.delete(relativePath);
      return false;
    }
    this.internalWorkingWrites.set(relativePath, recent);
    const hash = createHash('sha256').update(bytes).digest('hex');
    return recent.some((entry) => entry.hash === hash);
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const first = filesystemPathComparisonKey(left);
  const second = filesystemPathComparisonKey(right);
  if (first === second) return true;
  const firstToSecond = path.relative(first, second);
  const secondToFirst = path.relative(second, first);
  return isChildPath(firstToSecond) || isChildPath(secondToFirst);
}

async function canonicalFolderPath(value: string): Promise<string> {
  let current = path.resolve(value);
  const missing: string[] = [];
  for (;;) {
    try {
      const canonical = await realpath(current);
      return path.join(canonical, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function isChildPath(relativePath: string): boolean {
  return Boolean(relativePath) && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

function isBackgroundMessage(type: string): boolean {
  return BACKGROUND_MESSAGE_TYPES.has(type);
}

function resolveHostIdentity(descriptor: SessionDescriptor, hostPeerId: string): PeerIdentity {
  const stored = (descriptor.knownPeers ?? []).find((peer) => peer.peerId === hostPeerId);
  return stored ?? {
    peerId: hostPeerId,
    displayName: 'Session Host',
    joinOrder: 0,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function lineFromSelection(position: unknown): number | undefined {
  if (!position || typeof position !== 'object') return undefined;
  const line = (position as { line?: unknown }).line;
  return typeof line === 'number' && Number.isSafeInteger(line) && line >= 0 ? line : undefined;
}

function offsetForLine(source: string, line: number | undefined): number | undefined {
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 0) return undefined;
  let offset = 0;
  for (let index = 0; index < line; index += 1) {
    const newline = source.indexOf('\n', offset);
    if (newline < 0) return undefined;
    offset = newline + 1;
  }
  return offset;
}

function lineStartOffset(source: string, offset: number): number {
  const bounded = Math.max(0, Math.min(source.length, offset));
  const newline = source.lastIndexOf('\n', Math.max(0, bounded - 1));
  return newline + 1;
}

function lineEndOffset(source: string, start: number): number {
  const newline = source.indexOf('\n', start);
  return newline < 0 ? source.length : newline + 1;
}

function changeTouchesLine(
  change: { rangeOffset: number; rangeLength: number },
  lineStart: number,
  lineEnd: number,
): boolean {
  const start = Math.max(0, change.rangeOffset);
  const end = Math.max(start, start + change.rangeLength);
  return change.rangeLength === 0
    ? start >= lineStart && start <= lineEnd
    : start < lineEnd && end > lineStart;
}

function comparePeerPriority(left: PeerIdentity, right: PeerIdentity): number {
  return left.joinOrder - right.joinOrder || left.peerId.localeCompare(right.peerId);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runtimeDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function executionDeliveryRetryMs(retainedBytes: number): number {
  const estimatedTransferMs = Math.ceil(Math.max(0, retainedBytes) / (512 * 1024)) * 1_000;
  return Math.max(EXECUTION_RESULT_RETRY_MS, Math.min(60_000, estimatedTransferMs));
}

function isRouteUnavailableError(error: unknown): boolean {
  return /no (?:authenticated )?route to peer|peer .+ disconnected during transfer/i.test(formatError(error));
}

function binaryAckKey(peerId: string, relativePath: string, hash: string, version: number, author: string): string {
  return JSON.stringify([peerId, relativePath, hash, version, author]);
}

/** Binds an incoming transfer to the peer that started it. */
function transferKey(sourceId: string, transferId: string): string {
  return `${sourceId}\u0000${transferId}`;
}

/** Derives a scratch file name that can never escape the transfer directory. */
function transferFileName(sourceId: string, transferId: string): string {
  return `${createHash('sha256').update(transferKey(sourceId, transferId)).digest('hex')}.part`;
}

/** Streams a file through SHA-256 with a bounded, reusable buffer. */
async function hashFile(absolutePath: string, chunkSize = BINARY_CHUNK_SIZE): Promise<string> {
  const handle = await open(absolutePath, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(chunkSize);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

interface InspectedAwarenessRecord {
  clientId: number;
  state: unknown;
}

function inspectAwarenessUpdate(update: Uint8Array): InspectedAwarenessRecord[] {
  let offset = 0;
  const readVarUint = (): number => {
    let value = 0;
    let multiplier = 1;
    for (let index = 0; index < 8; index += 1) {
      if (offset >= update.byteLength) throw new Error('Awareness update ended inside a variable-length integer.');
      const byte = update[offset++];
      if (byte === undefined) throw new Error('Awareness update ended inside a variable-length integer.');
      value += (byte & 0x7f) * multiplier;
      if (!Number.isSafeInteger(value)) throw new Error('Awareness update contains an unsafe integer.');
      if ((byte & 0x80) === 0) return value;
      multiplier *= 128;
    }
    throw new Error('Awareness update contains an overlong integer.');
  };
  const count = readVarUint();
  if (count > MAX_AWARENESS_CLIENTS_PER_UPDATE) {
    throw new Error('Awareness update exceeds the client-count limit.');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const records: InspectedAwarenessRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const clientId = readVarUint();
    readVarUint(); // logical clock; the protocol applies monotonicity itself
    const length = readVarUint();
    if (clientId > 0xffff_ffff || length > 256 * 1024 || offset + length > update.byteLength) {
      throw new Error('Awareness update contains an invalid client id or state length.');
    }
    const rawState = decoder.decode(update.subarray(offset, offset + length));
    offset += length;
    let state: unknown;
    try {
      state = JSON.parse(rawState);
    } catch {
      throw new Error('Awareness update contains invalid JSON.');
    }
    records.push({ clientId, state });
  }
  if (offset !== update.byteLength) throw new Error('Awareness update contains trailing bytes.');
  return records;
}

function normalizeStoredPresence(value: unknown): PresenceState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rawPeer = (value as { peer?: unknown }).peer;
  if (!rawPeer || typeof rawPeer !== 'object' || Array.isArray(rawPeer)) return undefined;
  const peer = rawPeer as Partial<PeerIdentity>;
  if (!validPeerId(peer.peerId) || validateDisplayName(peer.displayName)
    || !Number.isSafeInteger(peer.joinOrder) || (peer.joinOrder ?? -1) < 0) return undefined;
  return sanitizePresenceState(value, {
    peerId: peer.peerId,
    displayName: cleanDisplayName(peer.displayName as string),
    joinOrder: peer.joinOrder as number,
  });
}

function sanitizePresenceState(value: unknown, identity: PeerIdentity): PresenceState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const activeFile = typeof raw.activeFile === 'string' && raw.activeFile.length <= 4096
    ? normalizedTrackedPath(raw.activeFile)
    : undefined;
  const activeNotebookCell = boundedNumber(raw.activeNotebookCell, 0, 1_000_000, true);
  const activeNotebookCellId = typeof raw.activeNotebookCellId === 'string'
    && /^[A-Za-z0-9_-]{1,128}$/.test(raw.activeNotebookCellId)
    ? raw.activeNotebookCellId
    : undefined;
  const activeLine = boundedNumber(raw.activeLine, 0, 1_000_000, true);
  const activeLineAnchor = encodedCursorPosition(raw.activeLineAnchor);
  const cursor = sanitizeCursor(raw.cursor);
  const hardware = sanitizeHardware(raw.hardware);
  const environments = sanitizeEnvironments(raw.environments);
  const resources = sanitizeResources(raw.resources);
  const kernelStatus = normalizeKernelStatus(raw.kernelStatus) ?? 'Offline';
  const kernelStatuses = sanitizeKernelStatuses(raw.kernelStatuses);
  return {
    peer: { ...identity, displayName: cleanDisplayName(identity.displayName) },
    activeFile,
    activeNotebookCell,
    activeNotebookCellId,
    activeLine,
    activeLineAnchor,
    cursor,
    shareCursor: raw.shareCursor === true,
    cursorColor: typeof raw.cursorColor === 'string' && /^#[0-9a-f]{6}$/i.test(raw.cursorColor)
      ? raw.cursorColor
      : '#4FC3F7',
    typing: raw.typing === true,
    hardware,
    environments,
    resources,
    kernelStatus,
    kernelStatuses,
  };
}

function sanitizeCursor(value: unknown): SharedCursorPosition | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<SharedCursorPosition>;
  const anchor = boundedNumber(raw.anchor, 0, 1_000_000_000, true);
  const active = boundedNumber(raw.active, 0, 1_000_000_000, true);
  if (anchor === undefined || active === undefined) return undefined;
  const relativeAnchor = encodedCursorPosition(raw.relativeAnchor);
  const relativeActive = encodedCursorPosition(raw.relativeActive);
  return { anchor, active, relativeAnchor, relativeActive };
}

function encodedCursorPosition(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
    ? value
    : undefined;
}

function sanitizeHardware(value: unknown): HardwareInfo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const cpuModel = boundedString(raw.cpuModel, 256);
  const logicalThreads = boundedNumber(raw.logicalThreads, 1, 4096, true);
  const totalRamMb = boundedNumber(raw.totalRamMb, 0, 1_000_000_000, true);
  const availableRamMb = boundedNumber(raw.availableRamMb, 0, 1_000_000_000, true);
  const discoveredAt = boundedNumber(raw.discoveredAt, 0, Number.MAX_SAFE_INTEGER, true);
  const python = sanitizePythonInfo(raw.python);
  if (!cpuModel || logicalThreads === undefined || totalRamMb === undefined
    || availableRamMb === undefined || discoveredAt === undefined || !python) return undefined;
  const gpus = Array.isArray(raw.gpus)
    ? raw.gpus.slice(0, 16).map(sanitizeGpuInfo).filter((gpu): gpu is HardwareInfo['gpus'][number] => Boolean(gpu))
    : [];
  const physicalCores = boundedNumber(raw.physicalCores, 1, 4096, true);
  return { cpuModel, physicalCores, logicalThreads, totalRamMb, availableRamMb, gpus, python, discoveredAt };
}

function sanitizeGpuInfo(value: unknown): HardwareInfo['gpus'][number] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const index = boundedNumber(raw.index, 0, 1024, true);
  const vendor = boundedString(raw.vendor, 128);
  const model = boundedString(raw.model, 256);
  const vramMb = boundedNumber(raw.vramMb, 0, 100_000_000, true);
  const driver = boundedString(raw.driver, 128) ?? '';
  const cudaVersion = boundedString(raw.cudaVersion, 128) ?? '';
  const utilizationPercent = boundedNumber(raw.utilizationPercent, 0, 100) ?? 0;
  const memoryUsedMb = boundedNumber(raw.memoryUsedMb, 0, 100_000_000) ?? 0;
  if (index === undefined || !vendor || !model || vramMb === undefined) return undefined;
  return { index, vendor, model, vramMb, driver, cudaVersion, utilizationPercent, memoryUsedMb };
}

function sanitizePythonInfo(value: unknown): HardwareInfo['python'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const executable = boundedString(raw.executable, 4096, false);
  const version = boundedString(raw.version, 128) ?? 'Unavailable';
  if (!executable) return undefined;
  return {
    executable,
    version,
    torchInstalled: raw.torchInstalled === true,
    torchVersion: boundedString(raw.torchVersion, 128) ?? '',
    torchCudaAvailable: raw.torchCudaAvailable === true,
    torchCudaVersion: boundedString(raw.torchCudaVersion, 128) ?? '',
    cudaDeviceNames: Array.isArray(raw.cudaDeviceNames)
      ? raw.cudaDeviceNames.slice(0, 16).map((item) => boundedString(item, 256)).filter((item): item is string => Boolean(item))
      : [],
  };
}

function sanitizeEnvironments(value: unknown): PythonEnvironment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: PythonEnvironment[] = [];
  for (const item of value.slice(0, 32)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const executable = boundedString(raw.executable, 4096, false);
    const version = boundedString(raw.version, 128);
    const environment = boundedString(raw.environment, 4096, false);
    const source = boundedString(raw.source, 256);
    if (!executable || !version || !environment || !source) continue;
    result.push({
      executable,
      version,
      environment,
      source,
      jupyterReady: raw.jupyterReady === true,
      torchVersion: boundedString(raw.torchVersion, 128) ?? '',
      cudaAvailable: raw.cudaAvailable === true,
    });
  }
  return result;
}

function sanitizeResources(value: unknown): ResourceSample | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const cpuPercent = boundedNumber(raw.cpuPercent, 0, 100);
  const ramUsedMb = boundedNumber(raw.ramUsedMb, 0, 1_000_000_000);
  const ramTotalMb = boundedNumber(raw.ramTotalMb, 0, 1_000_000_000);
  const sampledAt = boundedNumber(raw.sampledAt, 0, Number.MAX_SAFE_INTEGER, true);
  if (cpuPercent === undefined || ramUsedMb === undefined || ramTotalMb === undefined || sampledAt === undefined) return undefined;
  const gpus: ResourceSample['gpus'] = [];
  if (Array.isArray(raw.gpus)) {
    for (const item of raw.gpus.slice(0, 16)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const gpu = item as Record<string, unknown>;
      const index = boundedNumber(gpu.index, 0, 1024, true);
      const utilizationPercent = boundedNumber(gpu.utilizationPercent, 0, 100);
      const memoryUsedMb = boundedNumber(gpu.memoryUsedMb, 0, 100_000_000);
      const vramMb = boundedNumber(gpu.vramMb, 0, 100_000_000);
      if (index !== undefined && utilizationPercent !== undefined && memoryUsedMb !== undefined && vramMb !== undefined) {
        gpus.push({ index, utilizationPercent, memoryUsedMb, vramMb });
      }
    }
  }
  return { cpuPercent, ramUsedMb, ramTotalMb, gpus, sampledAt };
}

function sanitizeKernelStatuses(value: unknown): Record<string, 'Idle' | 'Busy' | 'Offline'> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, 'Idle' | 'Busy' | 'Offline'> = {};
  for (const [rawKey, rawStatus] of Object.entries(value).slice(0, 128)) {
    const key = rawKey === '*' ? '*' : normalizedTrackedPath(rawKey);
    const status = normalizeKernelStatus(rawStatus);
    if (key && status) result[key] = status;
  }
  return Object.keys(result).length ? result : undefined;
}

function normalizeKernelStatus(value: unknown): 'Idle' | 'Busy' | 'Offline' | undefined {
  return value === 'Idle' || value === 'Busy' || value === 'Offline' ? value : undefined;
}

function boundedString(value: unknown, maximum: number, allowEmpty = true): string | undefined {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || (!allowEmpty && !value.trim())) return undefined;
  return value;
}

function boundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
  integer = false,
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) return undefined;
  if (integer && !Number.isSafeInteger(value)) return undefined;
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function estimateMetadataBytes(meta: Record<string, unknown>): number {
  try {
    return Math.min(1024 * 1024, Buffer.byteLength(JSON.stringify(meta), 'utf8'));
  } catch {
    return 1024 * 1024;
  }
}

function metadataEntryBytes(key: string, value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify([key, value]), 'utf8') + 32;
  } catch {
    throw new Error(`Session metadata for ${key} is not serializable.`);
  }
}

function normalizeExecutionManifest(value: unknown, fallbackAuthor: string): ExecutionManifest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<ExecutionManifest>;
  if (!raw.documents || typeof raw.documents !== 'object' || Array.isArray(raw.documents)
    || !raw.binaries || typeof raw.binaries !== 'object' || Array.isArray(raw.binaries)
    || !Array.isArray(raw.directories)) return undefined;
  const documentEntries = Object.entries(raw.documents);
  const binaryEntries = Object.entries(raw.binaries);
  if (documentEntries.length + binaryEntries.length + raw.directories.length > MAX_EXECUTION_MANIFEST_ENTRIES) {
    return undefined;
  }
  const documents = Object.create(null) as Record<string, string>;
  const portableFileKeys = new Set<string>();
  for (const [rawKey, rawHash] of documentEntries) {
    const key = normalizedTrackedPath(rawKey);
    const portableKey = key ? portablePathComparisonKey(key) : '';
    if (!key || key in documents || portableFileKeys.has(portableKey)
      || typeof rawHash !== 'string' || !/^[a-f0-9]{64}$/.test(rawHash)) return undefined;
    portableFileKeys.add(portableKey);
    documents[key] = rawHash;
  }
  const binaries = Object.create(null) as Record<string, BinaryFileVersion>;
  for (const [rawKey, rawVersion] of binaryEntries) {
    const key = normalizedTrackedPath(rawKey);
    const version = normalizeBinaryVersion(rawVersion, fallbackAuthor);
    const portableKey = key ? portablePathComparisonKey(key) : '';
    if (!key || key in binaries || portableFileKeys.has(portableKey) || !version) return undefined;
    portableFileKeys.add(portableKey);
    binaries[key] = version;
  }
  const directories: string[] = [];
  const portableDirectoryKeys = new Set<string>();
  for (const rawDirectory of raw.directories) {
    if (typeof rawDirectory !== 'string') return undefined;
    const directory = normalizedTrackedPath(rawDirectory);
    const portableKey = directory ? portablePathComparisonKey(directory) : '';
    if (!directory || portableDirectoryKeys.has(portableKey) || portableFileKeys.has(portableKey)) return undefined;
    portableDirectoryKeys.add(portableKey);
    directories.push(directory);
  }
  for (const relativePath of [...Object.keys(documents), ...Object.keys(binaries), ...directories]) {
    const segments = relativePath.split('/');
    for (let length = 1; length < segments.length; length += 1) {
      const parentKey = portablePathComparisonKey(segments.slice(0, length).join('/'));
      if (portableFileKeys.has(parentKey) || !portableDirectoryKeys.has(parentKey)) return undefined;
    }
  }
  directories.sort();
  return { documents, binaries, directories };
}

function encodeRemoteExecutionEvent(event: JupyterKernelEvent): Uint8Array<ArrayBufferLike> {
  let payload: Buffer;
  try {
    payload = Buffer.from(JSON.stringify(event), 'utf8');
  } catch (error) {
    throw new Error(`Could not serialize the remote Jupyter event: ${formatError(error)}`);
  }
  if (payload.byteLength > MAX_REPLAYED_EXECUTION_EVENT_BYTES) {
    throw new Error('A remote Jupyter event exceeded the reconnect replay byte limit.');
  }
  return payload;
}

function decodeRemoteExecutionEvent(
  frame: WireFrame,
  expectedRequestId: string,
): { event: JupyterKernelEvent; byteLength: number } | undefined {
  let value: unknown;
  let byteLength: number;
  if (frame.payload.byteLength) {
    if (frame.payload.byteLength > MAX_REPLAYED_EXECUTION_EVENT_BYTES) return undefined;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.payload));
    } catch {
      return undefined;
    }
    byteLength = frame.payload.byteLength;
  } else {
    // Compatibility with version 0.5.3, which put the event in frame metadata.
    value = frame.meta.event;
    try {
      byteLength = Buffer.byteLength(JSON.stringify(value), 'utf8');
    } catch {
      return undefined;
    }
    if (byteLength > MAX_REPLAYED_EXECUTION_EVENT_BYTES) return undefined;
  }
  const event = normalizeRemoteJupyterEvent(value, expectedRequestId);
  return event ? { event, byteLength } : undefined;
}

function normalizeRemoteJupyterEvent(value: unknown, expectedRequestId: string): JupyterKernelEvent | undefined {
  if (!isPlainRecord(value) || value.requestId !== expectedRequestId
    || typeof value.type !== 'string' || !REMOTE_JUPYTER_EVENT_TYPES.has(value.type)) return undefined;
  if (value.content !== undefined && !isPlainRecord(value.content)) return undefined;
  if (value.metadata !== undefined && !isPlainRecord(value.metadata)) return undefined;
  let buffersBase64: string[] | undefined;
  if (value.buffersBase64 !== undefined) {
    if (!Array.isArray(value.buffersBase64) || value.buffersBase64.length > 16) return undefined;
    buffersBase64 = [];
    for (const item of value.buffersBase64) {
      if (typeof item !== 'string' || item.length > MAX_REMOTE_JUPYTER_BUFFER_BASE64_CHARACTERS
        || item.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item)) return undefined;
      buffersBase64.push(item);
    }
  }
  const executionCount = value.executionCount === null
    ? null
    : boundedNumber(value.executionCount, 0, Number.MAX_SAFE_INTEGER, true);
  if (value.executionCount !== undefined && executionCount === undefined) return undefined;
  return {
    type: value.type as JupyterKernelEvent['type'],
    requestId: expectedRequestId,
    messageType: boundedString(value.messageType, 128),
    content: value.content as Record<string, any> | undefined,
    metadata: value.metadata as Record<string, any> | undefined,
    buffersBase64,
    success: typeof value.success === 'boolean' ? value.success : undefined,
    executionCount,
    command: boundedString(value.command, 64),
    channel: boundedString(value.channel, 64),
    message: boundedString(value.message, 64 * 1024),
    traceback: boundedString(value.traceback, 256 * 1024),
  };
}

function encodeRemoteExecutionResult(result: JupyterExecutionResult): Uint8Array<ArrayBufferLike> {
  let payload: Buffer;
  try {
    payload = Buffer.from(JSON.stringify(result), 'utf8');
  } catch (error) {
    throw new Error(`Could not serialize the remote execution result: ${formatError(error)}`);
  }
  if (payload.byteLength > MAX_REPLAYED_EXECUTION_EVENT_BYTES) {
    throw new Error('The remote execution result exceeded the replay byte limit.');
  }
  return payload;
}

function decodeRemoteExecutionResult(frame: WireFrame, expectedRequestId: string): JupyterExecutionResult | undefined {
  let value: unknown;
  if (frame.payload.byteLength) {
    if (frame.payload.byteLength > MAX_REPLAYED_EXECUTION_EVENT_BYTES) return undefined;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.payload));
    } catch {
      return undefined;
    }
  } else {
    // Compatibility with version 0.5.3, which put the result in frame metadata.
    value = frame.meta.result;
  }
  return normalizeRemoteExecutionResult(value, expectedRequestId);
}

function normalizeRemoteExecutionResult(value: unknown, expectedRequestId: string): JupyterExecutionResult | undefined {
  if (!isPlainRecord(value) || value.requestId !== expectedRequestId
    || typeof value.success !== 'boolean' || !isPlainRecord(value.content)) return undefined;
  const executionCount = value.executionCount === null
    ? null
    : boundedNumber(value.executionCount, 0, Number.MAX_SAFE_INTEGER, true);
  if (value.executionCount !== undefined && executionCount === undefined) return undefined;
  return {
    requestId: expectedRequestId,
    success: value.success,
    executionCount,
    content: value.content,
  };
}

function normalizeCompletedSnapshot(value: unknown): Record<string, string> {
  if (!isPlainRecord(value)) return {};
  const entries = Object.entries(value);
  if (entries.length > MAX_EXECUTION_MANIFEST_ENTRIES) throw new Error('Snapshot resume manifest exceeds the entry limit.');
  const result = Object.create(null) as Record<string, string>;
  const portablePaths = new Set<string>();
  for (const [rawPath, rawHash] of entries) {
    const relativePath = normalizedTrackedPath(rawPath);
    const portablePath = relativePath ? portablePathComparisonKey(relativePath) : '';
    if (!relativePath || portablePaths.has(portablePath)
      || typeof rawHash !== 'string' || !/^[a-f0-9]{64}$/.test(rawHash)) {
      throw new Error('Snapshot resume manifest is malformed.');
    }
    portablePaths.add(portablePath);
    result[relativePath] = rawHash;
  }
  return result;
}

function normalizeSnapshotGenerationId(value: unknown): string {
  const snapshotId = String(value ?? '');
  if (!TRANSFER_ID_PATTERN.test(snapshotId)) {
    throw new Error('Snapshot generation id is malformed.');
  }
  return snapshotId;
}

function executionManifestDigest(manifest: ExecutionManifest): string {
  const normalized = {
    documents: Object.fromEntries(Object.entries(manifest.documents).sort(([a], [b]) => a.localeCompare(b))),
    binaries: Object.fromEntries(Object.entries(manifest.binaries).sort(([a], [b]) => a.localeCompare(b))),
    directories: [...manifest.directories].sort(),
  };
  return createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex');
}

function cellTextRevisionSequence(revision: string): number | undefined {
  const match = /^r([1-9][0-9]*)_[A-Za-z0-9_-]{1,96}$/.exec(revision);
  if (!match) return undefined;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : undefined;
}

function canonicalCellTextDigest(source: string): string {
  return createHash('sha256').update(source, 'utf8').digest('hex');
}

function normalizeLightweightExecutionRequest(meta: Record<string, unknown>): LightweightExecutionRequest | undefined {
  const notebookKey = normalizedTrackedPath(String(meta.notebookKey ?? ''));
  const cellId = String(meta.cellId ?? '');
  const executorId = String(meta.executorId ?? '');
  const computeEpoch = meta.computeEpoch;
  const cellRevision = String(meta.cellRevision ?? '');
  const cellDigest = String(meta.cellDigest ?? '');
  if (!notebookKey || !PEER_ID_PATTERN.test(cellId) || !PEER_ID_PATTERN.test(executorId)
    || !Number.isSafeInteger(computeEpoch) || (computeEpoch as number) < 0
    || !PEER_ID_PATTERN.test(cellRevision) || !/^[a-f0-9]{64}$/.test(cellDigest)) {
    return undefined;
  }
  return {
    notebookKey,
    cellId,
    executorId,
    computeEpoch: computeEpoch as number,
    cellRevision,
    cellDigest,
  };
}

function lightweightExecutionRequestDigest(request: LightweightExecutionRequest): string {
  return createHash('sha256').update(JSON.stringify([
    request.notebookKey,
    request.cellId,
    request.executorId,
    request.computeEpoch,
    request.cellRevision,
    request.cellDigest,
  ]), 'utf8').digest('hex');
}

function legacyRemoteExecutionRequestDigest(
  notebookKey: string,
  target: NotebookComputeTarget,
  manifest: ExecutionManifest,
  payload: Uint8Array<ArrayBufferLike>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([
      notebookKey,
      target.executorId,
      target.device,
      target.pythonPath ?? null,
      target.epoch,
      target.author,
      executionManifestDigest(manifest),
    ]), 'utf8')
    .update(Buffer.from(payload))
    .digest('hex');
}

function requestedManifestPaths<T>(value: unknown, manifest: Record<string, T>): string[] {
  if (!Array.isArray(value) || value.length > MAX_EXECUTION_MANIFEST_ENTRIES) {
    throw new Error('Executor returned an invalid file synchronization request.');
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const rawPath of value) {
    if (typeof rawPath !== 'string' || !(rawPath in manifest) || seen.has(rawPath)) {
      throw new Error('Executor requested a path outside the execution manifest.');
    }
    seen.add(rawPath);
    result.push(rawPath);
  }
  return result;
}

function barrierAuthorizationKey(sourceId: string, requestId: string): string {
  return `${sourceId}:${requestId}`;
}

function inputReplyKey(requestId: string, eventSequence: number): string {
  return `${requestId}:${eventSequence}`;
}

function computeAvailabilityErrorName(message: string): string {
  if (/GPU|CUDA/i.test(message)) return 'GpuComputeUnavailable';
  if (/offline/i.test(message)) return 'HostComputeOffline';
  return 'ComputeUnavailable';
}

function sameClock(a: HostClock, b: HostClock): boolean {
  return a.sessionEpoch === b.sessionEpoch && a.hostEpoch === b.hostEpoch && a.hostId === b.hostId;
}

function normalizeComputeTarget(target: unknown, fallbackAuthor: string): NotebookComputeTarget | undefined {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined;
  const raw = target as Partial<NotebookComputeTarget>;
  const executorId = validPeerId(raw.executorId) ? raw.executorId : undefined;
  const author = validPeerId(raw.author) ? raw.author : (validPeerId(fallbackAuthor) ? fallbackAuthor : undefined);
  const epoch = Number(raw.epoch);
  const device = typeof raw.device === 'string' && (raw.device === 'cpu' || /^gpu:(?:0|[1-9]\d{0,2})$/.test(raw.device))
    ? raw.device as NotebookComputeTarget['device']
    : undefined;
  const pythonPath = raw.pythonPath === undefined
    ? undefined
    : safeExecutableName(raw.pythonPath);
  if (!executorId || !author || !device || !isSafeRevision(epoch)
    || (raw.pythonPath !== undefined && !pythonPath)) return undefined;
  return { executorId, author, device, epoch, pythonPath };
}

function normalizeKnownPeers(value: unknown, localPeerId: string): PeerIdentity[] {
  if (!Array.isArray(value)) return [];
  const peers: PeerIdentity[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const item of value.slice(0, MAX_KNOWN_PEERS * 4)) {
    if (!isPlainRecord(item) || !validPeerId(item.peerId) || item.peerId === localPeerId
      || validateDisplayName(item.displayName) || !Number.isSafeInteger(item.joinOrder)
      || Number(item.joinOrder) < 0) continue;
    const displayName = cleanDisplayName(String(item.displayName));
    const normalizedName = normalizeDisplayName(displayName);
    if (ids.has(item.peerId) || names.has(normalizedName)) continue;
    ids.add(item.peerId);
    names.add(normalizedName);
    peers.push({
      peerId: item.peerId,
      displayName,
      joinOrder: Number(item.joinOrder),
      ...(!validateIdentityPublicKey(item.identityKey) ? { identityKey: String(item.identityKey) } : {}),
    });
    if (peers.length >= MAX_KNOWN_PEERS) break;
  }
  return peers.sort((left, right) => left.joinOrder - right.joinOrder || left.peerId.localeCompare(right.peerId));
}

function normalizeNotebookPythonPaths(value: unknown): Record<string, string> {
  if (!isPlainRecord(value)) return {};
  const result: Record<string, string> = {};
  const portableKeys = new Set<string>();
  for (const [rawKey, rawExecutable] of Object.entries(value).slice(0, MAX_TRACKED_PROJECT_ENTRIES)) {
    const key = normalizedTrackedPath(rawKey);
    const executable = safeExecutableName(rawExecutable);
    const portableKey = key ? portablePathComparisonKey(key) : '';
    if (key && executable && !portableKeys.has(portableKey)) {
      portableKeys.add(portableKey);
      result[key] = executable;
    }
  }
  return result;
}

function safeExecutableName(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() && value.length <= 4096
    && !value.includes('\0') && !value.includes('\r') && !value.includes('\n')
    ? value
    : undefined;
}

function safeLocalFolder(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096
    || value.includes('\0') || value.includes('\r') || value.includes('\n')) return '';
  return path.resolve(value);
}

function compareComputeTarget(a: NotebookComputeTarget, b: NotebookComputeTarget): number {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  const authorA = a.author ?? a.executorId;
  const authorB = b.author ?? b.executorId;
  const author = authorA.localeCompare(authorB);
  if (author) return author;
  const executor = a.executorId.localeCompare(b.executorId);
  if (executor) return executor;
  const device = a.device.localeCompare(b.device);
  if (device) return device;
  return (a.pythonPath ?? '').localeCompare(b.pythonPath ?? '');
}

function sameComputeTarget(a: NotebookComputeTarget, b: NotebookComputeTarget): boolean {
  return a.executorId === b.executorId
    && a.device === b.device
    && a.epoch === b.epoch
    && (a.author ?? a.executorId) === (b.author ?? b.executorId)
    && (a.pythonPath ?? '') === (b.pythonPath ?? '');
}

function normalizeFileState(
  value: unknown,
  fallbackAuthor: string,
  fallbackKind?: FileLifecycleState['kind'],
): FileLifecycleState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<FileLifecycleState>;
  const version = Number(raw.version);
  const kind = raw.kind ?? fallbackKind;
  if (!isSafeRevision(version) || !kind || !['text', 'notebook', 'binary', 'directory'].includes(kind)) return undefined;
  return {
    version,
    author: validPeerId(raw.author) ? raw.author : fallbackAuthor,
    kind,
    deleted: raw.deleted === true,
  };
}

function compareFileState(a: FileLifecycleState, b: FileLifecycleState): number {
  if (a.version !== b.version) return a.version - b.version;
  const author = a.author.localeCompare(b.author);
  if (author) return author;
  if (a.deleted !== b.deleted) return a.deleted ? 1 : -1;
  return a.kind.localeCompare(b.kind);
}

function normalizeBinaryVersion(value: unknown, fallbackAuthor: string): BinaryFileVersion | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<BinaryFileVersion>;
  const version = Number(raw.version);
  if (typeof raw.hash !== 'string' || !/^[a-f0-9]{64}$/i.test(raw.hash) || !isSafeRevision(version)) return undefined;
  return {
    hash: raw.hash.toLowerCase(),
    version,
    author: validPeerId(raw.author) ? raw.author : fallbackAuthor,
  };
}

function isSafeRevision(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value < Number.MAX_SAFE_INTEGER;
}

function validPeerId(value: unknown): value is string {
  return typeof value === 'string' && PEER_ID_PATTERN.test(value);
}

function normalizedTrackedPath(value: string): string | undefined {
  try {
    const relativePath = safeRelativePath(value).split(path.sep).join('/');
    return shouldTrackProjectPath(relativePath) ? relativePath : undefined;
  } catch {
    return undefined;
  }
}

function assertPortablePathUniqueness(paths: readonly string[]): void {
  const seen = new Map<string, string>();
  for (const relativePath of paths) {
    const key = portablePathComparisonKey(relativePath);
    const existing = seen.get(key);
    if (existing && existing !== relativePath) {
      throw new Error(`Project paths differ only by case or Unicode normalization and cannot be shared portably: ${existing}, ${relativePath}`);
    }
    seen.set(key, relativePath);
  }
}

function portablePathCaseConflict(left: string, right: string): boolean {
  const leftSegments = left.split('/');
  const rightSegments = right.split('/');
  const shared = Math.min(leftSegments.length, rightSegments.length);
  for (let index = 0; index < shared; index += 1) {
    const leftSegment = leftSegments[index];
    const rightSegment = rightSegments[index];
    if (leftSegment === undefined || rightSegment === undefined) return false;
    if (portablePathComparisonKey(leftSegment) !== portablePathComparisonKey(rightSegment)) return false;
    if (leftSegment !== rightSegment) return true;
  }
  return false;
}

function compareBinaryVersion(a: BinaryFileVersion, b: BinaryFileVersion): number {
  if (a.version !== b.version) return a.version - b.version;
  const author = a.author.localeCompare(b.author);
  if (author) return author;
  return a.hash.localeCompare(b.hash);
}

function sameBinaryVersion(a: BinaryFileVersion, b: BinaryFileVersion): boolean {
  return a.hash === b.hash && a.version === b.version && a.author === b.author;
}

function isClockAgnosticFrame(type: string): boolean {
  return new Set([
    'helloAck', 'projectUpdate', 'stateDocument', 'stateDiff', 'stateVector', 'filesystemState', 'fileState', 'stateEnd', 'awareness',
    'snapshotRequest', 'snapshotCheckpointAck', 'snapshotFileRetry', 'binaryStart', 'binaryChunk', 'binaryEnd', 'binaryAck', 'binarySyncRequest',
    'fileDelete', 'directoryCreate', 'fileRename', 'computeChanged', 'computeState', 'hostTransferFinalize',
    'executionBarrierCheck', 'executionBarrierStatus', 'executionBarrierCommit', 'executionBarrierAck',
    'executeRequest', 'executeAccepted', 'executionEvent', 'executeResult', 'executeResultAck',
    'inputReply', 'inputReplyAck', 'kernelCommand', 'kernelCommandResult',
  ]).has(type);
}
