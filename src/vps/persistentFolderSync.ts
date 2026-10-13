import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../core/atomicFile';
import { safeJobPath } from './protocol';
import type { PersistentClient } from './persistentClient';
import type { PersistentSnapshot } from './persistentProtocol';
interface Entry { hash: string; type: 'file' | 'directory'; visibility?: 'public' | 'private' }
export interface FolderSyncState { format: 1; baseline: Record<string, Entry>; privateCandidates?: string[] }
export interface FolderSyncConflict { path: string; local?: Entry; remote?: Entry }
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const same = (left: Entry | undefined, right: Entry | undefined): boolean => left?.type === right?.type && left?.hash === right?.hash;
const excluded = (name: string): boolean => ['.git', '.pair-notebook-conflicts'].includes(name);

/** Durable three-way reconciliation. No baseline advances until both copies agree. */
export class PersistentFolderSync {
  private state: FolderSyncState = { format: 1, baseline: {} };
  private loaded = false;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: { localRoot: string; remoteRoot: string; journal: string; sessionId: string; client: PersistentClient;
    current: () => boolean; conflict: (conflict: FolderSyncConflict) => Promise<'local' | 'remote' | 'later'> }) {
    if (!safeJobPath(options.remoteRoot) || path.resolve(options.localRoot) === path.parse(path.resolve(options.localRoot)).root) throw new Error('Select a dedicated project folder.');
  }
  private current(): void { if (!this.options.current()) throw new Error('Folder synchronization connection changed.'); }
  private remotePath(name: string): string { return `${this.options.remoteRoot}/${name}`; }
  private async safeLocal(name: string): Promise<string> {
    if (name && !safeJobPath(name)) throw new Error('Invalid local sync path.');
    const root = path.resolve(this.options.localRoot); const parts = root.split(path.sep); let directory = path.parse(root).root;
    for (const part of parts.filter(Boolean)) { directory = path.join(directory, part); const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Linked sync roots are forbidden.'); }
    for (const part of name.split('/').slice(0, -1)) {
      directory = path.join(directory, part);
      try { const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Linked sync directories are forbidden.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(directory, { mode: 0o700 }); }
    }
    const target = path.join(root, name);
    try { const info = await lstat(target); if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) throw new Error('Linked sync entries are forbidden.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return target;
  }
  private async bytes(name: string): Promise<Buffer> {
    const handle = await open(await this.safeLocal(name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const info = await handle.stat(); if (!info.isFile() || info.nlink !== 1 || info.size > 8 * 1024 * 1024) throw new Error('Unsafe or oversized sync file.'); const bytes = await handle.readFile(); if (bytes.length > 8 * 1024 * 1024) throw new Error('Sync file grew beyond limit.'); return bytes; }
    finally { await handle.close(); }
  }
  private async local(): Promise<Record<string, Entry>> {
    await this.safeLocal(''); const entries: Record<string, Entry> = {}; let total = 0;
    const scan = async (name: string): Promise<void> => {
      for (const entry of await readdir(path.join(this.options.localRoot, name), { withFileTypes: true })) {
        if (excluded(entry.name)) continue;
        const relative = name ? `${name}/${entry.name}` : entry.name;
        if (!safeJobPath(relative) || entry.isSymbolicLink()) throw new Error('Unsafe sync path.');
        await this.safeLocal(relative);
        if (Object.keys(entries).length >= 4096) throw new Error('Sync entry limit reached.');
        if (entry.isDirectory()) { entries[relative] = { type: 'directory', hash: '' }; await scan(relative); }
        else if (entry.isFile()) { const bytes = await this.bytes(relative); total += bytes.length; if (total > 128 * 1024 * 1024) throw new Error('Sync folder quota exceeded.'); entries[relative] = { type: 'file', hash: digest(bytes) }; }
        else throw new Error('Only regular files and directories can synchronize.');
      }
    }; await scan(''); return entries;
  }
  private async remote(): Promise<{ entries: Record<string, Entry>; contents: Record<string, string>; revision: number }> {
    this.current(); const snapshot = await this.options.client.call<PersistentSnapshot>('snapshot', { sessionId: this.options.sessionId }); this.current();
    const entries: Record<string, Entry> = {}; const contents: Record<string, string> = {};
    for (const entry of snapshot.entries) {
      if (!entry.path.startsWith(`${this.options.remoteRoot}/`)) continue;
      const name = entry.path.slice(this.options.remoteRoot.length + 1);
      if (!safeJobPath(name) || name.split('/').some(excluded)) continue;
      if (entry.type === 'directory') entries[name] = { type: 'directory', hash: '', visibility: entry.visibility };
      else {
        const file = await this.options.client.call<{ content: string; revision: number }>('read', { sessionId: this.options.sessionId, path: entry.path }); this.current();
        if (file.revision !== snapshot.revision) throw new Error('Server changed while reading sync snapshot; retrying next cycle.');
        contents[name] = file.content; entries[name] = { type: 'file', hash: digest(Buffer.from(file.content, 'base64')), visibility: entry.visibility };
      }
    }
    return { entries, contents, revision: snapshot.revision };
  }
  cycle(): Promise<void> {
    const work = this.pending.catch(() => undefined).then(() => this.reconcile()); this.pending = work; return work;
  }
  private async reconcile(): Promise<void> {
    this.current();
    if (!this.loaded) {
      try { const value = JSON.parse(await readFile(this.options.journal, 'utf8')) as FolderSyncState; if (value.format !== 1 || !value.baseline || Object.keys(value.baseline).some((name) => !safeJobPath(name)) || (value.privateCandidates !== undefined && (!Array.isArray(value.privateCandidates) || value.privateCandidates.length > 4096 || value.privateCandidates.some((name) => !safeJobPath(name))))) throw new Error('Invalid sync recovery journal.'); this.state = value; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      this.loaded = true;
    }
    let local = await this.local(); let remote = await this.remote();
    const signature = (entries: Record<string, Entry>, prefix: string): string => JSON.stringify(Object.entries(entries)
      .filter(([name]) => name === prefix || name.startsWith(`${prefix}/`)).map(([name, entry]) => [name.slice(prefix.length), entry.type, entry.hash]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    for (const [oldName, base] of Object.entries(this.state.baseline)) {
      if (base.type !== 'directory' || local[oldName] || signature(this.state.baseline, oldName) !== signature(remote.entries, oldName)) continue;
      const candidates = Object.keys(local).filter((name) => local[name]?.type === 'directory' && !this.state.baseline[name] && !remote.entries[name]
        && signature(local, name) === signature(this.state.baseline, oldName));
      if (candidates.length !== 1) continue;
      const newName = candidates[0]!;
      this.current(); await this.options.client.call('rename', { sessionId: this.options.sessionId, path: this.remotePath(oldName), newPath: this.remotePath(newName), expectedRevision: remote.revision }); this.current();
      remote = await this.remote();
      for (const name of Object.keys(this.state.baseline)) if (name === oldName || name.startsWith(`${oldName}/`)) {
        const target = newName + name.slice(oldName.length); if (remote.entries[target]) this.state.baseline[target] = remote.entries[target]!; delete this.state.baseline[name];
      }
      await this.save();
    }
    // Detect unique file renames before creates/deletes; the server preserves ACLs.
    for (const [oldName, base] of Object.entries(this.state.baseline)) {
      if (base.type !== 'file' || local[oldName] || !same(base, remote.entries[oldName])) continue;
      const candidates = Object.keys(local).filter((name) => !this.state.baseline[name] && !remote.entries[name] && same(local[name], base));
      if (candidates.length !== 1) continue;
      const newName = candidates[0]!;
      this.current(); await this.options.client.call('rename', { sessionId: this.options.sessionId, path: this.remotePath(oldName), newPath: this.remotePath(newName), expectedRevision: remote.revision }); this.current();
      remote = await this.remote();
      this.state.baseline[newName] = remote.entries[newName]!; delete this.state.baseline[oldName]; await this.save();
    }
    const names = [...new Set([...Object.keys(local), ...Object.keys(remote.entries), ...Object.keys(this.state.baseline), ...(this.state.privateCandidates ?? [])])].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    // Rename+edit may defeat hash matching. Preserve Private lineage durably
    // before any old-path deletion, including retries after a lost ACK.
    if (Object.entries(this.state.baseline).some(([name, entry]) => entry.visibility === 'private' && !local[name])) {
      this.state.privateCandidates = [...new Set([...(this.state.privateCandidates ?? []), ...Object.keys(local).filter((name) => !this.state.baseline[name] && !remote.entries[name])])];
      await this.save();
    }
    for (const name of names) {
      this.current(); local = await this.local(); remote = await this.remote();
      const left = local[name]; const right = remote.entries[name]; const base = this.state.baseline[name];
      if (same(left, right)) { this.state.privateCandidates = this.state.privateCandidates?.filter((candidate) => candidate !== name) ?? []; if (right) this.state.baseline[name] = right; else delete this.state.baseline[name]; await this.save(); continue; }
      const localChanged = !same(left, base); const remoteChanged = !same(right, base);
      let direction: 'local' | 'remote' | 'later' = localChanged && remoteChanged ? 'later' : localChanged ? 'local' : 'remote';
      if (localChanged && remoteChanged) direction = await this.options.conflict({ path: name, ...(left ? { local: left } : {}), ...(right ? { remote: right } : {}) });
      this.current(); if (direction === 'later') continue;
      const latestSnapshot = await this.options.client.call<PersistentSnapshot>('snapshot', { sessionId: this.options.sessionId }); this.current();
      if (latestSnapshot.revision !== remote.revision) throw new Error('Server changed during conflict resolution; neither copy was overwritten.');
      if (direction === 'local') {
        if (!left) {
          if (!right) continue;
          if (right.type === 'directory' && Object.keys(remote.entries).some((child) => child.startsWith(`${name}/`))) continue;
          await this.options.client.call('remove', { sessionId: this.options.sessionId, path: this.remotePath(name), expectedRevision: remote.revision });
        } else if (left.type === 'directory') {
          if (right) continue;
          await this.options.client.call('mkdir', { sessionId: this.options.sessionId, path: this.remotePath(name), expectedRevision: remote.revision, ...(this.state.privateCandidates?.includes(name) ? { visibility: 'private' } : {}) });
        } else {
          const bytes = await this.bytes(name); if (digest(bytes) !== left.hash) throw new Error('Local file changed before upload.');
          await this.options.client.call('write', { sessionId: this.options.sessionId, path: this.remotePath(name), content: bytes.toString('base64'), expectedRevision: remote.revision, ...(this.state.privateCandidates?.includes(name) ? { visibility: 'private' } : {}) });
        }
      } else {
        const target = await this.safeLocal(name); const latest = (await this.local())[name]; if (!same(latest, left)) throw new Error('Local file changed before download.'); this.current();
        if (!right) { if (left?.type === 'file') await unlink(target); else if (left?.type === 'directory') await rmdir(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOTEMPTY') throw error; }); }
        else if (right.type === 'directory') { if (!left) await mkdir(target, { mode: 0o700 }); }
        else { if (left?.type === 'directory') throw new Error('File/directory conflict requires a manual rename.'); await atomicWriteFile(target, Buffer.from(remote.contents[name]!, 'base64')); }
      }
      this.current(); const afterLocal = await this.local(); const afterRemote = await this.remote();
      if (same(afterLocal[name], afterRemote.entries[name])) { if (afterRemote.entries[name]) this.state.baseline[name] = afterRemote.entries[name]!; else delete this.state.baseline[name]; await this.save(); }
    }
  }
  private async save(): Promise<void> { this.current(); this.state.privateCandidates = this.state.privateCandidates?.filter((candidate) => !this.state.baseline[candidate]) ?? []; await mkdir(path.dirname(this.options.journal), { recursive: true, mode: 0o700 }); await atomicWriteFile(this.options.journal, JSON.stringify(this.state)); }
}
