import assert from 'node:assert/strict';
import { awaitFailedStartupCleanup, awaitStartupOperation, SessionStartCancelledError } from '../src/core/startupRecovery';

describe('failed startup recovery', () => {
  it('allows explicit cancellation while startup is pending and contains a late failure', async () => {
    const controller = new AbortController();
    let fail!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => { fail = reject; });
    const result = awaitStartupOperation(pending, controller.signal);
    controller.abort();
    await assert.rejects(result, SessionStartCancelledError);
    fail(new Error('late transport failure'));
    assert.equal(await awaitStartupOperation(Promise.resolve('retry'), new AbortController().signal), 'retry');
  });

  it('does not impose a connection deadline', async () => {
    const operation = new Promise<string>((resolve) => setTimeout(() => resolve('connected'), 30));
    assert.equal(await awaitStartupOperation(operation, new AbortController().signal), 'connected');
  });

  it('releases the caller when failed cleanup hangs and observes a late rejection', async () => {
    let fail!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => { fail = reject; });
    assert.equal(await awaitFailedStartupCleanup(pending, 10), false);
    fail(new Error('late cleanup failure'));
    assert.equal(await awaitFailedStartupCleanup(Promise.resolve(), 10), true);
  });

  it('reports immediate cleanup failures to the caller', async () => {
    await assert.rejects(awaitFailedStartupCleanup(Promise.reject(new Error('cleanup failed'))), /cleanup failed/);
  });
});
