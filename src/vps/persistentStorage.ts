import { constants } from 'node:fs';
import { copyFile, lstat, mkdir as makeDirectory, open, readdir, rename as moveFile, unlink } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { portablePathComparisonKey, safeRelativePath } from '../core/projectPath';
import { hasLegacyNotebookMetadata, notebookUserMetadata, cellUserMetadata } from '../core/notebookMetadata';
import type { PersistentFileEntry, PersistentSnapshot } from './persistentProtocol';

export interface PersistentStorageLimits { maxFileBytes: number; maxProjectBytes: number; maxEntries: number }
export const PERSISTENT_STORAGE_LIMITS: Readonly<PersistentStorageLimits> = {
  maxFileBytes: 128 * 1024 * 1024, maxProjectBytes: 128 * 1024 * 1024, maxEntries: 4096,
};

export class PersistentStorageError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'PersistentStorageError'; }
}

interface StoredEntry {
  path: string; type: 'file' | 'directory'; size: number; mtime: number; version: number;
  visibility?: 'public' | 'private'; blob?: string;
  notebookIdentity?: string;
}
interface Manifest { format: 1; revision: number; entries: StoredEntry[]; publications?: string[] }
const PUBLICATION_ID = /^[A-Za-z0-9_-]{1,128}:(?:write|remove):[0-9]{1,3}$/;
const BLOB_NAME = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const INITIALIZED_MARKER = 'pair-persistent-workspace-v1\n';

/** The manifest is the only authority. Project names never become physical filesystem paths.
 * Immutable, synced blobs are published before an atomic, synced manifest replacement.
 * An interrupted operation therefore leaves either the previous or the complete new revision.
 */
export class PersistentWorkspace {
  private readonly root: string;
  private readonly blobDirectory: string;
  private readonly manifestPath: string;
  private readonly markerPath: string;
  private readonly limits: PersistentStorageLimits;
  private readonly privatePaths = new WeakMap<Manifest, Set<string>>();
  private manifest: Manifest | undefined;
  private pending: Promise<void> = Promise.resolve();

