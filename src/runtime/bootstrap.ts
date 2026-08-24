import { createHash } from 'node:crypto';
import { FileHandle, lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { publishTemporaryFile } from '../core/atomicFile';
import { safeProjectTarget, safeRelativePath } from '../core/persistence';
import { hashFileContents, shouldTrackProjectPath } from '../core/projectFiles';
import { portablePathComparisonKey } from '../core/projectPath';
import { HostClock, InviteData, PeerIdentity } from '../core/types';
import {
  DEFAULT_TRANSFER_CHUNK_SIZE,
  expectedTransferChunkBytes,
  IncomingTransferShape,
  validateIncomingTransfer,
} from '../core/transfer';
import { WireFrame } from '../core/wire';
import { MeshTransport, TrysteroRoomFactory } from './mesh';

const TRANSFER_DIRECTORY = '.pair-notebook-transfers';
const TRANSFER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_CHUNK_SIZE = DEFAULT_TRANSFER_CHUNK_SIZE;
const DISCOVERY_TIMEOUT_MS = 45_000;
const IDLE_TIMEOUT_MS = 120_000;
const MAX_SNAPSHOT_ENTRIES = 50_000;
const MAX_ACTIVE_SNAPSHOT_TRANSFERS = 4;
const MAX_SNAPSHOT_TRANSFER_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_PENDING_SNAPSHOT_MESSAGES = 2048;
const MAX_PENDING_SNAPSHOT_BYTES = 128 * 1024 * 1024;
/** A lossy relay route may drop individual chunk frames; ask the host to resend before giving up. */
const MAX_SNAPSHOT_FILE_RETRIES = 5;

export type SnapshotBootstrapErrorKind = 'display-name-conflict' | 'connection-failed';

export class SnapshotBootstrapError extends Error {
  public constructor(
    public readonly kind: SnapshotBootstrapErrorKind,
    public readonly endpoint: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SnapshotBootstrapError';
  }
}

interface SnapshotFile {
  relativePath: string;
  expectedChunks: number;
  hash: string;
  chunkSize: number;
  received: Set<number>;
  temporaryPath: string;
  handle: FileHandle;
  bytesWritten: number;
  shape: IncomingTransferShape;
  retries: number;
}

export interface SnapshotProgress {
  completedFiles: number;
  totalFiles: number;
  currentFile?: string;
  retry?: number;
}

export async function downloadProjectSnapshot(
  invite: InviteData,
  localPeer: PeerIdentity,
  destination: string,
  onProgress?: (progress: SnapshotProgress) => void,
  roomFactory?: TrysteroRoomFactory,
  identityPrivateKey?: string,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  const destinationInfo = await lstat(destination);
  if (destinationInfo.isSymbolicLink() || !destinationInfo.isDirectory()) {
    throw new Error('The isolated snapshot destination must be a real directory.');
  }
  const completed = new Map<string, string>();
  const scratch = await safeProjectTarget(destination, TRANSFER_DIRECTORY, true);
  const transfers = new Map<string, SnapshotFile>();
  const endpoint = `Trystero room ${invite.sessionId}`;
  const hostPeerId = invite.hostPeerId;
  let totalFiles = 0;
  let transferFiles = 0;
  let declaredCompletedFiles = 0;
  let declaredDirectories = 0;
  let snapshotBegun = false;
  let manifestComplete = false;
  let chunkedManifest = false;
  let expectedFiles: Set<string> | undefined;
  let expectedDirectories: Set<string> | undefined;
  let expectedFileKeys: Set<string> | undefined;
  let expectedDirectoryKeys: Set<string> | undefined;
  const completedManifestFiles = new Set<string>();
  const completedManifestKeys = new Set<string>();
  const announcedDirectories = new Set<string>();
  const startedFiles = new Set<string>();
  let declaredTransferBytes = 0;
  let requested = false;
  let finished = false;
  let lastConnectionError: Error | undefined;
  let messageQueue: Promise<void> = Promise.resolve();
  const clock = (): HostClock => ({
    sessionEpoch: invite.sessionEpoch,
    hostEpoch: 0,
    hostId: hostPeerId,
  });
  const transport = new MeshTransport({
    sessionId: invite.sessionId,
    token: invite.token,
    localPeer,
    hostClock: clock,
    isHost: () => false,
    purpose: 'bootstrap',
    roomFactory,
    identityPrivateKey,
  });
  // Pin the host key from the invite before discovery starts. A bearer-token
  // holder must not be able to win a race by announcing the host's peer id.
  transport.connect({
    peerId: invite.hostPeerId,
    displayName: invite.hostDisplayName,
    joinOrder: 0,
    ...(invite.hostIdentityKey ? { identityKey: invite.hostIdentityKey } : {}),
  });
  transport.on('localIdentityUpdated', (identity: PeerIdentity) => {
    localPeer.joinOrder = identity.joinOrder;
  });

  try {
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const fail = (error: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(normalizeBootstrapError(error, endpoint));
      };
      const arm = (timeoutMs = IDLE_TIMEOUT_MS, message = 'Project snapshot stalled without progress.') => {
        clearTimeout(timer);
        timer = setTimeout(() => fail(lastConnectionError ?? new Error(message)), timeoutMs);
      };
      const requestSnapshot = (sourceId: string) => {
        if (requested || sourceId !== hostPeerId) return;
        requested = true;
        arm();
        transport.sendTo(sourceId, 'snapshotRequest', { completed: Object.fromEntries(completed) });
      };
      const completeManifest = async (materializeDirectories: boolean) => {
        if (!expectedFiles || !expectedDirectories) throw new Error('Snapshot manifest was not initialized.');
        if (expectedFiles.size !== totalFiles || expectedDirectories.size !== declaredDirectories
          || completedManifestFiles.size !== declaredCompletedFiles
          || transferFiles + declaredCompletedFiles !== totalFiles) {
          throw new Error('Snapshot manifest entry counts are inconsistent.');
        }
        validateSnapshotManifest(expectedFiles, expectedDirectories);
        for (const relativePath of completedManifestFiles) {
          if (!expectedFiles.has(relativePath) || !completed.has(relativePath)) {
            throw new Error('Snapshot resume manifest names a file that the receiver did not complete.');
          }
        }
        for (const relativePath of [...completed.keys()]) {
          if (!completedManifestFiles.has(relativePath)) completed.delete(relativePath);
        }
        if (completed.size !== declaredCompletedFiles) {
          throw new Error('Snapshot resume manifest is inconsistent with the receiver state.');
        }
        if (materializeDirectories) {
          const orderedDirectories = [...expectedDirectories].sort((left, right) =>
            left.split('/').length - right.split('/').length || left.localeCompare(right));
          let created = 0;
          for (const relativePath of orderedDirectories) {
            await mkdir(await safeProjectTarget(destination, relativePath, true), { recursive: true });
            announcedDirectories.add(relativePath);
            created += 1;
            if (created % 128 === 0) arm();
          }
        }
        manifestComplete = true;
        arm();
        onProgress?.({ completedFiles: completed.size, totalFiles });
      };

      arm(DISCOVERY_TIMEOUT_MS, 'The host was not discovered in the Trystero room.');
      transport.on('connectionError', (_peer: PeerIdentity, error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (/display name.*already.*use/i.test(normalized.message)) {
          fail(new SnapshotBootstrapError(
            'display-name-conflict',
            endpoint,
            'This display name is already used by a connected participant. Choose another nickname and try again.',
            { cause: normalized },
          ));
          return;
        }
        lastConnectionError = normalized;
      });
      transport.on('protocolError', (error: unknown) => {
        lastConnectionError = error instanceof Error ? error : new Error(String(error));
      });
      transport.on('peerDisconnected', (peer: PeerIdentity) => {
        if (peer.peerId === hostPeerId) {
          fail(new Error('The Session Host disconnected during the project snapshot transfer.'));
        }
      });

      let pendingMessages = 0;
      let pendingBytes = 0;
      transport.on('message', (frame: WireFrame, sourceId: string) => {
        if (finished) return;
        const queuedBytes = snapshotFrameRetainedBytes(frame);
        pendingMessages += 1;
        pendingBytes += queuedBytes;
        if (pendingMessages > MAX_PENDING_SNAPSHOT_MESSAGES || pendingBytes > MAX_PENDING_SNAPSHOT_BYTES) {
          pendingMessages -= 1;
          pendingBytes -= queuedBytes;
          fail(new Error('Project snapshot exceeded the pending-message safety limit.'));
          return;
        }
        messageQueue = messageQueue.then(async () => {
          if (finished) return;
          if (frame.type === 'helloAck') {
            requestSnapshot(sourceId);
            return;
          }
          if (sourceId !== hostPeerId) return;
          if (frame.type === 'snapshotError') {
            const reason = frame.meta.reason === 'stale-invite'
              ? 'This invite points to a computer that is no longer the Session Host. Ask the current host for a new invite.'
              : 'The host could not prepare a safe project snapshot. Ask the host to check the Pair Notebook output log and retry.';
            throw new Error(reason);
          }
          if (frame.type === 'snapshotBegin') {
            if (snapshotBegun) throw new Error('Host sent more than one snapshot-begin frame.');
            snapshotBegun = true;
            const rawFiles = frame.meta.expectedFiles;
            const rawDirectories = frame.meta.expectedDirectories;
            if ((rawFiles === undefined) !== (rawDirectories === undefined)) {
              throw new Error('Snapshot begin frame contains a partial legacy manifest.');
            }
            totalFiles = snapshotCount(frame.meta.totalFiles, 'total file', MAX_SNAPSHOT_ENTRIES);
            transferFiles = snapshotCount(frame.meta.fileCount, 'transfer file', totalFiles);
            declaredCompletedFiles = frame.meta.completedFiles === undefined
              ? totalFiles - transferFiles
              : snapshotCount(frame.meta.completedFiles, 'completed file', totalFiles);
            if (transferFiles + declaredCompletedFiles !== totalFiles) {
              throw new Error('Snapshot manifest file counts are inconsistent.');
            }
            chunkedManifest = rawFiles === undefined;
            if (chunkedManifest) {
              declaredDirectories = snapshotCount(
                frame.meta.directoryCount,
                'directory',
                MAX_SNAPSHOT_ENTRIES - totalFiles,
              );
              expectedFiles = new Set<string>();
              expectedDirectories = new Set<string>();
              expectedFileKeys = new Set<string>();
              expectedDirectoryKeys = new Set<string>();
            } else {
              if (!Array.isArray(rawFiles) || !Array.isArray(rawDirectories)
                || rawFiles.length + rawDirectories.length > MAX_SNAPSHOT_ENTRIES) {
                throw new Error('Snapshot manifest is missing or exceeds the entry limit.');
              }
              expectedFiles = normalizeSnapshotPaths(rawFiles, false);
              expectedDirectories = normalizeSnapshotPaths(rawDirectories, true);
              expectedFileKeys = new Set([...expectedFiles].map(portablePathKey));
              expectedDirectoryKeys = new Set([...expectedDirectories].map(portablePathKey));
              declaredDirectories = frame.meta.directoryCount === undefined
                ? expectedDirectories.size
                : snapshotCount(frame.meta.directoryCount, 'directory', MAX_SNAPSHOT_ENTRIES - totalFiles);
              for (const relativePath of completed.keys()) {
                if (expectedFiles.has(relativePath)) {
                  completedManifestFiles.add(relativePath);
                  completedManifestKeys.add(portablePathKey(relativePath));
                }
              }
              await completeManifest(false);
            }
            arm();
            return;
          }
          if (frame.type === 'snapshotManifest') {
            if (!snapshotBegun || !chunkedManifest || manifestComplete
              || !expectedFiles || !expectedDirectories || !expectedFileKeys || !expectedDirectoryKeys) {
              throw new Error('Snapshot manifest chunk arrived outside a chunked manifest.');
            }
            const rawFiles = frame.meta.expectedFiles;
            const rawDirectories = frame.meta.expectedDirectories;
            const rawCompleted = frame.meta.completedFiles;
            if (!Array.isArray(rawFiles) || !Array.isArray(rawDirectories) || !Array.isArray(rawCompleted)
              || rawFiles.length + rawDirectories.length + rawCompleted.length === 0) {
              throw new Error('Snapshot manifest chunk has an unsupported format.');
            }
            appendSnapshotPaths(rawFiles, false, expectedFiles, expectedFileKeys);
            appendSnapshotPaths(rawDirectories, true, expectedDirectories, expectedDirectoryKeys);
            appendSnapshotPaths(rawCompleted, false, completedManifestFiles, completedManifestKeys);
            if (expectedFiles.size > totalFiles || expectedDirectories.size > declaredDirectories
              || expectedFiles.size + expectedDirectories.size > MAX_SNAPSHOT_ENTRIES
              || completedManifestFiles.size > declaredCompletedFiles) {
              throw new Error('Snapshot manifest chunk exceeds its declared entry counts.');
            }
            arm();
            return;
          }
          if (frame.type === 'snapshotManifestEnd') {
            if (!snapshotBegun || !chunkedManifest || manifestComplete) {
              throw new Error('Snapshot manifest ended outside a chunked manifest.');
            }
            await completeManifest(true);
            return;
          }
          if (frame.type === 'snapshotCheckpoint') {
            if (!snapshotBegun) throw new Error('Snapshot checkpoint arrived before the snapshot began.');
            const checkpointId = String(frame.meta.checkpointId ?? '');
            if (!TRANSFER_ID_PATTERN.test(checkpointId)) {
              throw new Error('Snapshot checkpoint has an unsupported identifier.');
            }
            arm();
            transport.sendTo(sourceId, 'snapshotCheckpointAck', { checkpointId });
            return;
          }
          if (frame.type === 'snapshotDirectory') {
            if (!manifestComplete || !expectedDirectories || chunkedManifest) {
              throw new Error('Snapshot directory arrived outside a legacy manifest.');
            }
            const relativePath = normalizeSnapshotPath(frame.meta.relativePath, true);
            if (!expectedDirectories.has(relativePath)) throw new Error('Snapshot announced an undeclared directory.');
            if (announcedDirectories.has(relativePath)) throw new Error('Snapshot announced a directory more than once.');
            announcedDirectories.add(relativePath);
            await mkdir(await safeProjectTarget(destination, relativePath, true), { recursive: true });
            arm();
            return;
          }
          if (frame.type === 'snapshotFileStart') {
            if (!manifestComplete || !expectedFiles) throw new Error('Snapshot file arrived before the manifest.');
            const transferId = String(frame.meta.transferId ?? '');
            if (!TRANSFER_ID_PATTERN.test(transferId)) throw new Error('Snapshot used an unsupported transfer id.');
            if (transfers.has(transferId)) throw new Error('Snapshot reused an active transfer id.');
            if (transfers.size >= MAX_ACTIVE_SNAPSHOT_TRANSFERS) {
              throw new Error('Snapshot exceeded the concurrent transfer limit.');
            }
            const relativePath = normalizeSnapshotPath(frame.meta.relativePath, false);
            if (!expectedFiles.has(relativePath) || startedFiles.has(relativePath) || completed.has(relativePath)) {
              throw new Error('Snapshot started an undeclared or duplicate file.');
            }
            const shape = validateIncomingTransfer(frame.meta, DEFAULT_CHUNK_SIZE);
            if (declaredTransferBytes + shape.size > MAX_SNAPSHOT_TRANSFER_BYTES) {
              throw new Error('Snapshot exceeded the aggregate transfer-size limit.');
            }
            declaredTransferBytes += shape.size;
            startedFiles.add(relativePath);
            await mkdir(scratch, { recursive: true });
            const temporaryPath = path.join(scratch, `${createHash('sha256').update(transferId).digest('hex')}.part`);
            transfers.set(transferId, {
              relativePath,
              expectedChunks: shape.expectedChunks,
              hash: shape.hash,
              chunkSize: shape.chunkSize,
              received: new Set<number>(),
              temporaryPath,
              handle: await open(temporaryPath, 'wx'),
              bytesWritten: 0,
              shape,
              retries: 0,
            });
            arm();
            onProgress?.({ completedFiles: completed.size, totalFiles, currentFile: relativePath });
            return;
          }
          if (frame.type === 'snapshotFileChunk') {
            const transfer = transfers.get(String(frame.meta.transferId));
            const index = Number(frame.meta.index);
            if (!transfer) throw new Error('Snapshot chunk arrived without a start frame.');
            const payload = Buffer.from(frame.payload);
            const expectedBytes = expectedTransferChunkBytes(transfer.shape, index);
            if (expectedBytes < 0 || payload.byteLength !== expectedBytes) {
              throw new Error(`Snapshot sent a malformed chunk for ${transfer.relativePath}.`);
            }
            if (transfer.received.has(index)) return;
            await transfer.handle.write(payload, 0, payload.byteLength, index * transfer.chunkSize);
            transfer.received.add(index);
            transfer.bytesWritten += payload.byteLength;
            arm();
            return;
          }
          if (frame.type === 'snapshotFileEnd') {
            const transferId = String(frame.meta.transferId);
            const transfer = transfers.get(transferId);
            if (!transfer) throw new Error('Snapshot file ended without a start frame.');
            if (transfer.received.size !== transfer.expectedChunks || transfer.bytesWritten !== transfer.shape.size) {
              const abandon = (): void => {
                transfers.delete(transferId);
                void transfer.handle.close().catch(() => undefined);
                void rm(transfer.temporaryPath, { force: true }).catch(() => undefined);
              };
              // A lossy route (the emergency Nostr relay drops whole frames when
              // a relay socket blips) can silently swallow chunk frames. The
              // end frame still arrived, so the host is reachable: request the
              // exact missing indices instead of failing the whole join.
              if (transfer.received.size < transfer.expectedChunks
                && transfer.retries < MAX_SNAPSHOT_FILE_RETRIES) {
                transfer.retries += 1;
                const missing: number[] = [];
                for (let index = 0; index < transfer.expectedChunks; index += 1) {
                  if (!transfer.received.has(index)) missing.push(index);
                }
                arm();
                transport.sendTo(sourceId, 'snapshotFileRetry', { transferId, indices: missing });
                return;
              }
              abandon();
              throw new Error(`Snapshot is missing chunks for ${transfer.relativePath}.`);
            }
            transfers.delete(transferId);
            await transfer.handle.close().catch(() => undefined);
            const hash = await hashFileContents(transfer.temporaryPath);
            if (hash !== transfer.hash) {
              await rm(transfer.temporaryPath, { force: true }).catch(() => undefined);
              throw new Error(`Snapshot hash mismatch for ${transfer.relativePath}.`);
            }
            if (finished) {
              await rm(transfer.temporaryPath, { force: true }).catch(() => undefined);
              return;
            }
            const target = await safeProjectTarget(destination, transfer.relativePath);
            await mkdir(path.dirname(target), { recursive: true });
            await publishTemporaryFile(transfer.temporaryPath, target);
            completed.set(transfer.relativePath, hash);
            arm();
            onProgress?.({ completedFiles: completed.size, totalFiles, currentFile: transfer.relativePath });
            return;
          }
          if (frame.type === 'snapshotEnd') {
            if (!manifestComplete || !expectedFiles || !expectedDirectories) {
              throw new Error('Snapshot ended before its manifest arrived.');
            }
            if (transfers.size) throw new Error('Snapshot ended with incomplete file transfers.');
            if (completed.size !== expectedFiles.size
              || [...expectedFiles].some((relativePath) => !completed.has(relativePath))) {
              throw new Error('Snapshot ended before every declared file was received.');
            }
            if (announcedDirectories.size !== expectedDirectories.size
              || [...expectedDirectories].some((relativePath) => !announcedDirectories.has(relativePath))) {
              throw new Error('Snapshot ended before every declared directory was received.');
            }
            await reconcileSnapshot(destination, expectedFiles, expectedDirectories);
            finished = true;
            clearTimeout(timer);
            resolve();
          }
        }).catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))))
          .finally(() => {
            pendingMessages -= 1;
            pendingBytes -= queuedBytes;
          });
      });

      void transport.start().catch((error: unknown) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
  } finally {
    await transport.stop().catch(() => undefined);
    // A timeout or queue-limit failure can race with an in-progress disk write.
    // Drain that bounded queue before closing handles and deleting its scratch
    // directory, otherwise the abandoned continuation can recreate temp files
    // after this function has already returned.
    await messageQueue.catch(() => undefined);
    for (const transfer of transfers.values()) await transfer.handle.close().catch(() => undefined);
    transfers.clear();
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

function normalizeSnapshotPaths(values: unknown[], directory: boolean): Set<string> {
  const normalized = new Set<string>();
  const portablePaths = new Set<string>();
  appendSnapshotPaths(values, directory, normalized, portablePaths);
  return normalized;
}

function appendSnapshotPaths(
  values: readonly unknown[],
  directory: boolean,
  normalized: Set<string>,
  portablePaths: Set<string>,
): void {
  for (const value of values) {
    const relativePath = normalizeSnapshotPath(value, directory);
    const portablePath = portablePathKey(relativePath);
    if (normalized.has(relativePath) || portablePaths.has(portablePath)) {
      throw new Error('Snapshot manifest contains duplicate or case-conflicting paths.');
    }
    normalized.add(relativePath);
    portablePaths.add(portablePath);
  }
}

function snapshotCount(value: unknown, name: string, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`Snapshot ${name} count is invalid or exceeds the entry limit.`);
  }
  return value;
}

