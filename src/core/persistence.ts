import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, publishTemporaryFile, syncFileContents, temporarySibling } from './atomicFile';
import { hashFileContents, MAX_TRACKED_PROJECT_ENTRIES, scanDirectories, scanProject } from './projectFiles';
import { portablePathComparisonKey, relativePathsNested, safeRelativePath } from './projectPath';

export { safeRelativePath } from './projectPath';


export type SerializeDocument = (relativePath: string) => Promise<Uint8Array>;

export interface MaterializedFolderInspection {
  empty: boolean;
  matches: boolean;
  missing: string[];
  different: string[];
  extra: string[];
}

/**
 * Retry delay after a failed flush.  It is deliberately longer than the edit
 * debounce so a broken disk produces a slow retry instead of a busy loop.
 */
const RETRY_DELAY_MS = 5_000;

export interface PersistenceOptions {
  workingRoot: string;
  backingRoot?: string | undefined;
  debounceMs: number;
  serialize: SerializeDocument;
  /** Returns true when an open editor persisted the working copy itself. */
  writeWorkingCopy?: ((relativePath: string, bytes: Uint8Array) => Promise<boolean>) | undefined;
  /** Records extension-owned writes so the filesystem watcher cannot feed them back into the CRDT. */
  onWorkingCopyWrite?: ((relativePath: string, bytes: Uint8Array) => void) | undefined;
}

export class StorageAdapter extends EventEmitter {
  private readonly pending = new Set<string>();
  private readonly redirects = new Map<string, string>();
  private readonly removed = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private queue: Promise<void> = Promise.resolve();
  private active = true;
  private backingRoot: string | undefined;
  /**
   * A failure reaches both the awaiting caller and the debounced timer, so the
   * diagnostic channel deduplicates it instead of reporting the same error twice.
   */
  private readonly reportedErrors = new WeakSet<object>();
  public lastFlushAt = 0;

  public constructor(private readonly options: PersistenceOptions) {
    super();
    this.backingRoot = options.backingRoot;
  }

  public setBackingRoot(backingRoot: string | undefined): void {
    this.backingRoot = backingRoot;
  }

  public setWorkingCopyWriter(writer: PersistenceOptions['writeWorkingCopy']): void {
    this.options.writeWorkingCopy = writer;
  }

  public schedule(relativePath: string): void {
    if (!this.active) return;
    const canonical = canonicalRelativePath(relativePath);
    this.clearRemoved(canonical);
    this.pending.add(canonical);
    if (this.timer) clearTimeout(this.timer);
    // A debounced flush has no caller to await it, so a serialization or write
    // failure must be reported through `operationError` instead of escaping as
    // an unhandled rejection and tearing down the extension host.
    this.timer = setTimeout(() => {
      this.flush().catch((error: unknown) => this.reportError(error));
    }, this.options.debounceMs);
  }