  constructor(root: string, limits: Partial<PersistentStorageLimits> = {}) {
    this.root = path.resolve(root);
    this.blobDirectory = path.join(this.root, 'blobs');
    this.manifestPath = path.join(this.root, 'manifest.json');
    this.markerPath = path.join(this.root, 'initialized');
    this.limits = { ...PERSISTENT_STORAGE_LIMITS, ...limits };
    for (const value of Object.values(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid persistent storage limit.');
    }
  }

  async init(): Promise<void> {
    if (this.manifest) return;
    await assertDirectoryChain(this.root, true);
    const firstCreated = await makeDirectory(this.root, { recursive: true, mode: 0o700 });
    await assertDirectoryChain(this.root);
    if (firstCreated) {
      // A synced manifest is insufficient when the newly created store directory itself
      // has not been made durable in its parent (including a new session directory).
      let created = this.root;
      for (;;) {
        await syncDirectory(created);
        const parent = path.dirname(created);
        await syncDirectory(parent);
        if (created === firstCreated) break;
        created = parent;
      }
    }
    await makeDirectory(this.blobDirectory, { mode: 0o700 }).catch((error: unknown) => {
      if (!hasCode(error, 'EEXIST')) throw error;
    });
    await this.checkDirectories();
    let initialized = false;
    try {
      if ((await readRegularFile(this.markerPath, 64)).toString('utf8') !== INITIALIZED_MARKER) corrupt();
      initialized = true;
    } catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
    let loaded: Manifest;
    try {
      const bytes = await readRegularFile(this.manifestPath, MAX_MANIFEST_BYTES);
      loaded = this.validateManifest(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      if (hasCode(error, 'ENOENT')) {
        // A missing manifest in a previously populated store must never silently erase state.
        if (initialized || (await readdir(this.blobDirectory)).length > 0) corrupt();
        loaded = { format: 1, revision: 0, entries: [] };
        await this.publish(loaded);
      } else {
        if (error instanceof PersistentStorageError) throw error;
        corrupt();
      }
    }
    for (const entry of loaded.entries) if (entry.type === 'file') await this.readBlob(entry);
    await this.collectGarbage(loaded);
    if (!initialized) {
      const temporary = path.join(this.root, `.init-${randomBytes(16).toString('hex')}.tmp`);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(INITIALIZED_MARKER); await handle.sync(); } finally { await handle.close(); }
      await moveFile(temporary, this.markerPath);
      await syncDirectory(this.root);
    }
    // Temporary manifests were never published, so they are safe to remove on recovery.
    for (const name of await readdir(this.root)) {
      if (/^\.(?:manifest|init)-[a-f0-9]{32}\.tmp$/.test(name)) {
        const temporary = path.join(this.root, name);
        await assertRegularFile(temporary);
        await unlink(temporary);
      }
    }
    await syncDirectory(this.root);
    this.manifest = loaded;
  }

  snapshot(owner: boolean): PersistentSnapshot {
    const manifest = this.current();
    return { revision: manifest.revision, entries: manifest.entries
      .filter((entry) => owner || this.visibility(entry.path, manifest) === 'public')
      .map((entry): PersistentFileEntry => ({ path: entry.path, type: entry.type, size: entry.size,
        mtime: entry.mtime, version: entry.version, visibility: this.visibility(entry.path, manifest) }))
      .sort((left, right) => left.path.localeCompare(right.path)) };
  }

  read(value: string, owner: boolean): Promise<{ content: string; revision: number }> {
    return this.enqueue(async () => {
      const manifest = this.current();
      const name = normalizePath(value);
      this.authorize(name, owner, manifest);
      const entry = manifest.entries.find((item) => item.path === name);
      if (!entry || entry.type !== 'file') missing();
      await this.checkDirectories();
      return { content: (await this.readBlob(entry)).toString('base64'), revision: manifest.revision };
    });
  }

  /** Compute snapshots always use the member ACL, including when the requester is the owner. */
  publicSnapshot(maxBytes = 10 * 1024 * 1024, privateExecution = false): Promise<{ path: string; content: string }[]> {
    return this.enqueue(async () => {
      const manifest = this.current();
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) quota();
      const publicFiles = manifest.entries.filter((entry) => entry.type === 'file' && (privateExecution || this.visibility(entry.path, manifest) === 'public'));
      // Bound serialized command size before allocating content buffers on a small VPS.
      const serializedBytes = publicFiles.reduce((sum, entry) => sum + Math.ceil(entry.size / 3) * 4
        + Buffer.byteLength(JSON.stringify(entry.path), 'utf8') + 26, 2);
      if (serializedBytes > maxBytes) quota();
      await this.checkDirectories();
      const result: { path: string; content: string }[] = [];
      for (const entry of publicFiles) {
        result.push({ path: entry.path, content: (await this.readBlob(entry)).toString('base64') });
      }
      return result;
    });
  }

