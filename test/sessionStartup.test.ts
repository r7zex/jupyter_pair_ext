import assert from 'node:assert/strict';
import {
  awaitSessionStartup,
  awaitSessionStartupCleanup,
  type DeadlineScheduler,
  SessionStartupCleanupTimeoutError,
  SessionStartupTimeoutError,
} from '../src/core/sessionStartup';

class ManualScheduler implements DeadlineScheduler {
  private callback: (() => void) | undefined;
  public scheduledFor: number | undefined;
  public cancelled = 0;

  schedule(callback: () => void, timeoutMs: number): unknown {
    this.callback = callback;
    this.scheduledFor = timeoutMs;
    return 'deadline';
  }

  cancel(handle: unknown): void {
    assert.equal(handle, 'deadline');
    this.cancelled += 1;
  }

  expire(): void {
    assert.ok(this.callback, 'deadline was scheduled');
    this.callback();
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('session startup lifecycle deadlines', () => {
  it('returns a successful startup result and disposes its deadline', async () => {
    const scheduler = new ManualScheduler();

    assert.equal(await awaitSessionStartup(Promise.resolve('ready'), 123, scheduler), 'ready');
    assert.equal(scheduler.scheduledFor, 123);
    assert.equal(scheduler.cancelled, 1);
  });

  it('preserves an immediate startup error and disposes its deadline', async () => {
    const scheduler = new ManualScheduler();
    const failure = new Error('transport failed');

    await assert.rejects(awaitSessionStartup(Promise.reject(failure), 123, scheduler), (error) => error === failure);
    assert.equal(scheduler.cancelled, 1);
  });

  it('rejects a never-settling startup at the extension-owned deadline', async () => {
    const scheduler = new ManualScheduler();
    const operation = deferred<string>();
    const supervised = awaitSessionStartup(operation.promise, 321, scheduler);

    scheduler.expire();

    await assert.rejects(supervised, (error) => (
      error instanceof SessionStartupTimeoutError && error.timeoutMs === 321
    ));
    assert.equal(scheduler.cancelled, 1);

    // The already-rejected supervisor cannot become successful if the opaque
    // runtime operation settles late.
    operation.resolve('late-ready');
    await Promise.resolve();
    await assert.rejects(supervised, SessionStartupTimeoutError);
  });

  it('bounds cleanup independently from the startup operation', async () => {
    const scheduler = new ManualScheduler();
    const cleanup = deferred<void>();
    const supervised = awaitSessionStartupCleanup(cleanup.promise, 456, scheduler);

    scheduler.expire();

    await assert.rejects(supervised, (error) => (
      error instanceof SessionStartupCleanupTimeoutError && error.timeoutMs === 456
    ));
    assert.equal(scheduler.cancelled, 1);
  });

  it('rejects invalid deadlines without scheduling a timer', async () => {
    const scheduler = new ManualScheduler();

    await assert.rejects(awaitSessionStartup(Promise.resolve(), 0, scheduler), /positive integer/);
    assert.equal(scheduler.scheduledFor, undefined);
    assert.equal(scheduler.cancelled, 0);
  });
});