  public async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const paths = [...this.pending];
    this.pending.clear();
    await this.enqueue(async () => {
      const flushed: string[] = [];
      // Whatever is still listed here when an error escapes has not been
      // written, so it must return to `pending` for a later retry.
      const outstanding = new Set(paths);
      const flushOne = async (originalPath: string): Promise<void> => {
        let relativePath = this.resolveCurrentPath(originalPath);
        if (this.isRemoved(relativePath)) return;
        let bytes: Uint8Array;
        try {
          bytes = await this.options.serialize(relativePath);
        } catch (error) {
          const redirectedPath = this.resolveCurrentPath(originalPath);
          if (redirectedPath === relativePath || this.isRemoved(redirectedPath)) throw error;
          relativePath = redirectedPath;
          bytes = await this.options.serialize(relativePath);
        }
        const finalPath = this.resolveCurrentPath(originalPath);
        if (this.isRemoved(finalPath)) return;
        relativePath = finalPath;
        // The host backing folder is the durable source of truth. Persist it
        // before asking VS Code to update an open editor so a transient UI
        // rejection cannot delay the canonical copy.
        if (this.backingRoot) await atomicWrite(this.backingRoot, relativePath, bytes);
        const handledByEditor = await this.options.writeWorkingCopy?.(relativePath, bytes) ?? false;
        if (!handledByEditor) {
          this.options.onWorkingCopyWrite?.(relativePath, bytes);
          await atomicWrite(this.options.workingRoot, relativePath, bytes);
        }
        flushed.push(relativePath);
      };
      try {
        for (const originalPath of paths) {
          await flushOne(originalPath);
          outstanding.delete(originalPath);
        }
      } catch (error) {
        // A transient serialization or disk failure must never silently drop the
        // work: re-arm the unwritten paths so the backing folder catches up as
        // soon as the underlying problem disappears.
        this.requeue(outstanding);
        throw error;
      } finally {
        if (flushed.length) {
          this.lastFlushAt = Date.now();
          this.emit('flushed', flushed);
        }
      }
    });
  }

  /**
   * Returns paths that failed to persist to the pending set and re-arms the
   * debounce timer, so recovery does not wait for the next edit of those files.
   */
  private requeue(paths: Iterable<string>): void {
    if (!this.active) return;
    let restored = false;
    for (const relativePath of paths) {
      if (this.isRemoved(this.resolveCurrentPath(relativePath))) continue;
      this.pending.add(relativePath);
      restored = true;
    }
    if (!restored) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.flush().catch((error: unknown) => this.reportError(error));
    }, Math.max(this.options.debounceMs, RETRY_DELAY_MS));
  }

  public async mirrorBinary(relativePath: string, bytes: Uint8Array): Promise<void> {
    if (!this.active) return;
    const safePath = safeRelativePath(relativePath);
    this.clearRemoved(canonicalRelativePath(safePath));
    await this.enqueue(async () => {
      const target = this.resolveCurrentPath(canonicalRelativePath(safePath));
      if (this.isRemoved(target)) return;
      if (this.backingRoot) await atomicWrite(this.backingRoot, target, bytes);
      this.options.onWorkingCopyWrite?.(target, bytes);
      await atomicWrite(this.options.workingRoot, target, bytes);
      this.lastFlushAt = Date.now();
      this.emit('flushed', [target]);
    });
  }

  /**
   * Publishes a binary that already exists in the working copy to the backing
   * folder with a streaming copy, so a large local file never has to be read
   * into memory.  The copy is published through a rename, so a crash never
   * leaves a partially written backing file.
   */
  public async mirrorBinaryToBacking(relativePath: string, expectedHash?: string): Promise<void> {
    if (!this.active) return;
    const safePath = safeRelativePath(relativePath);
    this.clearRemoved(canonicalRelativePath(safePath));
    await this.enqueue(async () => {
      const backingRoot = this.backingRoot;
      if (!backingRoot) return;
      const target = this.resolveCurrentPath(canonicalRelativePath(safePath));
      if (this.isRemoved(target)) return;
      const source = await safeProjectTarget(this.options.workingRoot, target, true);
      await atomicCopy(source, backingRoot, target, expectedHash);
      this.lastFlushAt = Date.now();
      this.emit('flushed', [target]);
    });
  }

  /**
   * Moves an already fully received file into the working copy (and backing
   * folder) atomically.  The caller streams the transfer into `sourcePath`, so
   * an interrupted transfer never exposes a partially written final file.
   */
  public async mirrorBinaryFile(relativePath: string, sourcePath: string, expectedHash?: string): Promise<void> {
    if (!this.active) return;
    const safePath = safeRelativePath(relativePath);
    this.clearRemoved(canonicalRelativePath(safePath));
    await this.enqueue(async () => {
      const target = this.resolveCurrentPath(canonicalRelativePath(safePath));
      if (this.isRemoved(target)) {
        await rm(sourcePath, { force: true });
        return;
      }
      try {
        if (this.backingRoot) await atomicCopy(sourcePath, this.backingRoot, target, expectedHash);
        await safeProjectTarget(this.options.workingRoot, target);
        await atomicCopy(sourcePath, this.options.workingRoot, target, expectedHash);
      } finally {
        await rm(sourcePath, { force: true });
      }
      this.lastFlushAt = Date.now();
      this.emit('flushed', [target]);
    });
  }

  /**
   * Makes the backing folder a complete durable representation of the supplied
   * authoritative project state.  Used when a peer is promoted to Host: its
   * backing folder may be empty or stale, so a pending-path flush alone is not
   * a persistence barrier.
   */
  public async materializeBacking(
    documents: ReadonlyArray<{ relativePath: string; bytes: Uint8Array }>,
    binaries: ReadonlyArray<{ relativePath: string; sourcePath: string; hash: string }>,
    directories: readonly string[],
  ): Promise<void> {
    const backingRoot = this.backingRoot;
    if (!backingRoot) return;
    await this.enqueue(async () => {
      const desired = await materializeProjectTree(backingRoot, documents, binaries, directories);
      this.lastFlushAt = Date.now();
      this.emit('flushed', [...desired]);
    });
  }

  /** Writes a complete point-in-time copy without changing the configured backing folder. */
  public async materializeFolder(
    targetRoot: string,
    documents: ReadonlyArray<{ relativePath: string; bytes: Uint8Array }>,
    binaries: ReadonlyArray<{ relativePath: string; sourcePath: string; hash: string }>,
    directories: readonly string[],
  ): Promise<void> {
    await this.enqueue(async () => {
      await materializeProjectTree(targetRoot, documents, binaries, directories);
    });
  }

  public async inspectMaterializedFolder(
    targetRoot: string,
    documents: ReadonlyArray<{ relativePath: string; bytes: Uint8Array }>,
    binaries: ReadonlyArray<{ relativePath: string; sourcePath: string; hash: string }>,
    directories: readonly string[],
  ): Promise<MaterializedFolderInspection> {
    let inspection: MaterializedFolderInspection | undefined;
    await this.enqueue(async () => {
      inspection = await inspectMaterializedProjectTree(targetRoot, documents, binaries, directories);
    });
    if (!inspection) throw new Error('Backing-folder inspection did not complete.');
    return inspection;
  }

  /** Verifies a shared copy and binds it without rewriting or deleting its contents. */
  public async bindExistingBacking(
    targetRoot: string,
    documents: ReadonlyArray<{ relativePath: string; bytes: Uint8Array }>,
    binaries: ReadonlyArray<{ relativePath: string; sourcePath: string; hash: string }>,
    directories: readonly string[],
  ): Promise<MaterializedFolderInspection> {
    let inspection: MaterializedFolderInspection | undefined;
    await this.enqueue(async () => {
      inspection = await inspectMaterializedProjectTree(targetRoot, documents, binaries, directories);
      if (inspection.matches) this.backingRoot = targetRoot;
    });
    if (!inspection) throw new Error('Backing-folder verification did not complete.');
    return inspection;
  }

  public async remove(relativePath: string): Promise<void> {

    if (!this.active) return;
    const safePath = safeRelativePath(relativePath);
    const canonical = canonicalRelativePath(relativePath);
    this.removed.add(canonical);
    for (const pendingPath of [...this.pending]) {
      if (isSameOrChild(pendingPath, canonical)) this.pending.delete(pendingPath);
    }
    await this.enqueue(async () => {
      const targets = [rm(await safeProjectTarget(this.options.workingRoot, safePath, true), { recursive: true, force: true })];
      if (this.backingRoot) {
        targets.push(rm(await safeProjectTarget(this.backingRoot, safePath, true), { recursive: true, force: true }));
      }
      await Promise.all(targets);
      this.lastFlushAt = Date.now();
      this.emit('flushed', [safePath]);
    });
  }

  public async createDirectory(relativePath: string): Promise<void> {
    if (!this.active) return;
    const safePath = safeRelativePath(relativePath);
    this.clearRemoved(canonicalRelativePath(safePath));
    await this.enqueue(async () => {
      const target = this.resolveCurrentPath(canonicalRelativePath(safePath));
      if (this.isRemoved(target)) return;
      await mkdir(await safeProjectTarget(this.options.workingRoot, target, true), { recursive: true });
      if (this.backingRoot) await mkdir(await safeProjectTarget(this.backingRoot, target, true), { recursive: true });
      this.lastFlushAt = Date.now();
      this.emit('flushed', [target]);
    });
  }

  public async rename(from: string, to: string, workingAlreadyRenamed = false): Promise<void> {
    if (!this.active) return;
    const safeFrom = safeRelativePath(from);
    const safeTo = safeRelativePath(to);
    if (relativePathsNested(safeFrom, safeTo)) {
      throw new Error('A project path cannot be renamed into or over its own ancestor.');
    }
    const fromKey = canonicalRelativePath(from);
    const toKey = canonicalRelativePath(to);
    this.redirects.set(fromKey, toKey);
    this.removed.add(fromKey);
    this.clearRemoved(toKey);
    let remappedPending = false;
    for (const pendingPath of [...this.pending]) {
      if (!isSameOrChild(pendingPath, fromKey)) continue;
      this.pending.delete(pendingPath);
      this.pending.add(pendingPath === fromKey ? toKey : `${toKey}${pendingPath.slice(fromKey.length)}`);
      remappedPending = true;
    }
    try {
      await this.enqueue(async () => {
        if (!workingAlreadyRenamed) {
          const workingSource = await safeProjectTarget(this.options.workingRoot, safeFrom, true);
          const workingTarget = await safeProjectTarget(this.options.workingRoot, safeTo, true);
          await mkdir(path.dirname(workingTarget), { recursive: true });
          await renameOrPending(workingSource, workingTarget, remappedPending);
        }
        if (this.backingRoot) {
          const backingSource = await safeProjectTarget(this.backingRoot, safeFrom, true);
          const backingTarget = await safeProjectTarget(this.backingRoot, safeTo, true);
          await mkdir(path.dirname(backingTarget), { recursive: true });
          await renameOrPending(backingSource, backingTarget, remappedPending);
        }
        this.lastFlushAt = Date.now();
        this.emit('flushed', [safeFrom, safeTo]);
      });
    } finally {
      // The redirect exists only to retarget operations that were queued before
      // this rename. Once the rename reaches the head of the serialized queue,
      // those operations have drained and the old path is free to be recreated.
      if (this.redirects.get(fromKey) === toKey) this.redirects.delete(fromKey);
    }
  }

  /**
   * Shutdown must always complete the cleanup, even when the final save fails.
   * The failure is surfaced through `operationError` (and rethrown to the
   * caller) only after timers and the queue have been drained.
   */
  public async stop(flush = true): Promise<void> {
    let failure: unknown;
    if (flush) {
      try {
        await this.flush();
      } catch (error) {
        failure = error;
        this.reportError(error);
      }
    }
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    // `this.queue` never rejects (see `enqueue`), so cleanup cannot be skipped.
    await this.queue;
    if (failure) throw failure;
  }

  public pendingCount(): number {
    return this.pending.size;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    // The caller owns the failure; `operationError` is only a diagnostic
    // channel, so the returned promise still rejects for awaiting callers.
    result.catch((error: unknown) => this.reportError(error));
    return result;
  }

  /**
   * Emits a storage failure without ever throwing from an `EventEmitter` that
   * has no `error`-style listener attached.
   */
  private reportError(error: unknown): void {
    if (typeof error === 'object' && error !== null) {
      if (this.reportedErrors.has(error)) return;
      this.reportedErrors.add(error);
    }
    if (this.listenerCount('operationError') === 0) {
      console.error('[pair-notebook] storage operation failed', error);
      return;
    }
    this.emit('operationError', error);
  }


  private resolveCurrentPath(relativePath: string): string {
    let current = canonicalRelativePath(relativePath);
    const visited = new Set<string>();
    while (!visited.has(current)) {
      visited.add(current);
      let changed = false;
      for (const [from, to] of this.redirects) {
        if (!isSameOrChild(current, from)) continue;
        current = current === from ? to : `${to}${current.slice(from.length)}`;
        changed = true;
        break;
      }
      if (!changed) break;
    }
    return current;
  }

  private isRemoved(relativePath: string): boolean {
    return [...this.removed].some((removedPath) => isSameOrChild(relativePath, removedPath));
  }

  private clearRemoved(relativePath: string): void {
    for (const removedPath of [...this.removed]) {
      if (isSameOrChild(relativePath, removedPath) || isSameOrChild(removedPath, relativePath)) this.removed.delete(removedPath);
    }
  }
}

