import { stat } from 'node:fs/promises';
import { validateIdentityPublicKey } from './identity';
import { filesystemPathComparisonKey } from './projectPath';
import { PEER_ID_PATTERN, SessionDescriptor } from './types';

export interface RecentReconnectIdentity {
  sessionId: string;
  localPeerId: string;
  hostPeerId: string;
  hostIdentityKey: string;
  role: 'peer';
  sessionEpoch: number;
  hostEpoch: number;
}

export interface RecentProject {
  name: string;
  sessionId?: string | undefined;
  hostDisplayName: string;
  workingFolder: string;
  at: number;
  leftAt: number;
  /** Present only for a guest entry that can safely reconnect to its pinned host. */
  reconnect?: RecentReconnectIdentity | undefined;
}

export interface RecentExitPresentation {
  relative: string;
  date: string;
}

export function normalizeRecentProjects(value: unknown, limit = 20): RecentProject[] {
  if (!Array.isArray(value) || !Number.isInteger(limit) || limit < 0) return [];
  const result: RecentProject[] = [];
  for (const item of value.slice(0, limit * 4 || 0)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 256
      || typeof raw.workingFolder !== 'string' || !raw.workingFolder.trim() || raw.workingFolder.length > 4096
      || /[\0\r\n]/.test(raw.workingFolder)
      || !Number.isSafeInteger(raw.at) || Number(raw.at) < 0) continue;
    const reconnect = normalizeRecentReconnectIdentity(raw.reconnect);
    const sessionId = typeof raw.sessionId === 'string' && PEER_ID_PATTERN.test(raw.sessionId)
      ? raw.sessionId
      : reconnect?.sessionId;
    const hostDisplayName = normalizeRecentHostDisplayName(raw.hostDisplayName) ?? 'Unknown host';
    const leftAt = Number.isSafeInteger(raw.leftAt) && Number(raw.leftAt) >= 0
      ? Number(raw.leftAt)
      : Number(raw.at);
    result.push({
      name: raw.name.trim(),
      ...(sessionId ? { sessionId } : {}),
      hostDisplayName,
      workingFolder: raw.workingFolder,
      at: Number(raw.at),
      leftAt,
      ...(reconnect ? { reconnect } : {}),
    });
    if (result.length >= limit) break;
  }
  return result;
}

export function rememberRecentProject(
  recent: readonly RecentProject[],
  project: RecentProject,
  limit = 5,
): RecentProject[] {
  const wanted = canonicalPath(project.workingFolder);
  return [project, ...recent.filter((item) => canonicalPath(item.workingFolder) !== wanted)].slice(0, limit);
}

export function forgetRecentProject(
  recent: readonly RecentProject[],
  workingFolder: string,
): RecentProject[] {
  const unwanted = canonicalPath(workingFolder);
  return recent.filter((item) => canonicalPath(item.workingFolder) !== unwanted);
}

/** Keeps the Recent Project entry but removes the ability to reconnect after an explicit Leave. */
export function clearRecentReconnect(
  recent: readonly RecentProject[],
  workingFolder: string,
): RecentProject[] {
  const wanted = canonicalPath(workingFolder);
  return recent.map((item) => {
    if (canonicalPath(item.workingFolder) !== wanted || !item.reconnect) return item;
    const project = { ...item };
    delete project.reconnect;
    return project;
  });
}

export function recentProjectForFolder(
  recent: readonly RecentProject[],
  workingFolder: string,
): RecentProject | undefined {
  const wanted = canonicalPath(workingFolder);
  return recent.find((item) => canonicalPath(item.workingFolder) === wanted);
}

export function recentHostDisplayName(
  descriptor: SessionDescriptor,
  pinnedHostId = descriptor.hostPeerId,
): string {
  const host = descriptor.localPeer.peerId === pinnedHostId
    ? descriptor.localPeer
    : (descriptor.knownPeers ?? []).find((peer) => peer.peerId === pinnedHostId);
  return normalizeRecentHostDisplayName(host?.displayName) ?? 'Unknown host';
}

export function presentRecentExit(leftAt: number, now = Date.now()): RecentExitPresentation {
  const safeLeftAt = Number.isFinite(leftAt) && leftAt >= 0 ? leftAt : 0;
  const safeNow = Number.isFinite(now) && now >= 0 ? now : safeLeftAt;
  const elapsedMs = Math.max(0, safeNow - safeLeftAt);
  const elapsedMinutes = Math.max(1, Math.floor(elapsedMs / 60_000));
  let relative: string;
  if (elapsedMinutes < 60) {
    relative = `${elapsedMinutes} ${russianPlural(elapsedMinutes, 'минуту', 'минуты', 'минут')} назад`;
  } else {
    const elapsedHours = Math.floor(elapsedMs / 3_600_000);
    if (elapsedHours < 24) {
      relative = `${elapsedHours} ${russianPlural(elapsedHours, 'час', 'часа', 'часов')} назад`;
    } else {
      const elapsedDays = Math.max(1, Math.floor(elapsedMs / 86_400_000));
      relative = `${elapsedDays} ${russianPlural(elapsedDays, 'день', 'дня', 'дней')} назад`;
    }
  }
  const date = new Date(safeLeftAt);
  return {
    relative,
    date: `${padTwo(date.getDate())}/${padTwo(date.getMonth() + 1)}/${String(date.getFullYear()).slice(-2)}`,
  };
}