function snapshotFrameRetainedBytes(frame: WireFrame): number {
  try {
    return frame.payload.byteLength + Buffer.byteLength(JSON.stringify(frame.meta), 'utf8') + 1024;
  } catch {
    return MAX_PENDING_SNAPSHOT_BYTES + 1;
  }
}

function validateSnapshotManifest(files: ReadonlySet<string>, directories: ReadonlySet<string>): void {
  const fileKeys = new Set([...files].map(portablePathKey));
  const directoryKeys = new Set([...directories].map(portablePathKey));
  if ([...fileKeys].some((key) => directoryKeys.has(key))) {
    throw new Error('Snapshot manifest uses the same path as both a file and a directory.');
  }
  for (const relativePath of [...files, ...directories]) {
    const segments = relativePath.split('/');
    for (let length = 1; length < segments.length; length += 1) {
      const parent = segments.slice(0, length).join('/');
      if (fileKeys.has(portablePathKey(parent))) {
        throw new Error('Snapshot manifest places an entry below a file path.');
      }
      if (!directories.has(parent)) {
        throw new Error('Snapshot manifest omits or case-conflicts with a parent directory.');
      }
    }
  }
}

function portablePathKey(relativePath: string): string {
  return portablePathComparisonKey(relativePath);
}

function normalizeSnapshotPath(value: unknown, directory: boolean): string {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Snapshot path has an unsupported format.');
  const relativePath = safeRelativePath(value).split(path.sep).join('/');
  if (!shouldTrackProjectPath(relativePath) || (!directory && relativePath.endsWith('/'))) {
    throw new Error('Snapshot path targets a Pair Notebook internal location.');
  }
  return relativePath;
}

