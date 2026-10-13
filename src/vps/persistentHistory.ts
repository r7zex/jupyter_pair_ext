import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../core/atomicFile';
import type { PersistentExecution } from './persistentProtocol';

const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
const EXECUTION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const RECEIPT_BYTES = 64 * 1024;
const EXPIRED = 'Output retention exceeded; result output expired';
const UNFINISHED = 'Execution receipt has no final result; no automatic relaunch.';
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT';

export interface PersistentHistoryRun {
  execution: PersistentExecution;
  requestId: string;
  commandId: string;
  cellIdentity: string;
  sourceHash: string;
  notebookVersion: number;
  offset: number;
  reports: { offset: number; digest: string; end: number }[];
  aclEpoch: number;
  controls: { id: string; command: Record<string, unknown> }[];
  mergePending?: boolean;
}
interface Receipt {
  version: 1; requestId: string; executionId: string; identity: string;
  createdAt: number; run: PersistentHistoryRun; terminal: boolean;
  outputDigest?: string; outputExpired?: boolean;
}
interface Output { version: 1; identity: string; digest: string; run: PersistentHistoryRun }
export interface PersistentHistoryLimits { maxArchiveBytes?: number; maxOutputBytes?: number }

export class PersistentHistoryError extends Error {
  public constructor(public readonly status: number, message: string) { super(message); }
}

/** Small permanent request receipts prevent replay after bounded result output is pruned.
 * The containing server must own its single-writer data directory. No archive is loaded
 * into memory on startup; lookups read one request, one execution and at most one result.
 */
export class PersistentHistory {
  private readonly root: string;
  private readonly requests: string;
  private readonly executions: string;
  private readonly outputs: string;
  private readonly archiveLimit: number;
  private readonly outputLimit: number;
  private serial: Promise<unknown> = Promise.resolve();