/**
 * Builds the reconnect identity stored in globalState. The invite token and
 * participant private key deliberately stay in VS Code SecretStorage; public
 * identity and stable logical IDs are sufficient to verify a reopen.
 */
export function reconnectIdentityFromDescriptor(
  descriptor: SessionDescriptor,
  pinnedHostId = descriptor.hostPeerId,
): RecentReconnectIdentity | undefined {
  if (descriptor.role !== 'peer'
    || !PEER_ID_PATTERN.test(descriptor.sessionId)
    || !PEER_ID_PATTERN.test(descriptor.localPeer.peerId)
    || !PEER_ID_PATTERN.test(pinnedHostId)
    || pinnedHostId === descriptor.localPeer.peerId
    || !Number.isSafeInteger(descriptor.sessionEpoch) || descriptor.sessionEpoch <= 0
    || !Number.isSafeInteger(descriptor.hostEpoch) || descriptor.hostEpoch < 0) return undefined;
  const host = (descriptor.knownPeers ?? []).find((peer) => peer.peerId === pinnedHostId);
  if (!host || validateIdentityPublicKey(host.identityKey)) return undefined;
  return {
    sessionId: descriptor.sessionId,
    localPeerId: descriptor.localPeer.peerId,
    hostPeerId: pinnedHostId,
    hostIdentityKey: host.identityKey!,
    role: 'peer',
    sessionEpoch: descriptor.sessionEpoch,
    hostEpoch: descriptor.hostEpoch,
  };
}

export function assertRecentReconnectMatchesDescriptor(
  reconnect: RecentReconnectIdentity,
  descriptor: SessionDescriptor,
): void {
  const expected = reconnectIdentityFromDescriptor(descriptor, reconnect.hostPeerId);
  if (!expected
    || expected.sessionId !== reconnect.sessionId
    || expected.localPeerId !== reconnect.localPeerId
    || expected.hostPeerId !== reconnect.hostPeerId
    || expected.hostIdentityKey !== reconnect.hostIdentityKey
    || expected.role !== reconnect.role
    || expected.sessionEpoch !== reconnect.sessionEpoch
    || expected.hostEpoch !== reconnect.hostEpoch
    || descriptor.hostPeerId !== reconnect.hostPeerId) {
    throw new Error('Recent Session no longer matches the pinned original host identity.');
  }
}

export async function accessibleRecentProjects(recent: readonly RecentProject[]): Promise<RecentProject[]> {
  const checks = await Promise.all(recent.map(async (item) => {
    try {
      return (await stat(item.workingFolder)).isDirectory() ? item : undefined;
    } catch {
      return undefined;
    }
  }));
  const unique = new Map<string, RecentProject>();
  for (const item of checks) {
    if (!item) continue;
    const key = canonicalPath(item.workingFolder);
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

function normalizeRecentReconnectIdentity(value: unknown): RecentReconnectIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<RecentReconnectIdentity>;
  if (typeof raw.sessionId !== 'string' || !PEER_ID_PATTERN.test(raw.sessionId)
    || typeof raw.localPeerId !== 'string' || !PEER_ID_PATTERN.test(raw.localPeerId)
    || typeof raw.hostPeerId !== 'string' || !PEER_ID_PATTERN.test(raw.hostPeerId)
    || raw.hostPeerId === raw.localPeerId
    || raw.role !== 'peer'
    || typeof raw.hostIdentityKey !== 'string' || validateIdentityPublicKey(raw.hostIdentityKey)
    || !Number.isSafeInteger(raw.sessionEpoch) || Number(raw.sessionEpoch) <= 0
    || !Number.isSafeInteger(raw.hostEpoch) || Number(raw.hostEpoch) < 0) return undefined;
  return {
    sessionId: raw.sessionId,
    localPeerId: raw.localPeerId,
    hostPeerId: raw.hostPeerId,
    hostIdentityKey: raw.hostIdentityKey,
    role: 'peer',
    sessionEpoch: Number(raw.sessionEpoch),
    hostEpoch: Number(raw.hostEpoch),
  };
}

function normalizeRecentHostDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 128 ? normalized : undefined;
}

function russianPlural(value: number, one: string, few: string, many: string): string {
  const lastTwo = value % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  const last = value % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

function padTwo(value: number): string {
  return String(value).padStart(2, '0');
}

function canonicalPath(value: string): string {
  return filesystemPathComparisonKey(value);
}