function normalizeBootstrapError(error: Error, endpoint: string): SnapshotBootstrapError {
  if (error instanceof SnapshotBootstrapError) return error;
  if (/display name.*already.*use/i.test(error.message)) {
    return new SnapshotBootstrapError(
      'display-name-conflict',
      endpoint,
      'This display name is already used by a connected participant. Choose another nickname and try again.',
      { cause: error },
    );
  }
  return new SnapshotBootstrapError(
    'connection-failed',
    endpoint,
    `Could not receive the Pair Notebook project through Trystero. Confirm that the host is online, both computers have internet access, and the invite is current. Details: ${error.message}`,
    { cause: error },
  );
}

async function reconcileSnapshot(
  destination: string,
  expectedFiles: ReadonlySet<string>,
  expectedDirectories: ReadonlySet<string>,
): Promise<void> {
  const fileKeys = new Set([...expectedFiles].map(portablePathKey));
  const directoryKeys = new Set([...expectedDirectories].map(portablePathKey));
  const visit = async (relativeDirectory: string): Promise<void> => {
    const absoluteDirectory = relativeDirectory
      ? await safeProjectTarget(destination, relativeDirectory, true)
      : destination;
    for (const entry of await readdir(absoluteDirectory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (relativePath === TRANSFER_DIRECTORY) continue;
      const absolutePath = path.join(absoluteDirectory, entry.name);
      const key = portablePathKey(relativePath);
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
        await rm(absolutePath, { recursive: true, force: true });
      } else if (entry.isFile()) {
        if (!fileKeys.has(key)) await rm(absolutePath, { force: true });
      } else if (!directoryKeys.has(key)) {
        await rm(absolutePath, { recursive: true, force: true });
      } else {
        await visit(relativePath);
      }
    }
  };
  await visit('');
}
