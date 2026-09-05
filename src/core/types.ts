import { randomBytes, randomUUID } from 'node:crypto';
import { validateIdentityPublicKey } from './identity';

export type SessionMode = 'host-only' | 'resilient';
export type ConnectionRoute = 'Direct' | 'Relay' | 'Unknown';

export const MAX_DISPLAY_NAME_LENGTH = 64;
export const MAX_PROJECT_NAME_LENGTH = 255;
export const PEER_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const UNSAFE_VISIBLE_NAME_CHARACTERS = /[\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF]/u;

export function cleanDisplayName(value: string): string {
  return value.trim().normalize('NFKC');
}

export function normalizeDisplayName(value: string): string {
  return cleanDisplayName(value).toLocaleUpperCase('en-US').toLocaleLowerCase('en-US');
}

export function validateDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return 'Display name must be text.';
  const cleaned = cleanDisplayName(value);
  if (!cleaned) return 'Display name is required.';
  if (cleaned.length > MAX_DISPLAY_NAME_LENGTH) {
    return `Display name must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`;
  }
  if ([...cleaned].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  })) {
    return 'Display name cannot contain control characters.';
  }
  if (UNSAFE_VISIBLE_NAME_CHARACTERS.test(cleaned)) {
    return 'Display name cannot contain invisible or bidirectional control characters.';
  }
  return undefined;
}

export function cleanProjectName(value: string): string {
  return value.trim().normalize('NFKC');
}

export function validateProjectName(value: unknown): string | undefined {
  if (typeof value !== 'string') return 'Project name must be text.';
  const cleaned = cleanProjectName(value);
  if (!cleaned) return 'Project name is required.';
  if (cleaned.length > MAX_PROJECT_NAME_LENGTH) {
    return `Project name must be ${MAX_PROJECT_NAME_LENGTH} characters or fewer.`;
  }
  if ([...cleaned].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  }) || UNSAFE_VISIBLE_NAME_CHARACTERS.test(cleaned)) {
    return 'Project name cannot contain control characters.';
  }
  return undefined;
}

export interface PeerIdentity {
  peerId: string;
  displayName: string;
  joinOrder: number;
  /** Canonical Ed25519 SPKI public key. Optional only while parsing legacy markers and test fixtures. */
  identityKey?: string | undefined;
}

export type ComputeDevice = 'cpu' | `gpu:${number}`;
export type ProjectEntryKind = 'text' | 'notebook' | 'binary' | 'directory';

export interface FileLifecycleState {
  version: number;
  author: string;
  kind: ProjectEntryKind;
  deleted: boolean;
}

export interface BinaryFileVersion {
  hash: string;
  version: number;
  author: string;
}

export interface NotebookComputeTarget {
  executorId: string;
  device: ComputeDevice;
  pythonPath?: string | undefined;
  epoch: number;
  author?: string | undefined;
}

export function computeSelectionChanged(
  current: Pick<NotebookComputeTarget, 'executorId' | 'device' | 'pythonPath'>,
  selected: Pick<NotebookComputeTarget, 'executorId' | 'device' | 'pythonPath'>,
): boolean {
  return current.executorId !== selected.executorId
    || current.device !== selected.device
    || (current.pythonPath ?? '') !== (selected.pythonPath ?? '');
}

export interface PeerRuntime extends PeerIdentity {
  latency: number;
  latencyEma: number;
  lastHeartbeat: number;
  missedHeartbeats: number;
  route: ConnectionRoute;
  online: boolean;
  /** A peer can be authenticated but temporarily lack a usable data route. */
  connectionState?: 'connected' | 'recovering' | 'disconnected';
}

export interface HostClock {
  sessionEpoch: number;
  hostEpoch: number;
  hostId: string;
}

export function normalizeHostClock(value: unknown, expectedSessionEpoch?: number): HostClock | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<HostClock>;
  if (!Number.isSafeInteger(raw.sessionEpoch) || (raw.sessionEpoch ?? 0) <= 0
    || !Number.isSafeInteger(raw.hostEpoch) || (raw.hostEpoch ?? -1) < 0
    || typeof raw.hostId !== 'string' || !PEER_ID_PATTERN.test(raw.hostId)
    || (expectedSessionEpoch !== undefined && raw.sessionEpoch !== expectedSessionEpoch)) {
    return undefined;
  }
  return {
    sessionEpoch: raw.sessionEpoch as number,
    hostEpoch: raw.hostEpoch as number,
    hostId: raw.hostId,
  };
}