  hasPublication(id: string): boolean { return this.current().publications?.includes(id) === true; }
  /** Pin immutable inputs outside the live blob GC; command JSON stays small. */
  computeSnapshot(directory: string, privateExecution: boolean): Promise<{ path: string; content?: string; size: number; sha256: string; version: number }[]> {
    return this.enqueue(async () => {
      await assertDirectoryChain(directory, true); await makeDirectory(directory, { recursive: true, mode: 0o700 }); await assertDirectoryChain(directory);
      const files = this.current().entries.filter((entry) => entry.type === 'file' && (privateExecution || this.visibility(entry.path, this.current()) === 'public'));
      const result: { path: string; content?: string; size: number; sha256: string; version: number }[] = [];
      let inlineBytes = 0;
      for (const entry of files) {
        const common = { path: entry.path, size: entry.size, sha256: entry.blob!, version: entry.version };
        if (inlineBytes + entry.size <= 256 * 1024) { inlineBytes += entry.size; result.push({ ...common, content: (await this.readBlob(entry)).toString('base64') }); }
        else {
          const source = path.join(this.blobDirectory, entry.blob!); await assertRegularFile(source);
          const destination = path.join(directory, createHash('sha256').update(entry.path).digest('hex'));
          await copyFile(source, destination, constants.COPYFILE_EXCL);
          if (await hashRegularFile(destination, this.limits.maxFileBytes) !== entry.blob) corrupt();
          const handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); }
          result.push(common);
        }
      }
      await syncDirectory(directory); return result;
    });
  }

  /** Publish a verified, privately staged binary without allocating its Base64. */
  writeStaged(value: string, filename: string, size: number, hash: string, expectedRevision: number, owner: boolean, publicationId: string, privateResult: boolean): Promise<PersistentSnapshot> {
    return this.mutate(expectedRevision, owner, async (next) => {
      const name = normalizePath(value); this.authorize(name, owner, next);
      if (name.endsWith('.ipynb') || !BLOB_NAME.test(hash) || !Number.isSafeInteger(size) || size < 0 || size > this.limits.maxFileBytes) invalid('Invalid staged file.');
      const existing = next.entries.find((entry) => entry.path === name);
      if (existing?.type === 'directory') invalid('Cannot replace a directory.');
      if (privateResult && (!owner || (existing && this.visibility(name, next) !== 'private'))) throw new PersistentStorageError('FORBIDDEN', 'Private results cannot replace Public files.');
      const info = await lstat(filename); if (info.size !== size || await hashRegularFile(filename, this.limits.maxFileBytes) !== hash) invalid('Staged file checksum disagrees.');
      const parents = privateResult ? new Set(next.entries.map((entry) => entry.path)) : undefined; this.ensureParents(name, next);
      if (parents) for (const entry of next.entries) if (entry.type === 'directory' && !parents.has(entry.path)) entry.visibility = 'private';
      next.entries = next.entries.filter((entry) => entry.path !== name);
      next.entries.push({ path: name, type: 'file', size, mtime: Date.now(), version: next.revision, blob: hash,
        ...(privateResult ? { visibility: 'private' as const } : existing?.visibility ? { visibility: existing.visibility } : {}) });
      this.validateEntries(next);
      const destination = path.join(this.blobDirectory, hash);
      try { await copyFile(filename, destination, constants.COPYFILE_EXCL); }
      catch (error) { if (!hasCode(error, 'EEXIST')) throw error; }
      if (await hashRegularFile(destination, this.limits.maxFileBytes) !== hash) corrupt();
      const handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); }
      await syncDirectory(this.blobDirectory);
    }, undefined, publicationId);
  }
  notebookIdentity(value: string, owner: boolean): string {
    const name = normalizePath(value); const manifest = this.current(); this.authorize(name, owner, manifest);
    const entry = manifest.entries.find((item) => item.path === name); if (!entry || entry.type !== 'file' || !name.endsWith('.ipynb')) missing();
    return entry.notebookIdentity ?? createHash('sha256').update(JSON.stringify([entry.path, entry.blob, entry.version])).digest('hex').slice(0, 32);
  }

  async retainPublications(executionIds: string[], publicationIds: string[] = []): Promise<void> {
    const keep = this.current().publications?.filter((id) => executionIds.includes(id.split(':')[0]!) || publicationIds.includes(id)) ?? [];
    if (keep.length === (this.current().publications?.length ?? 0)) return;
    await this.mutate(this.current().revision, true, (next) => { next.publications = keep; });
  }

  write(value: string, content: string, expectedRevision: number, owner: boolean, publicationId?: string, privateResult = false, preserveNotebookIdentity = false): Promise<PersistentSnapshot> {
    return this.mutate(expectedRevision, owner, async (next) => {
      const name = normalizePath(value);
      this.authorize(name, owner, next);
      let bytes = decodeContent(content, this.limits.maxFileBytes);
      if (name.endsWith('.ipynb') && !bytes.toString('utf8').trim()) {
        bytes = Buffer.from(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }));
      }
      if (name.endsWith('.ipynb') && !preserveNotebookIdentity) {
        // Raw file replacement must not retain an obsolete embedded replica.
        try { const notebook = JSON.parse(bytes.toString('utf8')) as { metadata?: Record<string, unknown> };
          if (notebook.metadata?.pair_crdt || notebook.metadata?.pairNotebookServerEpoch || (notebook.metadata && hasLegacyNotebookMetadata(notebook.metadata))) {
            const legacy = hasLegacyNotebookMetadata(notebook.metadata!);
            notebook.metadata = legacy ? notebookUserMetadata(notebook.metadata!) : { ...notebook.metadata }; delete notebook.metadata.pair_crdt; delete notebook.metadata.pairNotebookServerEpoch;
            bytes = Buffer.from(JSON.stringify(notebook));
          }
        } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      }
      const existing = next.entries.find((entry) => entry.path === name);
      if (privateResult && (!owner || (existing && this.visibility(name, next) !== 'private'))) {
        throw new PersistentStorageError('FORBIDDEN', 'Private execution cannot publish into Public files.');
      }
      if (existing?.type === 'directory') invalid('A directory cannot be overwritten by a file.');
      const originalParents = privateResult ? new Set(next.entries.map((entry) => entry.path)) : undefined;
      this.ensureParents(name, next);
      if (originalParents) for (const entry of next.entries) if (entry.type === 'directory' && !originalParents.has(entry.path)) entry.visibility = 'private';
      const blob = createHash('sha256').update(bytes).digest('hex');
      const entry: StoredEntry = { path: name, type: 'file', size: bytes.length, mtime: Date.now(),
        version: next.revision, blob, ...(privateResult ? { visibility: 'private' as const } : existing?.visibility ? { visibility: existing.visibility } : {}) };
      if (name.endsWith('.ipynb')) entry.notebookIdentity = preserveNotebookIdentity && existing ? this.notebookIdentity(name, owner) : randomBytes(16).toString('hex');
      next.entries = next.entries.filter((item) => item.path !== name);
      next.entries.push(entry);
      this.validateEntries(next);
      await this.storeBlob(blob, bytes);
    }, undefined, publicationId);
  }

  mkdir(value: string, expectedRevision: number, owner: boolean, visibility?: 'public' | 'private'): Promise<PersistentSnapshot> {
    return this.mutate(expectedRevision, owner, (next) => {
      const name = normalizePath(value);
      this.authorize(name, owner, next);
      if (visibility !== undefined && !owner) throw new PersistentStorageError('FORBIDDEN', 'Only the owner can set visibility.');
      if (visibility !== undefined && visibility !== 'public' && visibility !== 'private') invalid('Invalid visibility.');
      if (next.entries.some((entry) => entry.path === name)) invalid('Path already exists.');
      this.ensureParents(name, next);
      next.entries.push({ path: name, type: 'directory', size: 0, mtime: Date.now(), version: next.revision,
        ...(visibility ? { visibility } : {}) });
    });
  }

  rename(value: string, newValue: string, expectedRevision: number, owner: boolean, beforePublish?: () => Promise<void>): Promise<PersistentSnapshot> {
    return this.mutate(expectedRevision, owner, (next) => {
      const name = normalizePath(value);
      const target = normalizePath(newValue);
      this.authorize(name, owner, next);
      this.authorize(target, owner, next);
      const source = next.entries.find((entry) => entry.path === name);
      if (!source) missing();
      if (target === name || target.startsWith(`${name}/`)) invalid('Invalid rename destination.');
      const moving = next.entries.filter((entry) => within(entry.path, name));
      this.authorizeSubtree(moving, owner, next);
      if (next.entries.some((entry) => within(entry.path, target))) invalid('Path already exists.');
      const sourceVisibility = this.visibility(name, next);
      this.ensureParents(target, next);
      for (const entry of moving) {
        entry.path = `${target}${entry.path.slice(name.length)}`;
        entry.version = next.revision;
        entry.mtime = Date.now();
      }
      // Moving an inherited private subtree out of its parent must not accidentally publish it.
      source.visibility = sourceVisibility;
    }, beforePublish);
  }

  remove(value: string, expectedRevision: number, owner: boolean, beforePublish?: () => Promise<void>, publicationId?: string): Promise<PersistentSnapshot> {
    return this.mutate(expectedRevision, owner, (next) => {
      const name = normalizePath(value);
      this.authorize(name, owner, next);
      const removing = next.entries.filter((entry) => within(entry.path, name));
      if (!removing.length) missing();
      this.authorizeSubtree(removing, owner, next);
      next.entries = next.entries.filter((entry) => !within(entry.path, name));
    }, beforePublish, publicationId);
  }

  /** This API is owner-only; the authenticated server must check the caller before calling it. */
  setVisibility(value: string, visibility: 'public' | 'private', expectedRevision: number, beforePublish?: () => Promise<void>): Promise<PersistentSnapshot> {
    return this.mutate(expectedRevision, true, async (next) => {
      const name = normalizePath(value);
      if (visibility !== 'public' && visibility !== 'private') invalid('Invalid visibility.');
      const entry = next.entries.find((item) => item.path === name);
      if (!entry) missing();
      const previouslyPrivate = next.entries.filter((item) => within(item.path, name) && item.type === 'file' && item.path.endsWith('.ipynb') && this.visibility(item.path, next) === 'private');
      entry.visibility = visibility;
      entry.version = next.revision;
      entry.mtime = Date.now();
      if (visibility === 'public') for (const item of previouslyPrivate) {
        const notebook = JSON.parse((await this.readBlob(item)).toString('utf8')) as { cells?: { outputs?: unknown[]; execution_count?: number | null; metadata?: Record<string, unknown> }[]; metadata?: Record<string, unknown> };
        if (!Array.isArray(notebook.cells)) invalid('Cannot publish an invalid Private notebook.');
        const legacyEnvelope = !!notebook.metadata && hasLegacyNotebookMetadata(notebook.metadata);
        for (const cell of notebook.cells) { if (cell.outputs) cell.outputs = []; if ('execution_count' in cell) cell.execution_count = null; if (legacyEnvelope && cell.metadata) cell.metadata = cellUserMetadata(cell.metadata, true); }
        if (notebook.metadata) { notebook.metadata = legacyEnvelope ? notebookUserMetadata(notebook.metadata) : { ...notebook.metadata }; delete notebook.metadata.pair_crdt; delete notebook.metadata.widgets; }
        const bytes = Buffer.from(JSON.stringify(notebook)); item.blob = createHash('sha256').update(bytes).digest('hex');
        item.size = bytes.length; item.version = next.revision; item.mtime = Date.now(); await this.storeBlob(item.blob, bytes);
      }
    }, beforePublish);
  }

  private mutate(expectedRevision: number, owner: boolean, change: (next: Manifest) => void | Promise<void>, beforePublish?: () => Promise<void>, publicationId?: string): Promise<PersistentSnapshot> {
    return this.enqueue(async () => {
      const current = this.current();
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) {
        throw new PersistentStorageError('CONFLICT', 'Workspace changed; reload its current revision.');
      }
      await this.checkDirectories();
      if (publicationId !== undefined && !PUBLICATION_ID.test(publicationId)) invalid('Invalid result publication identity.');
      if (publicationId && this.hasPublication(publicationId)) return this.snapshot(owner);
      const next: Manifest = { format: 1, revision: current.revision + 1, entries: current.entries.map((entry) => ({ ...entry })),
        ...(current.publications ? { publications: [...current.publications] } : {}) };
      await change(next);
      if (publicationId) (next.publications ??= []).push(publicationId);
      this.validateEntries(next);
      // Validate CAS, paths and ACLs before retiring kernels, while committing
      // the privacy barrier before the new file manifest becomes visible.
      await beforePublish?.();
      await this.publish(next);
      this.manifest = next;
      await this.collectGarbage();
      return this.snapshot(owner);
    });
  }

  private enqueue<T>(callback: () => Promise<T>): Promise<T> {
    const operation = this.pending.then(callback);
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private current(): Manifest {
    if (!this.manifest) throw new Error('Persistent workspace is not initialized.');
    return this.manifest;
  }

  private visibility(name: string, manifest: Manifest): 'public' | 'private' {
    let privatePaths = this.privatePaths.get(manifest);
    if (!privatePaths) {
      privatePaths = new Set(manifest.entries.filter((entry) => entry.visibility === 'private').map((entry) => entry.path));
      // Published manifests are immutable; mutation candidates must never cache a stale ACL.
      if (manifest === this.manifest) this.privatePaths.set(manifest, privatePaths);
    }
    if (!privatePaths.size) return 'public';
    let parent = name;
    for (;;) {
      if (privatePaths.has(parent)) return 'private';
      const separator = parent.lastIndexOf('/');
      if (separator < 0) return 'public';
      parent = parent.slice(0, separator);
    }
  }

  private authorize(name: string, owner: boolean, manifest: Manifest): void {
    // Matching the missing-file response does not disclose private paths to direct API probes.
    if (!owner && this.visibility(name, manifest) === 'private') missing();
  }

  private authorizeSubtree(entries: StoredEntry[], owner: boolean, manifest: Manifest): void {
    if (!owner && entries.some((entry) => this.visibility(entry.path, manifest) === 'private')) {
      throw new PersistentStorageError('FORBIDDEN', 'This path cannot be changed.');
    }
  }

  private ensureParents(name: string, manifest: Manifest): void {
    const segments = name.split('/');
    for (let index = 1; index < segments.length; index++) {
      const parent = segments.slice(0, index).join('/');
      const existing = manifest.entries.find((entry) => entry.path === parent);
      if (existing && existing.type !== 'directory') invalid('Parent path is not a directory.');
      if (!existing) manifest.entries.push({ path: parent, type: 'directory', size: 0, mtime: Date.now(), version: manifest.revision });
    }
  }

  private validateManifest(value: unknown): Manifest {
    if (!value || typeof value !== 'object') corrupt();
    const candidate = value as Record<string, unknown>;
    if (candidate.format !== 1 || !Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 0
      || !Array.isArray(candidate.entries) || candidate.entries.length > this.limits.maxEntries) corrupt();
    const entries: StoredEntry[] = [];
    for (const raw of candidate.entries as unknown[]) {
      if (!raw || typeof raw !== 'object') corrupt();
      const entry = raw as Record<string, unknown>;
      if (typeof entry.path !== 'string' || (entry.type !== 'file' && entry.type !== 'directory')
        || !Number.isSafeInteger(entry.size) || (entry.size as number) < 0
        || !Number.isSafeInteger(entry.mtime) || (entry.mtime as number) < 0
        || !Number.isSafeInteger(entry.version) || (entry.version as number) < 0 || (entry.version as number) > (candidate.revision as number)
        || (entry.visibility !== undefined && entry.visibility !== 'public' && entry.visibility !== 'private')
        || (entry.notebookIdentity !== undefined && (typeof entry.notebookIdentity !== 'string' || !/^[a-f0-9]{32}$/.test(entry.notebookIdentity)))
        || (entry.type === 'file' && (typeof entry.blob !== 'string' || !BLOB_NAME.test(entry.blob)))
        || (entry.type === 'directory' && (entry.size !== 0 || entry.blob !== undefined))) corrupt();
      entries.push({ path: entry.path, type: entry.type, size: entry.size as number,
        mtime: entry.mtime as number, version: entry.version as number,
        ...(entry.visibility ? { visibility: entry.visibility as 'public' | 'private' } : {}),
        ...(entry.type === 'file' ? { blob: entry.blob as string } : {}),
        ...(entry.notebookIdentity ? { notebookIdentity: entry.notebookIdentity as string } : {}) });
    }
    if (candidate.publications !== undefined && (!Array.isArray(candidate.publications) || candidate.publications.length > 16384
      || candidate.publications.some((id: unknown) => typeof id !== 'string' || !PUBLICATION_ID.test(id))
      || new Set(candidate.publications).size !== candidate.publications.length)) corrupt();
    const manifest: Manifest = { format: 1, revision: candidate.revision as number, entries,
      ...(candidate.publications ? { publications: candidate.publications as string[] } : {}) };
    try { this.validateEntries(manifest); } catch { corrupt(); }
    return manifest;
  }

  private validateEntries(manifest: Manifest): void {
    if (manifest.entries.length > this.limits.maxEntries) quota();
    if ((manifest.publications?.length ?? 0) > 16384) quota();
    let totalBytes = 0;
    const names = new Map<string, StoredEntry>();
    const portableNames = new Set<string>();
    for (const entry of manifest.entries) {
      const name = normalizePath(entry.path);
      const key = portablePathComparisonKey(name);
      if (portableNames.has(key)) invalid('Paths must be unique on all supported platforms.');
      portableNames.add(key);
      names.set(name, entry);
      if (entry.size > this.limits.maxFileBytes) quota();
      totalBytes += entry.size;
    }
    if (totalBytes > this.limits.maxProjectBytes) quota();
    for (const entry of manifest.entries) {
      const segments = entry.path.split('/');
      for (let index = 1; index < segments.length; index++) {
        if (names.get(segments.slice(0, index).join('/'))?.type !== 'directory') invalid('Missing parent directory.');
      }
    }
  }

  private async checkDirectories(): Promise<void> {
    await assertDirectoryChain(this.root);
    await assertDirectoryChain(this.blobDirectory);
    try { await assertRegularFile(this.manifestPath); } catch (error) {
      if (!hasCode(error, 'ENOENT') || this.manifest) throw error;
    }
    try { await assertRegularFile(this.markerPath); } catch (error) {
      if (!hasCode(error, 'ENOENT') || this.manifest) throw error;
    }
  }

  private async readBlob(entry: StoredEntry): Promise<Buffer> {
    if (!entry.blob || !BLOB_NAME.test(entry.blob)) corrupt();
    let bytes: Buffer;
    try { bytes = await readRegularFile(path.join(this.blobDirectory, entry.blob), this.limits.maxFileBytes); }
    catch { corrupt(); }
    if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.blob) corrupt();
    return bytes;
  }

  private async storeBlob(name: string, bytes: Buffer): Promise<void> {
    const destination = path.join(this.blobDirectory, name);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await syncDirectory(this.blobDirectory); return;
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error;
        // A previous attempt may have written all bytes but failed its fsync.
        const existing = await readRegularFile(destination, this.limits.maxFileBytes, true);
        if (existing.equals(bytes)) { await syncDirectory(this.blobDirectory); return; }
        // Only an unreferenced regular orphan can be repaired. Never conceal
        // corruption of a published blob or replace a symlink/hardlink.
        if (this.current().entries.some((entry) => entry.blob === name)) corrupt();
        await unlink(destination); await syncDirectory(this.blobDirectory);
      }
    }
    corrupt();
  }

  private async publish(manifest: Manifest): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(manifest));
    if (bytes.length > MAX_MANIFEST_BYTES) quota();
    const temporary = path.join(this.root, `.manifest-${randomBytes(16).toString('hex')}.tmp`);
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try {
      await moveFile(temporary, this.manifestPath);
      // Keep the running process consistent even if the subsequent directory sync fails.
      if (this.manifest) this.manifest = manifest;
      await syncDirectory(this.root);
    } finally {
      await unlink(temporary).catch((error: unknown) => { if (!hasCode(error, 'ENOENT')) throw error; });
    }
  }

  private async collectGarbage(manifest = this.current()): Promise<void> {
    const referenced = new Set(manifest.entries.map((entry) => entry.blob).filter(Boolean));
    let removed = false;
    for (const name of await readdir(this.blobDirectory)) {
      if (!BLOB_NAME.test(name)) corrupt();
      const filename = path.join(this.blobDirectory, name);
      await assertRegularFile(filename);
      if (!referenced.has(name)) { await unlink(filename); removed = true; }
    }
    if (removed) await syncDirectory(this.blobDirectory);
  }
}

