export const SESSION_STARTUP_TIMEOUT_MS = 90_000;
export const SESSION_STARTUP_CLEANUP_TIMEOUT_MS = 5_000;

export interface DeadlineScheduler {
  schedule(callback: () => void, timeoutMs: number): unknown;
  cancel(handle: unknown): void;
}

const defaultScheduler: DeadlineScheduler = {
  schedule: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
  cancel: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export class SessionStartupTimeoutError extends Error {
  public constructor(public readonly timeoutMs: number) {
    super(`Session startup did not finish within ${Math.ceil(timeoutMs / 1_000)} seconds.`);
    this.name = 'SessionStartupTimeoutError';
  }
}

export class SessionStartupCleanupTimeoutError extends Error {
  public constructor(public readonly timeoutMs: number) {
    super(`Session startup cleanup did not finish within ${Math.ceil(timeoutMs / 1_000)} seconds.`);
    this.name = 'SessionStartupCleanupTimeoutError';
  }
}

function settleBeforeDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error,
  scheduler: DeadlineScheduler,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error('A session startup deadline must be a positive integer.'));
  }

  let timeoutHandle: unknown;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutHandle = scheduler.schedule(() => reject(timeoutError()), timeoutMs);
  });

  return Promise.race([operation, deadline]).finally(() => {
    scheduler.cancel(timeoutHandle);
  });
}

/** Supervises runtime startup independently of transport-specific timers. */
export function awaitSessionStartup<T>(
  operation: Promise<T>,
  timeoutMs = SESSION_STARTUP_TIMEOUT_MS,
  scheduler: DeadlineScheduler = defaultScheduler,
): Promise<T> {
  return settleBeforeDeadline(
    operation,
    timeoutMs,
    () => new SessionStartupTimeoutError(timeoutMs),
    scheduler,
  );
}

/** Prevents best-effort teardown from keeping the extension launch latch set. */
export function awaitSessionStartupCleanup<T>(
  operation: Promise<T>,
  timeoutMs = SESSION_STARTUP_CLEANUP_TIMEOUT_MS,
  scheduler: DeadlineScheduler = defaultScheduler,
): Promise<T> {
  return settleBeforeDeadline(
    operation,
    timeoutMs,
    () => new SessionStartupCleanupTimeoutError(timeoutMs),
    scheduler,
  );
}
