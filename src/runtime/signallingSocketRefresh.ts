interface RestartableSignallingSocket {
  readyState?: number;
  close?: () => void;
  terminate?: () => void;
}

/** Forces a live or half-open socket into its owner's existing reconnect path. */
export function forceSignallingSocketRefresh(socket: unknown, beforeRefresh?: () => void): boolean {
  const candidate = socket as RestartableSignallingSocket | undefined;
  if (!candidate || candidate.readyState === 2 || candidate.readyState === 3) return false;
  if (typeof candidate.terminate !== 'function' && typeof candidate.close !== 'function') return false;
  beforeRefresh?.();
  if (typeof candidate.terminate === 'function') {
    try {
      candidate.terminate();
      return true;
    } catch {
      // Browser-compatible close remains a safe fallback.
    }
  }
  if (typeof candidate.close !== 'function') return false;
  try {
    candidate.close();
    return true;
  } catch {
    return false;
  }
}