export interface SessionDescriptor {
  sessionId: string;
  projectId: string;
  projectName: string;
  mode: SessionMode;
  role: 'host' | 'peer';
  localPeer: PeerIdentity;
  hostPeerId: string;
  backingFolder: string;
  workingFolder: string;
  createdAt: number;
  sessionEpoch: number;
  hostEpoch: number;
  computeExecutorId: string;
  notebookCompute?: Record<string, NotebookComputeTarget> | undefined;
  notebookPythonPaths?: Record<string, string> | undefined;
  pythonPath: string;
  freshStart?: boolean;
  knownPeers?: PeerIdentity[];
  fileStates?: Record<string, FileLifecycleState> | undefined;
  fileRevisionCounter?: number | undefined;
  binaryVersions?: Record<string, BinaryFileVersion> | undefined;
}

export interface InviteData {
  sessionId: string;
  projectId: string;
  projectName: string;
  mode: SessionMode;
  token: string;
  sessionEpoch: number;
  hostEpoch?: number;
  hostPeerId: string;
  hostDisplayName: string;
  hostIdentityKey?: string | undefined;
}

export const REMOTE_ORIGIN = Symbol('pair-notebook-remote');
export const LOCAL_EDITOR_ORIGIN = Symbol('pair-notebook-editor');
export const FILESYSTEM_ORIGIN = Symbol('pair-notebook-filesystem');

export function newId(): string {
  return randomUUID();
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function formatInvite(invite: InviteData): string {
  if (validateIdentityPublicKey(invite.hostIdentityKey)) {
    throw new Error('Cannot create an invite without a valid host identity key.');
  }
  if (!Number.isSafeInteger(invite.hostEpoch ?? 0) || (invite.hostEpoch ?? 0) < 0) throw new Error('Invalid invite host epoch.');
  const query = new URLSearchParams({
    token: invite.token,
    project: invite.projectId,
    projectName: invite.projectName,
    mode: invite.mode,
    epoch: String(invite.sessionEpoch),
    hostEpoch: String(invite.hostEpoch ?? 0),
    hostPeer: invite.hostPeerId,
    hostName: invite.hostDisplayName,
    hostKey: invite.hostIdentityKey!,
  });
  return `pair-notebook://join/${encodeURIComponent(invite.sessionId)}?${query.toString()}`;
}

export function parseInvite(raw: string): InviteData {
  if (raw.length > 8192) throw new Error('The Pair Notebook invite is too long.');
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error('Invalid Pair Notebook invite. Paste the complete pair-notebook:// invite.');
  }
  if (parsed.protocol !== 'pair-notebook:' || parsed.hostname !== 'join' || parsed.port
    || parsed.username || parsed.password || parsed.hash) {
    throw new Error('Invalid Pair Notebook invite address.');
  }
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    throw new Error('The Pair Notebook session identifier is malformed.');
  }
  const projectId = parsed.searchParams.get('project') ?? '';
  const projectName = parsed.searchParams.get('projectName') ?? '';
  const token = parsed.searchParams.get('token') ?? '';
  const mode = parsed.searchParams.get('mode');
  const sessionEpoch = Number(parsed.searchParams.get('epoch') ?? '0');
  const hostEpochValue = parsed.searchParams.get('hostEpoch') ?? '0';
  const hostEpoch = Number(hostEpochValue);
  const hostPeerId = parsed.searchParams.get('hostPeer') ?? '';
  const hostDisplayName = parsed.searchParams.get('hostName') ?? '';
  const hostIdentityKey = parsed.searchParams.get('hostKey') ?? '';
  const validIdentifier = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (!validIdentifier(sessionId)
    || !validIdentifier(projectId)
    || !validIdentifier(hostPeerId)
    || !/^[A-Za-z0-9_-]{32,128}$/.test(token)
    || !Number.isSafeInteger(sessionEpoch)
    || sessionEpoch <= 0
    || !/^(0|[1-9]\d*)$/.test(hostEpochValue)
    || !Number.isSafeInteger(hostEpoch)
    || validateProjectName(projectName)
    || validateDisplayName(hostDisplayName)
    || validateIdentityPublicKey(hostIdentityKey)
    || (mode !== 'host-only' && mode !== 'resilient')) {
    throw new Error('The Pair Notebook invite is incomplete or malformed.');
  }
  return {
    sessionId,
    projectId,
    projectName: cleanProjectName(projectName),
    token,
    mode,
    sessionEpoch,
    hostEpoch,
    hostPeerId,
    hostDisplayName: cleanDisplayName(hostDisplayName),
    hostIdentityKey,
  };
}

export function compareClock(a: HostClock, b: HostClock): number {
  if (a.sessionEpoch !== b.sessionEpoch) return a.sessionEpoch - b.sessionEpoch;
  if (a.hostEpoch !== b.hostEpoch) return a.hostEpoch - b.hostEpoch;
  return a.hostId.localeCompare(b.hostId);
}