async function hashRegularFile(filename: string, maximum: number): Promise<string> {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat(); if (!info.isFile() || info.nlink !== 1 || info.size > maximum) corrupt();
    const hash = createHash('sha256'); const buffer = Buffer.alloc(1024 * 1024); let offset = 0;
    for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset); if (!bytesRead) break; offset += bytesRead; if (offset > maximum) quota(); hash.update(buffer.subarray(0, bytesRead)); }
    if (offset !== info.size) corrupt(); return hash.digest('hex');
  } finally { await handle.close(); }
}

function normalizePath(value: string): string {
  if (typeof value !== 'string') invalid('Invalid project path.');
  try {
    const normalized = safeRelativePath(value).split(path.sep).join('/');
    if (normalized !== value) invalid('Project paths must use canonical forward slashes.');
    return normalized;
  } catch { invalid('Unsafe project-relative path.'); }
}

function decodeContent(content: string, maximum: number): Buffer {
  if (typeof content !== 'string' || content.length > Math.ceil(maximum / 3) * 4) quota();
  if (content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
    throw new PersistentStorageError('INVALID_CONTENT', 'File content must be canonical base64.');
  }
  const bytes = Buffer.from(content, 'base64');
  if (bytes.toString('base64') !== content) throw new PersistentStorageError('INVALID_CONTENT', 'File content must be canonical base64.');
  if (bytes.length > maximum) quota();
  return bytes;
}

