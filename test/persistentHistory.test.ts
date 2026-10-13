import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { PersistentHistory, PersistentHistoryError, type PersistentHistoryRun } from '../src/vps/persistentHistory';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const status = (value: number) => (error: unknown): boolean => error instanceof PersistentHistoryError && error.status === value;
const execution = (requestId: string, text = 'result'): PersistentHistoryRun => ({
  requestId, commandId: randomUUID(), cellIdentity: 'cell-1', sourceHash: hash('print(42)'),
  notebookVersion: 4, offset: 0, reports: [], aclEpoch: 2, controls: [],
  execution: { id: randomUUID(), notebook: 'public/project.ipynb', cellIndex: 0,
    requesterId: 'member-1', deviceId: 'vps', generation: 3, state: 'completed',
    events: [{ type: 'output', text }] },
});

describe('persistent bounded execution history and permanent replay receipts', function () {
  let directory: string;
  let history: PersistentHistory;
  const receiptPath = (id: string): string => path.join(directory, 'history', 'requests', `${hash(id)}.json`);
  const outputPath = (id: string): string => path.join(directory, 'history', 'outputs', `${id}.json`);

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'pair-persistent-history-'));
    history = new PersistentHistory(directory);
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('restores terminal output by request and execution IDs without changing the permanent receipt', async () => {
    const run = execution('durable-request');
    await history.reserve(run);
    const originalReceipt = await readFile(receiptPath(run.requestId));
    await history.archive(run);
    assert.deepEqual(await readFile(receiptPath(run.requestId)), originalReceipt);
    history = new PersistentHistory(directory);
    assert.deepEqual(await history.lookupRequest(run.requestId), run);
    assert.deepEqual(await history.lookupExecution(run.execution.id), run);
    assert.equal(await history.lookupRequest('unknown'), undefined);
    assert.equal(await history.lookupExecution(randomUUID()), undefined);
    const metadata = JSON.parse(originalReceipt.toString());
    assert.deepEqual(metadata.run.execution.events, []);
    assert.deepEqual(metadata.run.controls, []);
    assert.equal((await stat(receiptPath(run.requestId))).mode & 0o777, 0o600);
  });

  it('reserves before dispatch and fences an incomplete result after process restoration', async () => {
    const run = execution('accepted-before-crash'); run.execution.state = 'queued';
    await history.reserve(run);
    history = new PersistentHistory(directory);
    const restored = await history.lookupRequest(run.requestId);
    assert.equal(restored?.execution.id, run.execution.id);
    assert.equal(restored?.execution.state, 'interrupted');
    assert.match(restored?.execution.error ?? '', /no automatic relaunch/);
    await assert.rejects(history.reserve({ ...run, execution: { ...run.execution, id: randomUUID() } }), status(409));
  });

  it('rejects reuse for a different participant, source, device or generation, including concurrent reservations', async () => {
    const run = execution('unique-request');
    const competing = { ...run, sourceHash: hash('other source') };
    const results = await Promise.allSettled([history.reserve(run), history.reserve(competing)]);
    assert.equal(results[0]?.status, 'fulfilled');
    assert.equal(results[1]?.status, 'rejected');
    if (results[1]?.status === 'rejected') assert.ok(status(409)(results[1].reason));
    for (const update of [{ requesterId: 'other' }, { deviceId: 'other' }, { generation: 4 }]) {
      await assert.rejects(history.reserve({ ...run, execution: { ...run.execution, ...update } }), status(409));
    }
    await assert.rejects(history.reserve({ ...run, requestId: 'different-request' }), status(409));
    assert.equal(await history.lookupRequest('different-request'), undefined);
  });

  it('prunes oldest output within quota while preserving identity and an explicit expired-output tombstone', async () => {
    history = new PersistentHistory(directory, { maxArchiveBytes: 2400, maxOutputBytes: 4096 });
    const first = execution('first', 'A'.repeat(1500));
    const second = execution('second', 'B'.repeat(1500));
    await history.archive(first);
    await history.archive(second);
    const entries = await readdir(path.join(directory, 'history', 'outputs'));
    let size = 0;
    for (const entry of entries) size += (await stat(path.join(directory, 'history', 'outputs', entry))).size;
    assert.ok(size <= 2400);
    history = new PersistentHistory(directory, { maxArchiveBytes: 2400, maxOutputBytes: 4096 });
    const expired = await history.lookupExecution(first.execution.id);
    assert.equal(expired?.execution.state, 'completed');
    assert.equal(expired?.execution.error, 'Output retention exceeded; result output expired');
    assert.deepEqual(expired?.execution.events, []);
    assert.deepEqual(await history.lookupRequest(second.requestId), second);
    await assert.rejects(history.reserve({ ...first, execution: { ...first.execution, id: randomUUID() } }), status(409));
    await history.archive(first);
    assert.equal((await history.lookupRequest(first.requestId))?.execution.error, expired?.execution.error);
  });

  it('expires an individually oversized retention result without imposing a lifetime launch limit', async () => {
    history = new PersistentHistory(directory, { maxArchiveBytes: 0, maxOutputBytes: 4096 });
    for (let number = 0; number < 40; number++) {
      const run = execution(`many-${number}`);
      await history.archive(run);
      assert.equal((await history.lookupRequest(run.requestId))?.execution.error, 'Output retention exceeded; result output expired');
    }
    assert.deepEqual(await readdir(path.join(directory, 'history', 'outputs')), []);
    assert.equal((await readdir(path.join(directory, 'history', 'requests'))).length, 40);
  });

  it('refuses divergent terminal output and verifies persisted output digests', async () => {
    const run = execution('integrity');
    await history.archive(run);
    await assert.rejects(history.archive({ ...run, execution: { ...run.execution, events: [{ text: 'changed' }] } }), status(409));
    const stored = JSON.parse(await readFile(outputPath(run.execution.id), 'utf8'));
    stored.run.execution.events = [{ text: 'tampered' }];
    await writeFile(outputPath(run.execution.id), JSON.stringify(stored));
    await assert.rejects(history.lookupRequest(run.requestId), status(500));
  });

  it('rejects unsafe IDs, symlink ancestors, linked receipts and linked output', async () => {
    assert.throws(() => history.lookupRequest('../escape'), status(400));
    assert.throws(() => history.lookupExecution('../escape'), status(400));
    const run = execution('safe'); await history.archive(run);
    const outside = path.join(directory, 'outside.json');
    await link(receiptPath(run.requestId), outside);
    await assert.rejects(history.lookupRequest(run.requestId), status(500));
    await unlink(outside);
    const output = outputPath(run.execution.id);
    await link(output, outside);
    await assert.rejects(history.lookupExecution(run.execution.id), status(500));
    await unlink(outside);
    await unlink(output);
    await writeFile(outside, '{}');
    await symlink(outside, output);
    await assert.rejects(history.lookupExecution(run.execution.id), status(500));
    const linked = path.join(directory, 'linked');
    await symlink(directory, linked, 'dir');
    await assert.rejects(new PersistentHistory(linked).lookupRequest('test'), status(500));
  });

  it('fails closed on corrupt receipts and refuses over-limit results without losing their reservation', async () => {
    history = new PersistentHistory(directory, { maxOutputBytes: 1024 });
    const run = execution('bounded', 'x'.repeat(4096));
    await assert.rejects(history.archive(run), status(413));
    assert.match((await history.lookupRequest(run.requestId))?.execution.error ?? '', /no automatic relaunch/);
    await writeFile(receiptPath(run.requestId), 'null');
    await assert.rejects(history.lookupRequest(run.requestId), status(500));
  });

  it('recovers partial archive publication and abandoned atomic temporaries without replaying requests', async () => {
    const unfinished = execution('half-archive');
    await history.reserve(unfinished);
    await writeFile(outputPath(unfinished.execution.id), '{}');
    await mkdir(path.join(directory, 'history', 'outputs'), { recursive: true });
    const temporary = `${outputPath(randomUUID())}.pair-notebook-${randomUUID()}.tmp`;
    await writeFile(temporary, 'unfinished atomic write');
    await history.archive(execution('next-after-crash'));
    assert.match((await history.lookupRequest(unfinished.requestId))?.execution.error ?? '', /no automatic relaunch/);
    const files = await readdir(path.join(directory, 'history', 'outputs'));
    assert.ok(!files.includes(path.basename(temporary)));
    assert.ok(!files.includes(`${unfinished.execution.id}.json`));
  });
});
