/** Cancellation is explicit; elapsed connection time is not a session exit. */
export class SessionStartCancelledError extends Error {
  constructor() {
    super('Session connection was cancelled. You can start or join again.');
    this.name = 'SessionStartCancelledError';
  }
}

export async function awaitStartupOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    throw new SessionStartCancelledError();
  }
  let onAbort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new SessionStartCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Bound failed cleanup only, never a healthy or still-progressing startup. */
export async function awaitFailedStartupCleanup(cleanup: Promise<unknown>, timeoutMs = 5_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      cleanup.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
