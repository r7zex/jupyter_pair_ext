import path from 'node:path';
import type { SessionDescriptor } from './types';

export type ManualSessionRestoreResult = 'declined' | 'restored';

export interface PendingSessionLaunch {
  version: 1;
  editorSessionId: string;
  sessionId: string;
  peerId: string;
  workingFolder: string;
}

export function createPendingSessionLaunch(
  descriptor: Pick<SessionDescriptor, 'sessionId' | 'localPeer' | 'workingFolder'>,
  editorSessionId: string,
): PendingSessionLaunch {
  return {
    version: 1,
    editorSessionId,
    sessionId: descriptor.sessionId,
    peerId: descriptor.localPeer.peerId,
    workingFolder: path.resolve(descriptor.workingFolder),
  };
}

export function normalizePendingSessionLaunch(value: unknown): PendingSessionLaunch | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const pending = value as Partial<PendingSessionLaunch>;
  if (pending.version !== 1
    || typeof pending.editorSessionId !== 'string' || !pending.editorSessionId
    || typeof pending.sessionId !== 'string' || !pending.sessionId
    || typeof pending.peerId !== 'string' || !pending.peerId
    || typeof pending.workingFolder !== 'string' || !pending.workingFolder) return undefined;
  return {
    version: 1,
    editorSessionId: pending.editorSessionId,
    sessionId: pending.sessionId,
    peerId: pending.peerId,
    workingFolder: path.resolve(pending.workingFolder),
  };
}

export function sameWorkspacePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function pendingSessionLaunchMatches(
  pending: PendingSessionLaunch,
  descriptor: Pick<SessionDescriptor, 'sessionId' | 'localPeer' | 'workingFolder'>,
  editorSessionId: string,
): boolean {
  return pending.editorSessionId === editorSessionId
    && pending.sessionId === descriptor.sessionId
    && pending.peerId === descriptor.localPeer.peerId
    && sameWorkspacePath(pending.workingFolder, descriptor.workingFolder);
}

export function isSystemSuspendGap(previousTickAt: number, currentTickAt: number, thresholdMs: number): boolean {
  return Number.isFinite(previousTickAt)
    && Number.isFinite(currentTickAt)
    && Number.isFinite(thresholdMs)
    && thresholdMs > 0
    && currentTickAt - previousTickAt >= thresholdMs;
}

export function shouldLeaveForSystemSuspend<T extends object>(
  previousReadyRuntime: T | undefined,
  currentReadyRuntime: T | undefined,
  previousTickAt: number,
  currentTickAt: number,
  thresholdMs: number,
): boolean {
  return previousReadyRuntime !== undefined
    && previousReadyRuntime === currentReadyRuntime
    && isSystemSuspendGap(previousTickAt, currentTickAt, thresholdMs);
}

/** Keeps the network restore callback unreachable until a fresh UI confirmation resolves true. */
export async function runConfirmedSessionRestore(
  confirm: () => Promise<boolean>,
  restore: () => Promise<void>,
): Promise<ManualSessionRestoreResult> {
  if (!await confirm()) return 'declined';
  await restore();
  return 'restored';
}