  public constructor(sessionDirectory: string, limits: PersistentHistoryLimits = {}) {
    this.root = path.join(path.resolve(sessionDirectory), 'history');
    this.requests = path.join(this.root, 'requests');
    this.executions = path.join(this.root, 'executions');
    this.outputs = path.join(this.root, 'outputs');
    this.archiveLimit = limits.maxArchiveBytes ?? 128 * 1024 * 1024;
    this.outputLimit = limits.maxOutputBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.archiveLimit) || this.archiveLimit < 0
      || !Number.isSafeInteger(this.outputLimit) || this.outputLimit < 1024) throw new Error('Invalid execution history limits.');
  }

  public lookupRequest(requestId: string): Promise<PersistentHistoryRun | undefined> {
    this.requestId(requestId);
    return this.enqueue(async () => {
      await this.initialize();
      const receipt = await this.readReceipt(this.requestPath(requestId));
      if (!receipt) return undefined;
      if (receipt.requestId !== requestId) this.corrupt();
      const execution = await this.readReceipt(this.executionPath(receipt.executionId));
      if (!execution) return this.unfinished(receipt.run);
      this.sameReceipt(receipt, execution);
      return this.result(execution);
    });
  }

  public lookupExecution(executionId: string): Promise<PersistentHistoryRun | undefined> {
    this.executionId(executionId);
    return this.enqueue(async () => {
      await this.initialize();
      const receipt = await this.readReceipt(this.executionPath(executionId));
      if (!receipt) return undefined;
      if (receipt.executionId !== executionId) this.corrupt();
      const request = await this.readReceipt(this.requestPath(receipt.requestId));
      if (!request) this.corrupt();
      this.sameReceipt(request, receipt);
      return this.result(receipt);
    });
  }

  public reserve(run: PersistentHistoryRun): Promise<void> {
    return this.enqueue(async () => { await this.initialize(); await this.reserveInternal(run); });
  }

  public archive(run: PersistentHistoryRun): Promise<void> {
    return this.enqueue(async () => {
      await this.initialize();
      const receipt = await this.reserveInternal(run);
      if (run.execution.state === 'queued' || run.execution.state === 'running') {
        throw new PersistentHistoryError(409, 'Only a terminal execution may be archived.');
      }
      const payload = JSON.stringify(run);
      const digest = hash(payload);
      const output: Output = { version: 1, identity: receipt.identity, digest, run };
      const bytes = JSON.stringify(output);
      if (Buffer.byteLength(bytes) > this.outputLimit) throw new PersistentHistoryError(413, 'Execution result exceeds its output limit.');
      const previous = await this.readReceipt(this.executionPath(run.execution.id));
      if (previous?.terminal) {
        if (previous.outputDigest !== digest) throw new PersistentHistoryError(409, 'An archived execution cannot be replaced with a different result.');
        await this.prune();
        return;
      }
      await this.write(this.outputPath(run.execution.id), bytes);
      const terminal: Receipt = { ...receipt, run: this.metadata(run), terminal: true, outputDigest: digest };
      await this.write(this.executionPath(run.execution.id), JSON.stringify(terminal));
      await this.prune();
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation);
    this.serial = result.catch(() => undefined);
    return result;
  }

  private requestId(value: string): void {
    if (typeof value !== 'string' || !REQUEST_ID.test(value)) throw new PersistentHistoryError(400, 'Invalid execution request ID.');
  }
  private executionId(value: string): void {
    if (typeof value !== 'string' || !EXECUTION_ID.test(value)) throw new PersistentHistoryError(400, 'Invalid archived execution ID.');
  }
  private requestPath(id: string): string { this.requestId(id); return path.join(this.requests, `${hash(id)}.json`); }
  private executionPath(id: string): string { this.executionId(id); return path.join(this.executions, `${id}.json`); }
  private outputPath(id: string): string { this.executionId(id); return path.join(this.outputs, `${id}.json`); }
  private corrupt(): never { throw new PersistentHistoryError(500, 'Execution history is invalid; no automatic relaunch is permitted.'); }

  private validateRun(value: unknown): asserts value is PersistentHistoryRun {
    if (!value || typeof value !== 'object') this.corrupt();
    const run = value as PersistentHistoryRun;
    this.requestId(run.requestId); this.executionId(run.execution?.id);
    if (!run.execution || !['queued', 'running', 'completed', 'failed', 'interrupted'].includes(run.execution.state)
      || typeof run.execution.requesterId !== 'string' || typeof run.execution.notebook !== 'string'
      || !Number.isSafeInteger(run.execution.cellIndex) || run.execution.cellIndex < 0
      || !Number.isSafeInteger(run.execution.generation) || typeof run.execution.deviceId !== 'string'
      || !Array.isArray(run.execution.events) || typeof run.commandId !== 'string'
      || typeof run.cellIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(run.sourceHash)
      || !Number.isSafeInteger(run.notebookVersion) || !Number.isSafeInteger(run.aclEpoch)
      || !Number.isSafeInteger(run.offset) || !Array.isArray(run.reports) || !Array.isArray(run.controls)) this.corrupt();
  }

  private identity(run: PersistentHistoryRun): string {
    const execution = run.execution;
    return hash(JSON.stringify([run.requestId, execution.id, execution.requesterId, execution.notebook,
      execution.cellIndex, execution.deviceId, execution.gpuUuid ?? null, execution.generation,
      run.commandId, run.cellIdentity, run.sourceHash, run.notebookVersion, run.aclEpoch]));
  }

  private metadata(run: PersistentHistoryRun): PersistentHistoryRun {
    // No code, files, events or control bodies enter permanent receipts.
    const execution: PersistentExecution = { id: run.execution.id, notebook: run.execution.notebook,
      cellIndex: run.execution.cellIndex, requesterId: run.execution.requesterId, deviceId: run.execution.deviceId,
      generation: run.execution.generation, state: run.execution.state, events: [],
      ...(run.execution.gpuUuid ? { gpuUuid: run.execution.gpuUuid } : {}),
      ...(run.execution.error ? { error: run.execution.error.slice(0, 2048) } : {}) };
    return { execution, requestId: run.requestId, commandId: run.commandId, cellIdentity: run.cellIdentity,
      sourceHash: run.sourceHash, notebookVersion: run.notebookVersion, offset: 0,
      reports: [], aclEpoch: run.aclEpoch, controls: [] };
  }

  private unfinished(run: PersistentHistoryRun): PersistentHistoryRun {
    const result = this.metadata(run);
    result.execution.state = 'interrupted'; result.execution.error = UNFINISHED;
    return result;
  }

  private async reserveInternal(run: PersistentHistoryRun): Promise<Receipt> {
    this.validateRun(run);
    const identity = this.identity(run);
    const executionPath = this.executionPath(run.execution.id);
    const existingExecution = await this.readReceipt(executionPath);
    if (existingExecution && existingExecution.identity !== identity) {
      throw new PersistentHistoryError(409, 'Execution ID already belongs to a different request.');
    }
    const requestPath = this.requestPath(run.requestId);
    let receipt = await this.readReceipt(requestPath);
    if (receipt) {
      if (receipt.identity !== identity) throw new PersistentHistoryError(409, 'Execution request ID already belongs to a different execution.');
    } else {
      receipt = { version: 1, requestId: run.requestId, executionId: run.execution.id,
        identity, createdAt: Date.now(), run: this.metadata(run), terminal: false };
      const bytes = JSON.stringify(receipt);
      if (Buffer.byteLength(bytes) > RECEIPT_BYTES) throw new PersistentHistoryError(413, 'Execution receipt exceeds its metadata limit.');
      await this.write(requestPath, bytes);
    }
    if (existingExecution) this.sameReceipt(receipt, existingExecution);
    else await this.write(executionPath, JSON.stringify(receipt));
    return receipt;
  }

  private sameReceipt(first: Receipt, second: Receipt): void {
    if (first.identity !== second.identity || first.requestId !== second.requestId || first.executionId !== second.executionId) this.corrupt();
  }

  private async result(receipt: Receipt): Promise<PersistentHistoryRun> {
    if (!receipt.terminal) return this.unfinished(receipt.run);
    if (receipt.outputExpired) {
      const run = this.metadata(receipt.run); run.execution.error = EXPIRED; return run;
    }
    const bytes = await this.read(this.outputPath(receipt.executionId), this.outputLimit);
    if (!bytes) this.corrupt();
    let output: Output;
    try { output = JSON.parse(bytes) as Output; } catch { this.corrupt(); }
    if (!output || typeof output !== 'object') this.corrupt();
    try { this.validateRun(output.run); } catch { this.corrupt(); }
    if (output.version !== 1 || output.identity !== receipt.identity || this.identity(output.run) !== receipt.identity
      || output.digest !== receipt.outputDigest || hash(JSON.stringify(output.run)) !== output.digest) this.corrupt();
    return output.run;
  }

  private async readReceipt(file: string): Promise<Receipt | undefined> {
    const bytes = await this.read(file, RECEIPT_BYTES);
    if (!bytes) return undefined;
    let receipt: Receipt;
    try { receipt = JSON.parse(bytes) as Receipt; } catch { this.corrupt(); }
    if (!receipt || typeof receipt !== 'object') this.corrupt();
    try { this.validateRun(receipt.run); } catch { this.corrupt(); }
    if (receipt.version !== 1 || receipt.requestId !== receipt.run.requestId || receipt.executionId !== receipt.run.execution.id
      || typeof receipt.terminal !== 'boolean' || !Number.isSafeInteger(receipt.createdAt)
      || receipt.identity !== this.identity(receipt.run) || receipt.run.execution.events.length
      || receipt.run.controls.length || receipt.run.reports.length
      || (receipt.terminal && !/^[a-f0-9]{64}$/.test(receipt.outputDigest ?? ''))
      || (receipt.outputExpired !== undefined && typeof receipt.outputExpired !== 'boolean')) this.corrupt();
    return receipt;
  }

  private async initialize(): Promise<void> {
    // Check each ancestor before creating the next directory; never traverse a link.
    let current = path.parse(this.root).root;
    for (const component of this.root.slice(current.length).split(path.sep)) {
      current = path.join(current, component);
      try { await this.directory(current); }
      catch (error) {
        if (!missing(error)) throw error;
        try { await mkdir(current, { mode: 0o700 }); } catch (creation) { if ((creation as NodeJS.ErrnoException).code !== 'EEXIST') throw creation; }
        await this.directory(current);
      }
    }
    for (const directory of [this.requests, this.executions, this.outputs]) {
      try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      await this.directory(directory);
    }
  }

  private async directory(directory: string): Promise<void> {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) this.corrupt();
  }

  private async read(file: string, limit: number): Promise<string | undefined> {
    let handle;
    try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (missing(error)) return undefined; this.corrupt(); }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > limit) this.corrupt();
      const bytes = await handle.readFile();
      if (bytes.length > limit || bytes.length !== info.size) this.corrupt();
      return bytes.toString('utf8');
    } finally { await handle.close(); }
  }

  private async write(file: string, bytes: string): Promise<void> {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) this.corrupt();
    } catch (error) { if (!missing(error)) throw error; }
    await atomicWriteFile(file, bytes);
    await chmod(file, 0o600);
  }

  private async prune(): Promise<void> {
    // Streaming scans retain only one oldest candidate, regardless of history length.
    for (;;) {
      let total = 0;
      let oldest: { id: string; mtime: number } | undefined;
      for await (const entry of await opendir(this.outputs)) {
        if (/^[a-f0-9-]{36}\.json\.pair-notebook-[a-f0-9-]{36}\.tmp$/i.test(entry.name)) {
          const temporary = path.join(this.outputs, entry.name);
          const info = await lstat(temporary);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) this.corrupt();
          // An interrupted atomic publication cannot authorize a new execution.
          await unlink(temporary);
          continue;
        }
        const id = entry.name.replace(/\.json$/, '');
        if (!EXECUTION_ID.test(id) || entry.name !== `${id}.json` || !entry.isFile() || entry.isSymbolicLink()) this.corrupt();
        const info = await lstat(this.outputPath(id));
        if (!info.isFile() || info.nlink !== 1 || info.size > this.outputLimit) this.corrupt();
        const receipt = await this.readReceipt(this.executionPath(id));
        if (!receipt) this.corrupt();
        if (!receipt.terminal) {
          // Crash between output publication and terminal metadata: retain the
          // permanent reservation and report an incomplete result, never replay.
          await unlink(this.outputPath(id));
          continue;
        }
        total += info.size;
        if (!oldest || info.mtimeMs < oldest.mtime) oldest = { id, mtime: info.mtimeMs };
      }
      if (total <= this.archiveLimit || !oldest) return;
      const receipt = await this.readReceipt(this.executionPath(oldest.id));
      if (!receipt?.terminal) this.corrupt();
      await this.write(this.executionPath(oldest.id), JSON.stringify({ ...receipt, outputExpired: true } satisfies Receipt));
      await unlink(this.outputPath(oldest.id));
    }
  }
}