async function inspectMaterializedProjectTree(
  targetRoot: string,
  documents: ReadonlyArray<{ relativePath: string; bytes: Uint8Array }>,
  binaries: ReadonlyArray<{ relativePath: string; sourcePath: string; hash: string }>,
  directories: readonly string[],
): Promise<MaterializedFolderInspection> {
  if (documents.length + binaries.length + directories.length > MAX_TRACKED_PROJECT_ENTRIES) {
    throw new Error(`Project exceeds the ${MAX_TRACKED_PROJECT_ENTRIES}-entry limit.`);
  }
  const normalizedDocuments = documents.map((document) => ({
    ...document,
    relativePath: canonicalRelativePath(document.relativePath),
  }));
  const normalizedBinaries = binaries.map((binary) => {
    if (!/^[a-f0-9]{64}$/i.test(binary.hash)) throw new Error('Materialized binary has an invalid SHA-256 digest.');
    return { ...binary, relativePath: canonicalRelativePath(binary.relativePath), hash: binary.hash.toLowerCase() };
  });
  const normalizedDirectories = directories.map(canonicalRelativePath);
  validateMaterializationManifest(normalizedDocuments, normalizedBinaries, normalizedDirectories);

  let existingFiles: Awaited<ReturnType<typeof scanProject>> = [];
  let existingDirectories: string[] = [];
  try {
    const info = await lstat(targetRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('The selected backing path must be a real directory.');
    }
    [existingFiles, existingDirectories] = await Promise.all([
      scanProject(targetRoot),
      scanDirectories(targetRoot),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const expectedFiles = new Map<string, { relativePath: string; hash: string }>();
  for (const document of normalizedDocuments) {
    expectedFiles.set(filesystemRelativeKey(document.relativePath), {
      relativePath: document.relativePath,
      hash: createHash('sha256').update(document.bytes).digest('hex'),
    });
  }
  for (const binary of normalizedBinaries) {
    expectedFiles.set(filesystemRelativeKey(binary.relativePath), {
      relativePath: binary.relativePath,
      hash: binary.hash,
    });
  }

  const missing: string[] = [];
  const different: string[] = [];
  const extra: string[] = [];
  const seenFiles = new Set<string>();
  for (const file of existingFiles) {
    const key = filesystemRelativeKey(file.relativePath);
    const expected = expectedFiles.get(key);
    if (!expected) {
      extra.push(file.relativePath);
      continue;
    }
    seenFiles.add(key);
    if (file.hash !== expected.hash) different.push(expected.relativePath);
  }
  for (const [key, expected] of expectedFiles) {
    if (!seenFiles.has(key)) missing.push(expected.relativePath);
  }

  const expectedDirectories = new Map(normalizedDirectories.map((directory) => [filesystemRelativeKey(directory), directory]));
  const seenDirectories = new Set(existingDirectories.map(filesystemRelativeKey));
  for (const [key, directory] of expectedDirectories) {
    if (!seenDirectories.has(key)) missing.push(`${directory}/`);
  }
  for (const directory of existingDirectories) {
    if (!expectedDirectories.has(filesystemRelativeKey(directory))) extra.push(`${directory}/`);
  }
  missing.sort();
  different.sort();
  extra.sort();
  return {
    empty: existingFiles.length === 0 && existingDirectories.length === 0,
    matches: missing.length === 0 && different.length === 0 && extra.length === 0,
    missing,
    different,
    extra,
  };
}

async function materializeProjectTree(
  targetRoot: string,
  documents: ReadonlyArray<{ relativePath: string; bytes: Uint8Array }>,
  binaries: ReadonlyArray<{ relativePath: string; sourcePath: string; hash: string }>,
  directories: readonly string[],
): Promise<Set<string>> {
  if (documents.length + binaries.length + directories.length > MAX_TRACKED_PROJECT_ENTRIES) {
    throw new Error(`Project exceeds the ${MAX_TRACKED_PROJECT_ENTRIES}-entry limit.`);
  }
  const normalizedDocuments = documents.map((document) => ({
    ...document,
    relativePath: canonicalRelativePath(document.relativePath),
  }));
  const normalizedBinaries = binaries.map((binary) => {
    if (!/^[a-f0-9]{64}$/i.test(binary.hash)) throw new Error('Materialized binary has an invalid SHA-256 digest.');
    return { ...binary, relativePath: canonicalRelativePath(binary.relativePath), hash: binary.hash.toLowerCase() };
  });
  const normalizedDirectories = directories.map(canonicalRelativePath);
  validateMaterializationManifest(normalizedDocuments, normalizedBinaries, normalizedDirectories);
  await mkdir(targetRoot, { recursive: true });
  const desired = new Map<string, string>();
  for (const directory of [...normalizedDirectories].sort()) {
    await mkdir(await safeProjectTarget(targetRoot, directory, true), { recursive: true });
  }
  for (const document of normalizedDocuments) {
    await atomicWrite(targetRoot, document.relativePath, document.bytes);
    desired.set(filesystemRelativeKey(document.relativePath), document.relativePath);
  }
  for (const binary of normalizedBinaries) {
    await atomicCopy(binary.sourcePath, targetRoot, binary.relativePath, binary.hash);
    desired.set(filesystemRelativeKey(binary.relativePath), binary.relativePath);
  }
  const existingFiles = await scanProject(targetRoot);
  for (const file of existingFiles) {
    if (desired.has(filesystemRelativeKey(file.relativePath))) continue;
    await rm(file.absolutePath, { force: true });
  }
  const desiredDirectories = new Set(normalizedDirectories.map(filesystemRelativeKey));
  const existingDirectories = await scanDirectories(targetRoot);
  for (const directory of existingDirectories.sort((a, b) => b.length - a.length)) {
    const directoryKey = filesystemRelativeKey(directory);
    if (desiredDirectories.has(directoryKey)) continue;
    if ([...desired.keys()].some((file) => file.startsWith(`${directoryKey}/`))) continue;
    await rm(await safeProjectTarget(targetRoot, directory, true), { recursive: true, force: true });
  }
  return new Set(desired.values());
}

function validateMaterializationManifest(
  documents: ReadonlyArray<{ relativePath: string }>,
  binaries: ReadonlyArray<{ relativePath: string }>,
  directories: readonly string[],
): void {
  const fileKeys = new Map<string, string>();
  const directoryKeys = new Map<string, string>();
  for (const entry of [...documents, ...binaries]) {
    const key = portableRelativeKey(entry.relativePath);
    if (fileKeys.has(key)) throw new Error('Materialization manifest contains duplicate or case-conflicting files.');
    fileKeys.set(key, entry.relativePath);
  }
  for (const directory of directories) {
    const key = portableRelativeKey(directory);
    if (directoryKeys.has(key) || fileKeys.has(key)) {
      throw new Error('Materialization manifest contains a duplicate file/directory path.');
    }
    directoryKeys.set(key, directory);
  }
  for (const relativePath of [...fileKeys.values(), ...directoryKeys.values()]) {
    const segments = relativePath.split('/');
    for (let length = 1; length < segments.length; length += 1) {
      const parentKey = portableRelativeKey(segments.slice(0, length).join('/'));
      if (fileKeys.has(parentKey)) throw new Error('Materialization manifest places an entry below a file.');
      if (!directoryKeys.has(parentKey)) throw new Error('Materialization manifest omits a parent directory.');
    }
  }
}

function isSameOrChild(value: string, parent: string): boolean {
  return value === parent || value.startsWith(`${parent}/`);
}

async function renameOrPending(source: string, target: string, pendingWriteWillCreateTarget: boolean): Promise<void> {
  try {
    await rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && pendingWriteWillCreateTarget) return;
    throw error;
  }
}

export async function safeProjectTarget(root: string, relativePath: string, includeTarget = false): Promise<string> {
  const safePath = safeRelativePath(relativePath);
  const rootPath = path.resolve(root);
  const segments = safePath.split(path.sep);
  const checkedSegments = includeTarget ? segments.length : Math.max(0, segments.length - 1);
  let current = rootPath;
  for (let index = 0; index < checkedSegments; index += 1) {
    const segment = segments[index];
    if (segment === undefined) break;
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error(`Project path crosses a symbolic link: ${relativePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return path.join(rootPath, safePath);
}

async function atomicWrite(root: string, relativePath: string, bytes: Uint8Array): Promise<void> {
  const target = await safeProjectTarget(root, relativePath);
  await atomicWriteFile(target, bytes);
}

async function atomicCopy(source: string, root: string, relativePath: string, expectedHash?: string): Promise<void> {
  if (expectedHash !== undefined && !/^[a-f0-9]{64}$/i.test(expectedHash)) {
    throw new Error('Binary copy has an invalid expected SHA-256 digest.');
  }
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
    throw new Error('Binary copy source must be a regular file.');
  }
  const target = await safeProjectTarget(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = temporarySibling(target);
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    await syncFileContents(temporary);
    if (expectedHash !== undefined && await hashFileContents(temporary) !== expectedHash.toLowerCase()) {
      throw new Error(`Binary changed while its authoritative copy was being materialized: ${relativePath}`);
    }
    await publishTemporaryFile(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function canonicalRelativePath(relativePath: string): string {
  return safeRelativePath(relativePath).split(path.sep).join('/');
}

function portableRelativeKey(relativePath: string): string {
  return portablePathComparisonKey(canonicalRelativePath(relativePath));
}

function filesystemRelativeKey(relativePath: string): string {
  const canonical = canonicalRelativePath(relativePath);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? portablePathComparisonKey(canonical)
    : canonical;
}
