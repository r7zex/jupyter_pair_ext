import { createHash } from 'node:crypto';
import path from 'node:path';
import type { SessionDescriptor } from './types';

export type ManualSessionRestoreResult = 'declined' | 'restored';

export interface PendingSessionLaunch {
  version: 2;
  editorProcessId: string;
  sessionId: string;
  peerId: string;
  workingFolder: string;
}

export function createPendingSessionLaunch(
  descriptor: Pick<SessionDescriptor, 'sessionId' | 'localPeer' | 'workingFolder'>,
  editorProcessId: string,
): PendingSessionLaunch {
  return {
    version: 2,
    editorProcessId,
    sessionId: descriptor.sessionId,
    peerId: descriptor.localPeer.peerId,
    workingFolder: path.resolve(descriptor.workingFolder),
  };
}

export function normalizePendingSessionLaunch(value: unknown): PendingSessionLaunch | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const pending = value as Partial<PendingSessionLaunch>;
  if (pending.version !== 2
    || typeof pending.editorProcessId !== 'string' || !pending.editorProcessId
    || typeof pending.sessionId !== 'string' || !pending.sessionId
    || typeof pending.peerId !== 'string' || !pending.peerId
    || typeof pending.workingFolder !== 'string' || !pending.workingFolder) return undefined;
  return {
    version: 2,
    editorProcessId: pending.editorProcessId,
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
  editorProcessId: string,
): boolean {
  return pending.editorProcessId === editorProcessId
    && pending.sessionId === descriptor.sessionId
    && pending.peerId === descriptor.localPeer.peerId
    && sameWorkspacePath(pending.workingFolder, descriptor.workingFolder);
}

export function currentEditorProcessIdentity(
  environment: Partial<Pick<NodeJS.ProcessEnv, 'VSCODE_PID' | 'VSCODE_IPC_HOOK' | 'VSCODE_IPC_HOOK_CLI'>> = process.env,
): string | undefined {
  const vscodePid = environment.VSCODE_PID?.trim();
  const ipcHook = (environment.VSCODE_IPC_HOOK ?? environment.VSCODE_IPC_HOOK_CLI)?.trim();
  if (!vscodePid || !/^[1-9]\d*$/.test(vscodePid) || !ipcHook) return undefined;
  return createHash('sha256').update(`${vscodePid}\0${ipcHook}`, 'utf8').digest('hex');
}

export function isSystemSuspendGap(previousTickAt: number, currentTickAt: number, thresholdMs: number): boolean {
  return Number.isFinite(previousTickAt)
    && Number.isFinite(currentTickAt)
    && Number.isFinite(thresholdMs)
    && thresholdMs > 0
    && currentTickAt - previousTickAt >= thresholdMs;
}

export function establishedSessionRuntime<T extends object>(
  runtime: T | undefined,
  readyRuntime: T | undefined,
): T | undefined {
  return runtime !== undefined && runtime === readyRuntime ? runtime : undefined;
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