function within(name: string, parent: string): boolean { return name === parent || name.startsWith(`${parent}/`); }
function hasCode(error: unknown, code: string): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === code; }
function corrupt(): never { throw new PersistentStorageError('CORRUPT_STORAGE', 'Persistent workspace metadata or content is unsafe or corrupt.'); }
function invalid(message: string): never { throw new PersistentStorageError('INVALID_PATH', message); }
function missing(): never { throw new PersistentStorageError('NOT_FOUND', 'Project path not found.'); }
function quota(): never { throw new PersistentStorageError('QUOTA_EXCEEDED', 'Persistent workspace quota exceeded.'); }

async function assertDirectoryChain(directory: string, allowMissing = false): Promise<void> {
  let current = path.parse(directory).root;
  for (const segment of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) corrupt();
    } catch (error) {
      if (allowMissing && hasCode(error, 'ENOENT')) return;
      throw error;
    }
  }
}

async function assertRegularFile(filename: string): Promise<void> {
  const stat = await lstat(filename);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) corrupt();
}

async function readRegularFile(filename: string, maximum: number, synchronize = false): Promise<Buffer> {
  await assertRegularFile(filename);
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) corrupt();
    const bytes = await handle.readFile();
    if (bytes.length > maximum) corrupt();
    if (synchronize) await handle.sync();
    return bytes;
  } finally { await handle.close(); }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
