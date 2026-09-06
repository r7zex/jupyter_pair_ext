import { strict as assert } from 'node:assert';
import { CadencedTask } from '../src/core/cadencedTask';

describe('CadencedTask', () => {
  it('collapses a burst into one delayed task', async () => {
    let runs = 0;
    const task = new CadencedTask(20, () => { runs += 1; });
    task.schedule();
    task.schedule();
    task.schedule();

    await waitFor(() => runs === 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(runs, 1);
    task.dispose();
  });

  it('keeps one follow-up while a task is in flight', async () => {
    let runs = 0;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const task = new CadencedTask(10, async () => {
      runs += 1;
      if (runs === 1) await blocked;
    });
    task.schedule();
    await waitFor(() => runs === 1);
    task.schedule();
    task.schedule();
    release?.();

    await waitFor(() => runs === 2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runs, 2);
    task.dispose();
  });

  it('flushes the latest state immediately', async () => {
    let value = 0;
    const published: number[] = [];
    const task = new CadencedTask(10_000, () => { published.push(value); });
    value = 1;
    task.schedule();
    value = 2;
    task.schedule();

    await task.flush();
    assert.deepEqual(published, [2]);
    task.dispose();
  });

  it('reports timer failures without an unhandled rejection', async () => {
    const errors: unknown[] = [];
    const task = new CadencedTask(10, () => { throw new Error('background failure'); }, (error) => errors.push(error));
    task.schedule();

    await waitFor(() => errors.length === 1);
    assert.match(String(errors[0]), /background failure/);
    task.dispose();
  });

  it('can publish a newer state after a transient background failure', async () => {
    const errors: unknown[] = [];
    let attempts = 0;
    const task = new CadencedTask(10, () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient failure');
    }, (error) => errors.push(error));
    task.schedule();
    await waitFor(() => errors.length === 1);

    task.schedule();
    await task.flush();

    assert.equal(attempts, 2);
    assert.equal(errors.length, 1);
    task.dispose();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for cadenced task.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
