export type ManualSessionRestoreResult = 'declined' | 'restored';

export function isSystemSuspendGap(previousTickAt: number, currentTickAt: number, thresholdMs: number): boolean {
  return Number.isFinite(previousTickAt)
    && Number.isFinite(currentTickAt)
    && Number.isFinite(thresholdMs)
    && thresholdMs > 0
    && currentTickAt - previousTickAt >= thresholdMs;
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
