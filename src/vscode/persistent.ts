import { SESSION_NOTEBOOK_TYPE } from './sessionNotebook';
import { presentAcceptedRun, type AcceptedRunReference } from './acceptedRun';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ServerSessionView } from './serverSessionView';
import * as vscode from 'vscode';
import type { PairNotebookController } from './jupyterController';
import { participantColor } from '../core/lineComments';
import type { JupyterKernelEvent } from '../core/pythonKernel';
import { PersistentClient, PersistentHttpError } from '../vps/persistentClient';
import { isPermanentConnectionError } from '../vps/compatibility';
import { mergePersistentNotebookOutputs } from '../vps/persistentNotebookMerge';
import type { PersistentDevice, PersistentExecution, PersistentMembership, PersistentSessionView, PersistentSnapshot, PersistentTarget } from '../vps/persistentProtocol';
import { normalizeVpsUrl, safeJobPath } from '../vps/protocol';
import { PersistentFolderSync } from '../vps/persistentFolderSync';
import { PersistentNotebookSynchronizer } from './persistentNotebookSync';
import { PersistentNotebookRecovery } from './persistentNotebookRecovery';
import { PersistentTextSynchronizer } from './persistentTextSync';
import { renderNotebookCellState, type MirroredCellState } from './notebookCellStateRenderer';
import { applyJupyterEventToState, createJupyterRenderState } from './jupyterOutputState';
import { defaultPermissions, mayEdit } from '../core/permissions';
import type { LineComment } from '../core/lineComments';
import type { LineCommentBackend, CommentLocation } from './lineComments';
import { editParticipantPermissions } from './permissions';
import { PersistentAgentLauncher } from './persistentAgent';

const SCHEME = 'pair-vps';
const CONNECTIONS_KEY = 'pairNotebook.persistentConnections';
interface SavedConnection { endpoint: string; sessionId: string; memberId: string; name: string; role?: 'owner' | 'admin' | 'member'; autoConnect?: boolean }
interface ActiveConnection extends SavedConnection { client: PersistentClient }

function membershipKey(connection: SavedConnection): string {
  return `pairNotebook.persistentMembership.${createHash('sha256').update(JSON.stringify([connection.endpoint, connection.sessionId, connection.memberId])).digest('hex')}`;
}
function sessionPasswordKey(connection: Pick<SavedConnection, 'endpoint' | 'sessionId'>): string {
  return `pairNotebook.sessionPassword.${createHash('sha256').update(JSON.stringify([connection.endpoint, connection.sessionId])).digest('hex')}`;
}
function filePath(uri: vscode.Uri): string {
  const value = uri.path.replace(/^\//, '');
  if (value && !safeJobPath(value)) throw vscode.FileSystemError.NoPermissions('Invalid server project path.');
  return value;
}
function sameEntries(left: PersistentSnapshot, right: PersistentSnapshot): vscode.FileChangeEvent[] {
  const previous = new Map(left.entries.map((entry) => [entry.path, entry]));
  const changes: vscode.FileChangeEvent[] = [];
  for (const entry of right.entries) {
    const before = previous.get(entry.path);
    if (!before || before.version !== entry.version || before.visibility !== entry.visibility) {
      changes.push({ type: before ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri: vscode.Uri.from({ scheme: SCHEME, path: `/${entry.path}` }) });
    }
    previous.delete(entry.path);
  }
  for (const key of previous.keys()) changes.push({ type: vscode.FileChangeType.Deleted, uri: vscode.Uri.from({ scheme: SCHEME, path: `/${key}` }) });
  return changes;
}

/** Server authoritative files. Stale saves fail and leave the editor's dirty changes intact. */
export class PersistentFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  public notebookRecovery: PersistentNotebookRecovery | undefined;
  public detachNotebook: ((uri: vscode.Uri) => Promise<boolean>) | undefined;
  private async localNotebook(uri: vscode.Uri): Promise<boolean> {
    if (!this.notebookRecovery || uri.scheme !== SCHEME || !uri.path.endsWith('.ipynb')) return false;
    const saved = await this.notebookRecovery.has(uri);
    const detached = await this.detachNotebook?.(uri);
    return saved || detached === true;
  }
  public restore: ((uri: vscode.Uri) => Promise<void>) | undefined;
  public canEdit: ((key: string) => boolean) | undefined;
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  public readonly onDidChangeFile = this.changed.event;
  private snapshot: PersistentSnapshot = { revision: 0, entries: [] };
  private readonly readRevisions = new Map<string, number>();
  private readonly readContents = new Map<string, Buffer>();
  private readonly notebookStats = new Map<string, vscode.FileStat>();
  private statsSession: string | undefined;
  public constructor(private readonly savedStats?: Pick<vscode.Memento, 'get' | 'update'>) {}
  // VS Code restores dirty models with their last save stamp. CRDT publications
  // can advance the server mtime while the extension host is stopped.
  private async persistStats(): Promise<void> {
    if (this.statsSession) await this.savedStats?.update(this.statsSession, Object.fromEntries(this.notebookStats));
  }
  private readonly generations = new Map<string, number>();
  public notebookManaged: ((uri: vscode.Uri) => boolean) | undefined;
  public notebookEpoch: ((uri: vscode.Uri) => string | undefined) | undefined;
  public textManaged: ((uri: vscode.Uri) => boolean) | undefined;
  public removed: ((uri: vscode.Uri) => void) | undefined;
  public created: ((uri: vscode.Uri) => void) | undefined;
  public readonlyFiles = true;
  private connection: ActiveConnection | undefined;
  private mutation = Promise.resolve();
  public setConnection(connection: ActiveConnection | undefined): void {
    this.connection = connection;
    this.snapshot = { revision: 0, entries: [] };
    this.readRevisions.clear();
    this.readContents.clear();
    const statsSession = connection ? `pairNotebook.fileStats:${connection.endpoint}:${connection.sessionId}` : undefined;
    if (statsSession && statsSession !== this.statsSession) {
      this.notebookStats.clear(); this.statsSession = statsSession;
      for (const [key, stat] of Object.entries(this.savedStats?.get<Record<string, vscode.FileStat>>(statsSession, {}) ?? {})) this.notebookStats.set(key, stat);
    }
  }
  public get revision(): number { return this.snapshot.revision; }
  public visibilityOf(key: string): 'public' | 'private' | undefined { return this.snapshot.entries.find((entry) => entry.path === key)?.visibility; }
  public uri(key = ''): vscode.Uri { return vscode.Uri.from({ scheme: SCHEME, authority: this.requireConnection().sessionId, path: `/${key}` }); }
  private requireConnection(): ActiveConnection {
    if (!this.connection) throw vscode.FileSystemError.Unavailable('Connect to a server project first.');
    return this.connection;
  }
  private check(uri: vscode.Uri): string {
    if (uri.authority !== this.requireConnection().sessionId) throw vscode.FileSystemError.NoPermissions('This file belongs to another session.');
    return filePath(uri);
  }
  public accept(snapshot: PersistentSnapshot): void {
    if (snapshot.revision < this.snapshot.revision) return;
    const events = sameEntries(this.snapshot, snapshot).map((event) => ({ ...event, uri: this.uri(filePath(event.uri)) }))
      .filter((event) => event.type !== vscode.FileChangeType.Changed || (!this.notebookManaged?.(event.uri) && !this.textManaged?.(event.uri)));
    this.snapshot = snapshot;
    for (const event of events) if (event.type === vscode.FileChangeType.Deleted) {
      const key = filePath(event.uri); this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
      this.readRevisions.delete(key); this.readContents.delete(key);
      if (!this.notebookManaged?.(event.uri) && !this.textManaged?.(event.uri)) this.notebookStats.delete(key);
      this.removed?.(event.uri);
    }
    for (const event of events) if (event.type === vscode.FileChangeType.Created) this.created?.(event.uri);
    if (events.length) this.changed.fire(events);
  }
  public async refresh(): Promise<void> {
    const connection = this.requireConnection();
    const snapshot = await connection.client.call<PersistentSnapshot>('snapshot', { sessionId: connection.sessionId });
    if (connection === this.connection) this.accept(snapshot);
  }
  public watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }
  public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    if (await this.notebookRecovery?.has(uri)) { await this.localNotebook(uri); return this.notebookRecovery!.stat(uri); }
    if (!this.connection) {
      try { await this.restore?.(uri); }
      catch (error) { if (!await this.localNotebook(uri)) throw error; }
    }
    if (await this.localNotebook(uri)) return this.notebookRecovery!.stat(uri);
    const key = this.check(uri);
    if (!key) return { type: vscode.FileType.Directory, ctime: 0, mtime: this.snapshot.revision, size: 0 };
    await this.refresh();
    const entry = this.snapshot.entries.find((candidate) => candidate.path === key);
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
    const current: vscode.FileStat = { type: entry.type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File, ctime: entry.mtime, mtime: entry.mtime, size: entry.size };
    if (this.notebookManaged?.(uri) || this.textManaged?.(uri) || (key.endsWith('.ipynb') && this.notebookStats.has(key))) {
      if (!this.notebookStats.has(key)) { this.notebookStats.set(key, current); await this.persistStats(); }
      return { ...this.notebookStats.get(key)!, ...(this.readonlyFiles || this.canEdit?.(key) === false ? { permissions: vscode.FilePermission.Readonly } : {}) };
    }
    return { ...current, ...(this.readonlyFiles || this.canEdit?.(key) === false ? { permissions: vscode.FilePermission.Readonly } : {}) };
  }
  public async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    if (!this.connection) await this.restore?.(uri);
    const key = this.check(uri);
    await this.refresh();
    const prefix = key ? `${key}/` : '';
    return this.snapshot.entries.filter((entry) => entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes('/'))
      .map((entry): [string, vscode.FileType] => [entry.path.slice(prefix.length), entry.type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File]);
  }
  public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const startedConnection = this.connection;
    const startedGeneration = this.generations.get(filePath(uri));
    if (await this.notebookRecovery?.has(uri)) { await this.localNotebook(uri); return this.notebookRecovery!.read(uri); }
    if (!this.connection) {
      try { await this.restore?.(uri); }
      catch (error) { if (!await this.localNotebook(uri)) throw error; }
    }
    if (await this.localNotebook(uri)) return this.notebookRecovery!.read(uri);
    const key = this.check(uri);
    const connection = this.requireConnection();
    if (startedConnection && startedConnection !== connection) throw vscode.FileSystemError.Unavailable('The persistent session changed during the read.');
    if (startedConnection && startedGeneration !== this.generations.get(key)) throw vscode.FileSystemError.Unavailable('The file was deleted or replaced during the read.');
    const generation = this.generations.get(key);
    const response = await connection.client.call<{ content: string; revision: number }>('read', { sessionId: connection.sessionId, path: key });
    if (connection !== this.connection) throw vscode.FileSystemError.Unavailable('The persistent session changed during the read.');
    if (generation !== this.generations.get(key)) throw vscode.FileSystemError.Unavailable('The file was deleted or replaced during the read.');
    // A second read may be a comparison view while the original editor stays dirty.
    // Only reopening or a successful save establishes a new editing baseline.
    const content = Buffer.from(response.content, 'base64');
    if (!this.readRevisions.has(key)) {
      this.readRevisions.set(key, response.revision);
      this.readContents.set(key, content);
      const entry = this.snapshot.entries.find((candidate) => candidate.path === key);
      if (entry && !this.notebookStats.has(key)) { this.notebookStats.set(key, { type: vscode.FileType.File, ctime: entry.mtime, mtime: entry.mtime, size: entry.size }); await this.persistStats(); }
    }
    return content;
  }
  private mutate(operation: string, input: Record<string, unknown>): Promise<void> {
    const connection = this.requireConnection();
    const key = String(input.path); const generation = this.generations.get(key);
    const baseline = this.readContents.get(key);
    const epoch = operation === 'remove' && key.endsWith('.ipynb') ? this.notebookEpoch?.(this.uri(key)) : undefined;
    const work = this.mutation.then(async () => {
      if (connection !== this.connection) throw vscode.FileSystemError.Unavailable('The persistent session changed.');
      if (generation !== this.generations.get(key)) throw vscode.FileSystemError.Unavailable('The file was deleted or replaced before saving.');
      if (this.canEdit?.(String(input.path)) === false) throw vscode.FileSystemError.NoPermissions('This server file is read only.');
      try {
        let request: Record<string, unknown> = { sessionId: connection.sessionId, expectedRevision: this.snapshot.revision, ...input };
        let snapshot: PersistentSnapshot;
        try { snapshot = await connection.client.call<PersistentSnapshot>(operation, request); }
        catch (error) {
          if (!(error instanceof PersistentHttpError) || error.status !== 409) throw error;
          if (operation === 'remove' && epoch) {
            let removed: PersistentSnapshot | undefined;
            for (let attempt = 0; attempt < 3; attempt++) {
              const current = await connection.client.call<{ content: string; revision: number }>('read', { sessionId: connection.sessionId, path: key });
              if (connection !== this.connection || generation !== this.generations.get(key)) throw error;
              const notebook = JSON.parse(Buffer.from(current.content, 'base64').toString('utf8'));
              if (notebook.metadata?.pair_crdt?.epoch !== epoch) throw error;
              try { removed = await connection.client.call<PersistentSnapshot>(operation, { ...request, expectedRevision: current.revision }); break; }
              catch (retryError) { if (!(retryError instanceof PersistentHttpError) || retryError.status !== 409 || attempt === 2) throw retryError; }
            }
            if (!removed) throw error;
            snapshot = removed;
          } else {
            if (operation !== 'write' || typeof input.path !== 'string' || typeof input.content !== 'string') throw error;
            if (!baseline) throw error;
            const response = await connection.client.call<{ content: string; revision: number }>('read', { sessionId: connection.sessionId, path: input.path });
            if (connection !== this.connection) throw vscode.FileSystemError.Unavailable('The persistent session changed during the save.');
            if (generation !== this.generations.get(key)) throw vscode.FileSystemError.Unavailable('The file was deleted or replaced during the save.');
            const latest = Buffer.from(response.content, 'base64');
            const desired = Buffer.from(input.content, 'base64');
            const merged = latest.equals(baseline) ? desired : input.path.endsWith('.ipynb') ? mergePersistentNotebookOutputs(baseline, desired, latest) : undefined;
            if (!merged) throw error;
            request = { ...request, expectedRevision: response.revision, content: Buffer.from(merged).toString('base64') };
            // Exactly one CAS retry. A concurrent edit after this read still fails.
            snapshot = await connection.client.call<PersistentSnapshot>(operation, request);
          }
        }
        if (connection !== this.connection) throw vscode.FileSystemError.Unavailable('The persistent session changed during the save.');
        if (operation === 'write' && generation !== this.generations.get(key)) throw vscode.FileSystemError.Unavailable('The file was deleted or replaced during the save.');
        this.accept(snapshot);
        if (operation === 'write' && typeof input.path === 'string' && 'content' in request && typeof request.content === 'string') {
          this.readRevisions.set(input.path, snapshot.revision);
          this.readContents.set(input.path, Buffer.from(request.content, 'base64'));
        }
      } catch (error) {
        if (error instanceof PersistentHttpError && error.status === 409) {
          throw vscode.FileSystemError.Unavailable('Save conflict: the server changed. Your edit remains dirty; compare with the server version before saving.');
        }
        throw error;
      }
    });
    this.mutation = work.catch(() => undefined);
    return work;
  }
  public notebookSave: ((uri: vscode.Uri) => Promise<boolean>) | undefined;
  public textSave: ((uri: vscode.Uri) => Promise<boolean>) | undefined;
  public async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }, replaceNotebook = false): Promise<void> {
    if (!replaceNotebook && await this.localNotebook(uri)) { await this.notebookRecovery!.save(uri, content); return; }
    const key = this.check(uri);
    const entry = this.snapshot.entries.find((candidate) => candidate.path === key);
    if (!options.create && !entry) throw vscode.FileSystemError.FileNotFound(uri);
    if (!options.overwrite && entry) throw vscode.FileSystemError.FileExists(uri);
    if (entry && !key.endsWith('.ipynb') && await this.textSave?.(uri)) {
      const stat = this.notebookStats.get(key); if (stat) { this.notebookStats.set(key, { ...stat, size: content.length }); await this.persistStats(); } return;
    }
    let notebookSaved = false;
    if (!replaceNotebook && key.endsWith('.ipynb')) {
      try { notebookSaved = await this.notebookSave?.(uri) === true; }
      catch (error) {
        if (!await this.localNotebook(uri)) throw error;
        await this.notebookRecovery!.save(uri, content); return;
      }
    }
    if (notebookSaved) {
      if (await this.notebookRecovery?.has(uri)) { await this.notebookRecovery!.save(uri, content); return; }
      const stat = this.notebookStats.get(key); if (stat) { this.notebookStats.set(key, { ...stat, size: content.length }); await this.persistStats(); }
      return;
    }
    if (entry && key.endsWith('.ipynb') && !replaceNotebook) {
      throw vscode.FileSystemError.NoPermissions('Save conflict: Overwrite cannot replace a server notebook from another editor or a local file. Preserve a local copy and open the current server notebook in Pair Notebook.');
    }
    await this.mutate('write', { path: key, content: Buffer.from(content).toString('base64'), expectedRevision: this.readRevisions.get(key) ?? this.snapshot.revision });
  }
  public async createDirectory(uri: vscode.Uri): Promise<void> { await this.mutate('mkdir', { path: this.check(uri) }); }
  public async createPrivateDirectory(uri: vscode.Uri): Promise<void> { await this.mutate('mkdir', { path: this.check(uri), visibility: 'private' }); }
  public async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    const key = this.check(uri);
    if (!options.recursive && this.snapshot.entries.some((entry) => entry.path.startsWith(`${key}/`))) throw vscode.FileSystemError.NoPermissions('The folder is not empty.');
    await this.mutate('remove', { path: key });
  }
  public async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    if (options.overwrite && this.snapshot.entries.some((entry) => entry.path === this.check(newUri))) throw vscode.FileSystemError.FileExists(newUri);
    await this.mutate('rename', { path: this.check(oldUri), newPath: this.check(newUri) });
  }
  public async setVisibility(uri: vscode.Uri, visibility: 'public' | 'private'): Promise<void> {
    await this.mutate('visibility', { path: this.check(uri), visibility });
  }
  public async release(uri: vscode.Uri): Promise<void> {
    if (uri.scheme === SCHEME && uri.authority === this.connection?.sessionId) {
      this.readRevisions.delete(filePath(uri));
      this.readContents.delete(filePath(uri));
      this.notebookStats.delete(filePath(uri));
      await this.persistStats();
    }
  }
  public dispose(): void { this.changed.dispose(); }
}

class PersistentItem extends vscode.TreeItem {
  public constructor(label: string, command?: string, description?: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    if (command) this.command = { command, title: label };
    if (description !== undefined) this.description = description;
  }
}

/** UI for independent, durable Server authority; does not start or transfer a P2P host. */
export class PersistentSessionController implements vscode.TreeDataProvider<PersistentItem>, vscode.Disposable {
  public get connected(): boolean { return !!this.connection; }
  private readonly changed = new vscode.EventEmitter<PersistentItem | undefined>();
  public readonly onDidChangeTreeData = this.changed.event;
  private readonly files: PersistentFileSystem;
  private readonly executionChanges = new Map<string, number>();
  private readonly executionWaiters = new Map<string, Set<() => void>>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly notebookSource: vscode.NotebookController | PairNotebookController;
  private get notebook(): vscode.NotebookController {
    return 'controller' in this.notebookSource ? this.notebookSource.controller : this.notebookSource;
  }
  private readonly notebookSync: PersistentNotebookSynchronizer;
  private readonly textSync: PersistentTextSynchronizer;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 79);
  private connection: ActiveConnection | undefined;
  private view: PersistentSessionView | undefined;
  private comments: LineComment[] = [];
  private commentsRevision: number | undefined;
  public canEdit(key: string): boolean {
    const view = this.view;
    return !!view && (view.memberId === view.ownerId || mayEdit(view.members.find((member) => member.id === view.memberId)?.permissions ?? defaultPermissions(), key));
  }
  public commentBackend(document: vscode.TextDocument): LineCommentBackend | undefined {
    const connection = this.connection;
    if (!connection) return undefined;
    const cell = vscode.workspace.notebookDocuments.flatMap((notebook) => notebook.getCells()).find((cell) => cell.document === document && cell.notebook.uri.scheme === SCHEME && cell.notebook.uri.authority === connection.sessionId);
    const uri = cell?.notebook.uri ?? document.uri;
    if (uri.scheme !== SCHEME || uri.authority !== connection.sessionId) return undefined;
    const locate = (): CommentLocation | undefined => {
      const cellId = cell ? this.notebookSync.commentCellId(cell) : undefined;
      return cell && !cellId ? undefined : { path: filePath(uri), ...(cellId ? { cellId } : {}) };
    };
    return { localId: connection.memberId, location: () => locate(), comments: () => this.comments,
      anchors: async (_location, start, end) => cell ? this.notebookSync.commentAnchors(cell, start, end) : this.textSync.commentAnchors(document, start, end),
      resolve: (comment) => comment.cellId ? this.notebookSync.resolveComment(comment) : this.textSync.resolveComment(comment),
      change: async (input) => {
        await this.rpcFor(connection, typeof input === 'string' ? 'removeComment' : 'addComment', typeof input === 'string' ? { commentId: input } : { comment: input });
        const reply = await this.rpcFor<{ comments: LineComment[] }>(connection, 'comments'); this.assertConnection(connection); this.comments = reply.comments;
      } };
  }
  public async managePermissions(): Promise<void> {
    const connection = this.requireConnection(); await this.poll(); this.assertConnection(connection);
    const view = this.view; if (!view || view.memberId !== view.ownerId) throw new Error('Only the server project owner can change participant permissions.');
    const target = await vscode.window.showQuickPick(view.members.filter((member) => member.id !== view.ownerId).map((member) => ({ label: member.name, description: member.online ? 'В сети' : 'Не в сети', member })), { title: 'Права участника Server' });
    if (!target) return;
    const snapshot = await this.rpcFor<PersistentSnapshot>(connection, 'snapshot');
    const permissions = await editParticipantPermissions(target.member.name, target.member.permissions ?? defaultPermissions(), snapshot.entries.map((entry) => ({ path: entry.path, directory: entry.type === 'directory' })), false);
    if (!permissions) return;
    await this.rpcFor(connection, 'permissions', { memberId: target.member.id, permissions }); await this.poll();
  }
  private polling = false;
  private folderSync: PersistentFolderSync | undefined;
  private disposed = false;
  private connectionAttempt = 0;
  private fileRegistration: vscode.Disposable | undefined;
  private readonly connectionWarnings = new Set<string>();
  private credentialWrites: Promise<void> = Promise.resolve();
  private readonly promptedConsents = new Set<string>();
  private readonly executions = new Map<string, AcceptedRunReference>();
  private readonly notebookQueues = new Map<vscode.NotebookDocument, Promise<void>>();
  private readonly notebookOpenings = new Map<string, Promise<void>>();
  private readonly currentNotebookUris = new Map<string, vscode.Uri>();
  private readonly recovery: PersistentNotebookRecovery;
  private recoveryNoticeShown = false;
  private readonly cancellationGenerations = new Map<string, number>();
  private readonly localRunning = new WeakSet<vscode.NotebookCell>();
  private readonly mirroredRuns = new Map<string, Promise<void>>();
  private readonly cellMirrors = new Map<vscode.NotebookCell, MirroredCellState>();
  private readonly managedRuns = new WeakMap<vscode.NotebookCell, PersistentExecution>();
  private readonly selectedNotebooks = new Set<vscode.NotebookDocument>();
  private agent: PersistentAgentLauncher | undefined;
  private readonly latestExecutions = new Map<string, { connection: ActiveConnection; execution: PersistentExecution }>();

  public constructor(private readonly context: vscode.ExtensionContext, private readonly log: vscode.OutputChannel, notebook: vscode.NotebookController | PairNotebookController,
    private readonly sessionChanged: (view: ServerSessionView | undefined, endpoint?: string, connected?: boolean) => void = () => undefined,
    private readonly canAttach: () => boolean = () => true) {
    this.files = new PersistentFileSystem(context.workspaceState);
    this.recovery = new PersistentNotebookRecovery(path.join(context.globalStorageUri.fsPath, 'persistent-detached'));
    this.files.notebookRecovery = this.recovery;
    this.files.detachNotebook = async uri => {
      const document = vscode.workspace.notebookDocuments.find(notebook => !notebook.isClosed && notebook.uri.toString() === uri.toString());
      if (!document || this.connection?.sessionId === uri.authority && !this.notebookSync.isRetired(document) && !this.recovery.isDetached(uri)) return false;
      if (!await this.recovery.has(uri)) await this.recovery.preserve(document);
      await this.notebookSync.retire(document, 'disconnected');
      return true;
    };
    this.notebookSource = notebook;
    this.status.command = 'pairNotebook.manageVpsSession';
    if (vscode.window.onDidChangeActiveNotebookEditor) this.disposables.push(vscode.window.onDidChangeActiveNotebookEditor(editor => { this.updateUi(); if (editor) this.claim(editor.notebook); }));
    const timer = setInterval(() => { void this.poll(); }, 2_000);
    timer.unref();
    this.textSync = new PersistentTextSynchronizer(context, () => this.connection, log);
    this.textSync.canEdit = (key) => this.canEdit(key); this.files.canEdit = (key) => this.canEdit(key);
    this.notebookSync = new PersistentNotebookSynchronizer(context, () => this.connection, log, () => {
      void this.files.refresh().catch(() => undefined);
      void this.mirrorActiveExecutions().catch((error) => log.appendLine(`[debug] Live execution discovery: ${error instanceof Error ? error.message : 'Unavailable.'}`));
    }, (event) => { this.notifyExecution(event.id, event.execution); void this.mirrorExecution(event.id).catch((error) => log.appendLine(`[debug] Live execution mirror: ${error instanceof Error ? error.message : 'Unavailable.'}`)); }, {
      isManagingCellState: (cell) => this.managesCell(cell),
      renderRemoteCellState: async (cell, request) => { if (this.selectedNotebooks.has(cell.notebook) && !this.managesCell(cell)) await renderNotebookCellState(this.notebook, this.cellMirrors, cell, request); },
    });
    this.files.notebookManaged = (uri) => uri.scheme === SCHEME && uri.authority === this.connection?.sessionId && vscode.workspace.notebookDocuments.some((document) => !document.isClosed && document.uri.scheme === uri.scheme && document.uri.authority === uri.authority && document.uri.path === uri.path);
    this.notebookSync.canEdit = (key) => this.canEdit(key);
    this.files.notebookEpoch = (uri) => {
      const notebook = vscode.workspace.notebookDocuments.find(document => !this.notebookSync.isRetired(document) && document.uri.scheme === uri.scheme && document.uri.authority === uri.authority && document.uri.path === uri.path);
      return notebook ? this.notebookSync.epochOf(notebook) : undefined;
    };
    this.files.removed = (uri) => {
      for (const notebook of vscode.workspace.notebookDocuments) if (notebook.uri.scheme === uri.scheme && notebook.uri.authority === uri.authority && notebook.uri.path === uri.path) {
        void this.notebookSync.retire(notebook, 'deleted').catch(error => this.log.appendLine(`[error] Notebook recovery archive: ${String(error)}`));
      }
    };
    const reopenRetired = (uri: vscode.Uri): void => {
      const active = vscode.window.activeNotebookEditor?.notebook;
      if (active && active.uri.scheme === uri.scheme && active.uri.authority === uri.authority && active.uri.path === uri.path && this.notebookSync.isRetired(active)) {
        void this.openCurrentNotebook(uri).catch(error => this.log.appendLine(`[debug] Current notebook instance unavailable: ${String(error)}`));
      }
    };
    this.files.created = reopenRetired;
    this.notebookSync.onRetired = async (notebook, reason) => {
      await this.recovery.preserve(notebook);
      this.log.appendLine(`[info] Detached notebook saves locally to ${this.recovery.file(notebook.uri)}`);
      if (reason === 'disconnected' && !this.recoveryNoticeShown) {
        this.recoveryNoticeShown = true;
        void vscode.window.showInformationMessage('Disconnected notebook tabs now save to local recovery and can be closed normally. These saves do not change the server project.');
      }
      if (reason !== 'disconnected') reopenRetired(notebook.uri);
    };
    this.notebookSync.fileEvent = (event) => this.textSync.receive(event);
    this.files.textManaged = (uri) => this.textSync.manages(uri);
    this.files.textSave = async (uri) => { if (!this.textSync.manages(uri)) return false; await this.textSync.flushAll(); await this.files.refresh(); return true; };
    this.files.notebookSave = async (uri) => {
      const document = vscode.workspace.notebookDocuments.find((notebook) => notebook.uri.toString() === uri.toString());
      if (!document) return false;
      this.notebookSync.assertAvailable(document);
      if (document.notebookType !== SESSION_NOTEBOOK_TYPE) {
        await this.notebookSync.retire(document, 'foreign-editor');
        return true;
      }
      await this.notebookSync.flush(document, true); await this.files.refresh(); return true;
    };
    this.setFilesReadonly(true);
    this.disposables.push(this.notebookSync, this.textSync,
      this.notebookSource.onDidChangeSelectedNotebooks(({ notebook, selected }) => {
        if (selected) {
          this.selectedNotebooks.add(notebook);
          void this.notebookSync.flush(notebook).catch((error) => this.log.appendLine(`[error] Notebook restoration: ${error instanceof Error ? error.message : 'Unavailable.'}`));
          void this.mirrorActiveExecutions().catch((error) => this.log.appendLine(`[debug] Execution discovery: ${error instanceof Error ? error.message : 'Unavailable.'}`));
        } else this.selectedNotebooks.delete(notebook);
      }),
      new vscode.Disposable(() => this.fileRegistration?.dispose()),
      vscode.workspace.onDidOpenNotebookDocument((notebook) => this.claim(notebook)),
      vscode.workspace.onDidCloseNotebookDocument((notebook) => {
        if (!vscode.workspace.notebookDocuments.some(document => !document.isClosed && document.uri.scheme === notebook.uri.scheme && document.uri.authority === notebook.uri.authority && document.uri.path === notebook.uri.path)) void this.files.release(notebook.uri).catch(error => log.appendLine(`[error] Server file save stamp: ${String(error)}`));
      }),
      vscode.workspace.onDidCloseTextDocument((document) => { void this.files.release(document.uri).catch(error => log.appendLine(`[error] Server file save stamp: ${String(error)}`)); }),
      this.status, this.files, this.changed, new vscode.Disposable(() => clearInterval(timer)),
    );
    const commands: Record<string, (...args: never[]) => unknown> = {
      'pairNotebook.connectVps': () => this.connect(),
      'pairNotebook.configureVpsSessions': () => this.configure(),
      'pairNotebook.createVpsSession': () => this.create(),
      'pairNotebook.joinVpsSession': () => this.connect(),
      'pairNotebook.manageVpsSession': () => this.manage(),
      'pairNotebook.leaveVpsSession': () => this.leave(),
      'pairNotebook.uploadVpsFolder': () => this.upload(),
      'pairNotebook.selectVpsCompute': () => this.selectCompute(),
      'pairNotebook.shareVpsComputer': () => this.shareComputer(),
      'pairNotebook.recoverVpsExecution': () => this.recoverExecution(),
      'pairNotebook.restartVpsKernel': () => this.restartKernel(),
      'pairNotebook.copyVpsSessionPassword': () => this.copySessionPassword(),
      'pairNotebook.changeVpsSessionPassword': () => this.changeSessionPassword(),
      'pairNotebook.copyVpsInvitation': () => this.copyInvitation(),
      'pairNotebook.saveVpsFiles': () => this.saveFiles(),
      'pairNotebook.releaseVpsKernel': () => this.releaseKernel(),
      'pairNotebook.refreshVpsSession': () => this.refresh(),
      'pairNotebook.vpsFolderPublic': (uri: vscode.Uri) => this.visibility(uri, 'public'),
      'pairNotebook.vpsFolderPrivate': (uri: vscode.Uri) => this.visibility(uri, 'private'),
    };
    for (const [id, callback] of Object.entries(commands)) this.disposables.push(vscode.commands.registerCommand(id, async (...args: never[]) => {
      try { return await callback(...args); }
      catch (error) {
        if (isPermanentConnectionError(error)) { this.connectionProblem(error); return; }
        this.log.appendLine('[error] Server project command failed; see the VS Code notification.');
        void vscode.window.showErrorMessage(`Pair Notebook server: ${error instanceof Error ? error.message : 'Operation failed.'}`);
        return undefined;
      }
    }));
    let restoreAttempt = this.connectionAttempt;
    let restoreRetries = 0;
    let restoreApproved = false;
    let restoration: Promise<void> | undefined;
    let requestedUri: vscode.Uri | undefined;
    let restoreTimer: NodeJS.Timeout | undefined;
    this.disposables.push({ dispose: () => { if (restoreTimer) clearTimeout(restoreTimer); } });
    const restore = async (): Promise<void> => {
      if (!vscode.workspace.isTrusted || this.connection || this.disposed || restoreTimer || restoreAttempt !== this.connectionAttempt) return;
      const uri = requestedUri ?? vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === SCHEME)?.uri
        ?? vscode.workspace.notebookDocuments.find(notebook => notebook.uri.scheme === SCHEME)?.uri;
      if (!uri) return;
      const saved = this.context.globalState.get<SavedConnection[]>(CONNECTIONS_KEY, []).find((item) => item.sessionId === uri.authority);
      if (!saved || saved.autoConnect === false || vscode.workspace.getConfiguration('pairNotebook').get<string>('serverRestore', 'automatic') === 'manual') return;
      if (!restoreApproved && vscode.workspace.getConfiguration('pairNotebook').get<string>('serverRestore', 'automatic') === 'ask') {
        if (await vscode.window.showInformationMessage(`Reconnect to server project ${saved.name}?`, 'Reconnect') !== 'Reconnect') { restoreAttempt = -1; return; }
        restoreApproved = true;
      }
      const attempt = this.connectionAttempt;
      const token = await this.context.secrets.get(membershipKey(saved));
      if (!token || attempt !== this.connectionAttempt || this.connection || this.disposed) return;
      try { await this.attach(saved, token); }
      catch (error) {
        // Only retry this startup attachment. An explicit join/leave supersedes it.
        if (this.connection || this.disposed || this.connectionAttempt !== attempt + 1) return;
        if (isPermanentConnectionError(error)) { this.connectionProblem(error); return; }
        if (++restoreRetries >= 5) { this.connectionProblem(new Error('The saved server is unavailable. Use Connect to Server to retry. Your local editors and history are preserved.')); return; }
        restoreAttempt = this.connectionAttempt;
        this.log.appendLine(`[debug] Saved server project is unavailable; retrying its connection: ${error instanceof Error ? error.message : 'Connection failed.'}`);
        restoreTimer = setTimeout(() => { restoreTimer = undefined; void requestRestore().catch((failure) => this.connectionProblem(failure)); }, Math.min(30_000, 2000 * 2 ** (restoreRetries - 1))); restoreTimer.unref();
      }
    };
    // Adding the first folder restarts VS Code's extension host. Resume the explicit server project handoff.
    const requestRestore = (uri?: vscode.Uri): Promise<void> => {
      if (uri?.scheme === SCHEME) requestedUri = uri;
      return restoration ??= restore().finally(() => { restoration = undefined; });
    };
    this.files.restore = requestRestore;
    void requestRestore().catch((error) => this.connectionProblem(error));
    this.disposables.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { void requestRestore().catch((error) => this.connectionProblem(error)); }));
    this.disposables.push(vscode.workspace.onDidOpenNotebookDocument(notebook => { if (notebook.uri.scheme === SCHEME) void requestRestore().catch((error) => this.connectionProblem(error)); }));
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { void requestRestore().catch(error => this.connectionProblem(error)); }));
  }
  private setFilesReadonly(readonly: boolean): void {
    this.files.readonlyFiles = readonly;
    this.fileRegistration ??= vscode.workspace.registerFileSystemProvider(SCHEME, this.files, { isCaseSensitive: true });
  }
  private connectionProblem(error: unknown): void {
    const message = error instanceof Error ? error.message : 'The server project is unavailable.';
    if (this.connectionWarnings.has(message)) return;
    this.connectionWarnings.add(message);
    this.log.appendLine(`[error] Server connection suspended: ${message}`);
    const help = error instanceof PersistentHttpError && error.status === 426 ? 'Open Releases' : 'Saved Connections';
    void vscode.window.showWarningMessage(`Pair Notebook: ${message}`, help, 'Reconnect').then((action) => {
      if (action === 'Open Releases') void vscode.env.openExternal(vscode.Uri.parse('https://github.com/r7zex/jupyter_pair_ext/releases/latest'));
      if (action === 'Saved Connections') void this.configure().catch((failure) => this.connectionProblem(failure));
      if (action === 'Reconnect') void this.connect().catch((failure) => this.connectionProblem(failure));
    });
  }
  public getTreeItem(item: PersistentItem): vscode.TreeItem { return item; }
  private deviceUsage(device: PersistentDevice | undefined): string {
    const names = device?.usingMemberIds?.map((memberId) => this.view?.members.find((member) => member.id === memberId)?.name ?? 'member') ?? [];
    return names.length ? `In use by ${names.join(', ')}` : 'Idle';
  }
  public getChildren(): PersistentItem[] {
    if (!this.connection || !this.view) return [new PersistentItem('Connect to Server', 'pairNotebook.connectVps'), new PersistentItem('Create persistent session', 'pairNotebook.createVpsSession'), new PersistentItem('Join persistent session', 'pairNotebook.joinVpsSession')];
    const target = this.view.devices.find((device) => device.id === this.view!.target.deviceId);
    const member = this.view.members.find((member) => member.id === this.view!.memberId);
    return [
      new PersistentItem(this.view.name, 'pairNotebook.manageVpsSession', `${this.view.state} · ${member?.role ?? 'member'}`),
      new PersistentItem('Compute device', 'pairNotebook.selectVpsCompute', `${target?.name ?? this.view.target.deviceId} · ${this.view.target.gpuUuid ? 'GPU' : 'CPU'} · ${target?.online ? 'online' : 'offline'} · ${this.deviceUsage(target)}`),
      new PersistentItem('Upload files / folder', 'pairNotebook.uploadVpsFolder'),
      new PersistentItem('Share / stop sharing my computer', 'pairNotebook.shareVpsComputer'),
      new PersistentItem('Restart active notebook kernel', 'pairNotebook.restartVpsKernel'),
      new PersistentItem('Release active notebook kernel', 'pairNotebook.releaseVpsKernel'),
      new PersistentItem('Recover execution result', 'pairNotebook.recoverVpsExecution'),
      new PersistentItem('Leave session', 'pairNotebook.leaveVpsSession'),
      ...this.view.members.map((member) => new PersistentItem(member.name, undefined, `${member.role} · ${member.online ? 'online' : 'offline'}`)),
    ];
  }
  private requireConnection(): ActiveConnection {
    if (!this.connection) throw new Error('Connect to a server project first.');
    return this.connection;
  }
  private async rpc<T>(operation: string, input: Record<string, unknown> = {}): Promise<T> {
    const connection = this.requireConnection();
    return connection.client.call<T>(operation, { sessionId: connection.sessionId, ...input });
  }
  private assertConnection(connection: ActiveConnection): void {
    if (this.disposed || connection !== this.connection) throw new Error('The persistent session changed; this action was not continued.');
  }
  private async rpcFor<T>(connection: ActiveConnection, operation: string, input: Record<string, unknown> = {}): Promise<T> {
    this.assertConnection(connection);
    const result = await connection.client.call<T>(operation, { sessionId: connection.sessionId, ...input });
    this.assertConnection(connection);
    return result;
  }
  private async endpoint(): Promise<string | undefined> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before connecting to Server.');
    const value = await vscode.window.showInputBox({ title: 'Connect to Server', prompt: 'HTTPS address; participants only need the session password', value: this.context.globalState.get<string>('pairNotebook.persistentEndpoint', ''), ignoreFocusOut: true,
      validateInput: (value) => { try { normalizeVpsUrl(value); return undefined; } catch { return 'Use HTTPS with a valid certificate (HTTP is allowed only on loopback).'; } } });
    if (value === undefined) return undefined;
    const endpoint = normalizeVpsUrl(value);
    await this.context.globalState.update('pairNotebook.persistentEndpoint', endpoint);
    return endpoint;
  }
  public async connect(): Promise<void> {
    const saved = this.context.globalState.get<SavedConnection[]>(CONNECTIONS_KEY, []);
    const selection = await vscode.window.showQuickPick([
      { label: 'Join a persistent session', action: 'join' },
      { label: 'Join using an invitation link', action: 'invitation' },
      { label: 'Create a persistent session', action: 'create' },
      { label: 'Import existing owner / member credential', action: 'import' },
      ...saved.map((connection) => ({ label: `Connect: ${connection.name}`, description: `${connection.endpoint} · ${connection.role ?? 'saved identity'} · ${connection.memberId.slice(0, 8)}`, action: 'resume', connection })),
    ], { title: 'Server project sessions' });
    if (!selection) return;
    if (selection.action === 'join') await this.join();
    else if (selection.action === 'invitation') await this.joinInvitation();
    else if (selection.action === 'create') await this.create();
    else if (selection.action === 'import') await this.importCredential();
    else if ('connection' in selection) {
      const connection = selection.connection as SavedConnection;
      const token = await this.context.secrets.get(membershipKey(connection));
      if (!token) throw new Error('This saved identity has no credential. Join the session again.');
      await this.attach(connection, token);
    }
  }
  public async configure(): Promise<void> {
    if (this.connection) { await this.manage(); return; }
    const saved = this.context.globalState.get<SavedConnection[]>(CONNECTIONS_KEY, []);
    const selected = await vscode.window.showQuickPick([
      { label: 'Add server connection', action: 'add' },
      ...saved.map(connection => ({ label: connection.name, description: `${connection.endpoint} · ${connection.role ?? 'saved identity'} · ${connection.memberId.slice(0, 8)}`, action: 'saved', connection })),
    ], { title: 'Saved server connections' });
    if (!selected) return;
    if (selected.action === 'add' || !('connection' in selected)) { await this.connect(); return; }
    const connection = selected.connection;
    const action = await vscode.window.showQuickPick(['Connect', 'Forget connection'], { title: connection.name });
    if (action === 'Connect') {
      const token = await this.context.secrets.get(membershipKey(connection));
      if (!token) throw new Error('This saved identity has no credential. Join the session again.');
      await this.attach(connection, token);
    } else if (action === 'Forget connection') {
      if (this.connection && membershipKey(this.connection) === membershipKey(connection)) await this.leave();
      await this.context.globalState.update(CONNECTIONS_KEY, saved.filter(item => membershipKey(item) !== membershipKey(connection)));
      await this.context.secrets.delete(membershipKey(connection));
    }
  }
  private async importCredential(): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before connecting to Server.');
    const sources = await vscode.window.showOpenDialog({ title: 'Import an owner or member credential created on the Server', canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { JSON: ['json'] } });
    const source = sources?.[0];
    if (!source) return;
    if (source.scheme !== 'file') throw new Error('Select a local credential file.');
    const handle = await open(source.fsPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let value: unknown;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 4096) throw new Error('The credential must be a regular JSON file smaller than 4 KiB.');
      value = JSON.parse(await handle.readFile({ encoding: 'utf8' })) as unknown;
    } finally { await handle.close(); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid session credential file.');
    const raw = value as Record<string, unknown>;
    if (typeof raw.endpoint !== 'string' || typeof raw.token !== 'string' || typeof raw.sessionId !== 'string' || typeof raw.memberId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.sessionId) || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.memberId)) throw new Error('Invalid session credential fields.');
    const endpoint = normalizeVpsUrl(raw.endpoint);
    const view = await new PersistentClient(endpoint, { kind: 'membership', token: raw.token }).call<PersistentSessionView>('view', { sessionId: raw.sessionId });
    if (view.memberId !== raw.memberId || view.id !== raw.sessionId) throw new Error('The credential identity does not match the server session.');
    const name = view.members.find((member) => member.id === view.memberId)?.name ?? view.name;
    await this.attach({ endpoint, sessionId: view.id, memberId: view.memberId, name }, raw.token);
  }
  private async password(title: string): Promise<string | undefined> {
    return vscode.window.showInputBox({ title, password: true, ignoreFocusOut: true, prompt: 'Session password (at least 12 characters)', validateInput: (value) => value.length >= 12 ? undefined : 'Use at least 12 characters.' });
  }
  public async create(): Promise<void> {
    const endpoint = await this.endpoint();
    if (!endpoint) return;
    await new PersistentClient(endpoint, { kind: 'anonymous' }).checkCompatibility();
    const admin = await vscode.window.showInputBox({ title: 'Server administrator', prompt: 'Administrative Team token — kept separate from participant credentials', password: true, ignoreFocusOut: true,
      validateInput: (value) => /^[A-Za-z0-9_-]{32,256}$/.test(value) ? undefined : 'Enter your configured administrative token.' });
    if (admin === undefined) return;
    const name = await vscode.window.showInputBox({ title: 'Persistent session name', ignoreFocusOut: true, validateInput: (value) => value.trim() ? undefined : 'Enter a name.' });
    if (name === undefined) return;
    const memberName = await vscode.window.showInputBox({ title: 'Project owner name', value: vscode.workspace.getConfiguration('pairNotebook').get<string>('displayName', '') || os.userInfo().username, ignoreFocusOut: true, validateInput: (value) => value.trim() ? undefined : 'Enter your name.' });
    if (!memberName?.trim()) return;
    const password = await this.password('Set session password');
    if (password === undefined) return;
    const membership = await new PersistentClient(endpoint, { kind: 'admin', token: admin }).call<PersistentMembership>('create', { name: name.trim(), password, memberName: memberName.trim() });
    await this.context.secrets.store(sessionPasswordKey({ endpoint, sessionId: membership.sessionId }), password);
    await this.attach({ endpoint, ...membership }, membership.token);
  }
  public async join(): Promise<void> {
    const attempt = this.connectionAttempt;
    const endpoint = await this.endpoint();
    if (!endpoint) return;
    const password = await this.password('Join persistent session');
    if (password === undefined) return;
    const client = new PersistentClient(endpoint, { kind: 'anonymous' });
    const discovery = await client.call<{ sessions: { id: string; name: string }[] }>('discover', { password });
    const selected = discovery.sessions.length === 1 ? discovery.sessions[0] : await vscode.window.showQuickPick(discovery.sessions.map((session) => ({ label: session.name, description: session.id, ...session })), { title: 'Select a session' });
    if (!selected) return;
    const name = await vscode.window.showInputBox({ title: 'Participant name', value: vscode.workspace.getConfiguration('pairNotebook').get<string>('displayName', ''), ignoreFocusOut: true, validateInput: (value) => value.trim() ? undefined : 'Enter your name.' });
    if (name === undefined) return;
    if (attempt !== this.connectionAttempt || this.disposed) throw new Error('The persistent connection changed during join.');
    const membership = await client.call<PersistentMembership>('join', { sessionId: selected.id, name: name.trim(), password });
    if (attempt !== this.connectionAttempt || this.disposed) throw new Error('The persistent connection changed during join.');
    await this.context.secrets.store(sessionPasswordKey({ endpoint, sessionId: membership.sessionId }), password);
    await this.attach({ endpoint, ...membership }, membership.token);
  }
  private async joinInvitation(): Promise<void> {
    const attempt = this.connectionAttempt;
    const value = await vscode.window.showInputBox({ title: 'Join invitation', prompt: 'Paste the HTTPS invitation link', ignoreFocusOut: true });
    if (!value) return;
    const url = new URL(value); const match = /^#pair-invite=([A-Za-z0-9_-]{1,128})\.([A-Za-z0-9_-]{32,256})$/.exec(url.hash);
    if (!match) throw new Error('Invalid invitation link.');
    url.hash = ''; const endpoint = normalizeVpsUrl(url.toString());
    const name = await vscode.window.showInputBox({ title: 'Participant name', ignoreFocusOut: true });
    if (!name?.trim()) return;
    if (attempt !== this.connectionAttempt || this.disposed) throw new Error('The persistent connection changed during join.');
    const membership = await new PersistentClient(endpoint, { kind: 'anonymous' }).call<PersistentMembership>('acceptInvitation', { sessionId: match[1], invitationToken: match[2], name: name.trim() });
    if (attempt !== this.connectionAttempt || this.disposed) throw new Error('The persistent connection changed during join.');
    await this.attach({ endpoint, ...membership }, membership.token);
  }
  private async attach(saved: SavedConnection, token: string): Promise<void> {
    if (this.canAttach?.() === false) throw new Error('Leave the temporary session before connecting to a persistent session.');
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before connecting to Server.');
    const attempt = this.connectionAttempt = (this.connectionAttempt ?? 0) + 1;
    const current = (): void => {
      if (this.disposed || attempt !== this.connectionAttempt) throw new Error('The persistent connection changed during attachment.');
    };
    if (this.connection) await this.leave(true, false);
    const connection: ActiveConnection = { endpoint: saved.endpoint, sessionId: saved.sessionId, memberId: saved.memberId, name: saved.name, client: new PersistentClient(saved.endpoint, { kind: 'membership', token }) };
    let view: PersistentSessionView;
    try {
      await connection.client.checkCompatibility(); current();
      view = await connection.client.call<PersistentSessionView>('heartbeat', { sessionId: connection.sessionId });
      if (view.state !== 'running') throw new PersistentHttpError(404, 'The server project is stopped. Ask its owner to start it.');
    }
    catch (error) { connection.client.dispose(); throw error; }
    connection.name = view.name;
    connection.role = view.members.find(member => member.id === view.memberId)?.role ?? 'member';
    // Retain authorized owner/member credentials even if a newer attachment won.
    // Otherwise a successfully created owner session could become unrecoverable.
    const save = (this.credentialWrites ?? Promise.resolve()).then(async () => {
      await this.context.secrets.store(membershipKey(connection), token);
      const connections = this.context.globalState.get<SavedConnection[]>(CONNECTIONS_KEY, []).filter((item) => !(item.endpoint === connection.endpoint && item.sessionId === connection.sessionId && item.memberId === connection.memberId));
      const descriptor = { endpoint: connection.endpoint, sessionId: connection.sessionId, memberId: connection.memberId, name: connection.name, role: connection.role ?? 'member' as const, autoConnect: attempt === this.connectionAttempt };
      if (attempt === this.connectionAttempt) connections.unshift(descriptor); else connections.push(descriptor);
      await this.context.globalState.update(CONNECTIONS_KEY, connections.slice(0, 20));
    });
    this.credentialWrites = save.catch(() => undefined);
    await save; current();
    const initialSnapshot = await connection.client.call<PersistentSnapshot>('snapshot', { sessionId: connection.sessionId }); current();
    this.connection = connection;
    this.comments = []; this.commentsRevision = undefined;
    const folder = this.context.globalState.get<{ localRoot: string; remoteRoot: string }>(`pairNotebook.folderSync.${connection.sessionId}.${connection.memberId}`);
    if (folder && typeof folder.localRoot === 'string' && typeof folder.remoteRoot === 'string') this.folderSync = this.makeFolderSync(connection, folder.localRoot, folder.remoteRoot);
    this.view = view;
    this.files.setConnection(connection);
    this.files.accept(initialSnapshot);
    this.setFilesReadonly(false);
    current();
    await vscode.commands.executeCommand('setContext', 'pairNotebook.inVpsSession', true);
    current();
    await vscode.commands.executeCommand('setContext', 'pairNotebook.vpsOwner', view.memberId === view.ownerId);
    current();
    const root = this.files.uri();
    await vscode.workspace.fs.stat(root); current();
    if (!vscode.workspace.workspaceFolders?.some((folder) => folder.uri.toString() === root.toString())) {
      vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: root, name: `Server project: ${view.name}` });
    }
    try {
      for (const notebook of vscode.workspace.notebookDocuments) {
        if (notebook.uri.scheme === SCHEME && notebook.uri.authority === connection.sessionId && notebook.notebookType === SESSION_NOTEBOOK_TYPE) {
          try { await this.notebookSync.flush(notebook, notebook.isDirty); }
          catch (error) { if (isPermanentConnectionError(error, 'file')) throw error; this.log.appendLine(`[debug] Notebook restoration is isolated: ${String(error)}`); }
        }
        current(); this.claim(notebook);
      }
    } catch (error) { await this.leave(false, false); throw error; }
    this.updateUi();
    void vscode.window.showInformationMessage('Server project ready. Notebook edits and participant presence synchronize live. Closing VS Code leaves the server session running.');
  }
  private claim(notebook: vscode.NotebookDocument): void {
    if (this.recovery.isDetached(notebook.uri)) { void this.notebookSync.retire(notebook, 'disconnected').catch(error => this.log.appendLine(`[error] Detached notebook: ${String(error)}`)); return; }
    if (notebook.uri.scheme === SCHEME && notebook.uri.authority === this.connection?.sessionId) {
      const current = this.currentNotebookUris?.get(filePath(notebook.uri));
      if (this.notebookSync.isRetired(notebook) || (current && current.toString() !== notebook.uri.toString())) {
        void this.openCurrentNotebook(notebook.uri).catch(error => this.log.appendLine(`[debug] Current notebook instance unavailable: ${String(error)}`));
        return;
      }
      if ('claimNotebook' in this.notebookSource) this.notebookSource.claimNotebook(notebook);
      if (notebook.notebookType && notebook.notebookType !== SESSION_NOTEBOOK_TYPE) return;
      this.notebook.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
      const editor = vscode.window.activeNotebookEditor;
      if (!('claimNotebook' in this.notebookSource) && editor?.notebook === notebook) void vscode.commands.executeCommand('notebook.selectKernel', {
        id: this.notebook.id, extension: 'pair-notebook.pair-notebook', notebookEditor: editor,
      });
      void this.notebookSync?.flush(notebook, notebook.isDirty).then(() => this.mirrorActiveExecutions()).catch(() => undefined);
    }
  }
  private openCurrentNotebook(uri: vscode.Uri): Promise<void> {
    const key = `${uri.authority}/${filePath(uri)}`; const pending = this.notebookOpenings.get(key); if (pending) return pending;
    const connection = this.connection; if (!connection || uri.authority !== connection.sessionId) return Promise.resolve();
    const work = Promise.resolve().then(async () => {
      const reply = await connection.client.call<{ epoch: string }>('notebookSync', { sessionId: connection.sessionId, path: filePath(uri), bootstrapEmpty: true });
      if (this.disposed || connection !== this.connection) return;
      if (typeof reply.epoch !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(reply.epoch)) throw new Error('The server returned an invalid notebook epoch.');
      let current = uri.with({ query: `pairNotebookEpoch=${encodeURIComponent(reply.epoch)}` });
      const previous = this.currentNotebookUris.get(filePath(uri));
      if (await this.recovery?.has(current)) current = previous && new URLSearchParams(previous.query).get('pairNotebookEpoch') === reply.epoch && !await this.recovery.has(previous) ? previous : current.with({ query: `${current.query}&pairNotebookAttachment=${randomUUID()}` });
      if (this.disposed || connection !== this.connection) return;
      this.currentNotebookUris.set(filePath(uri), current);
      const existing = vscode.workspace.notebookDocuments.find(document => !document.isClosed && !this.notebookSync.isRetired(document) && document.uri.toString() === current.toString());
      if (existing) await vscode.window.showNotebookDocument(existing, { preview: false });
      else await vscode.commands.executeCommand('vscode.openWith', current, SESSION_NOTEBOOK_TYPE, { preview: false });
    });
    this.notebookOpenings.set(key, work);
    void work.finally(() => { if (this.notebookOpenings.get(key) === work) this.notebookOpenings.delete(key); }).catch(() => undefined);
    return work;
  }
  public async leave(notifyServer = true, cancelPending = true): Promise<void> {
    if (cancelPending) this.connectionAttempt = (this.connectionAttempt ?? 0) + 1;
    const connection = this.connection;
    if (cancelPending) {
      const roots = new Set(vscode.workspace.workspaceFolders?.filter(folder => folder.uri.scheme === SCHEME).map(folder => folder.uri.authority));
      const saved = this.context.globalState.get<SavedConnection[]>(CONNECTIONS_KEY, []);
      await this.context.globalState.update(CONNECTIONS_KEY, saved.map(item => (connection ? membershipKey(item) === membershipKey(connection) : roots.has(item.sessionId)) ? { ...item, autoConnect: false } : item));
    }
    if (!connection) return;
    await Promise.all([this.notebookSync?.checkpoint(), this.textSync?.checkpoint()]);
    await Promise.all(vscode.workspace.notebookDocuments.filter(notebook => !notebook.isClosed && notebook.uri.scheme === SCHEME && notebook.uri.authority === connection.sessionId)
      .map(notebook => this.notebookSync.retire(notebook, 'disconnected')));
    if (connection === this.connection) this.setFilesReadonly(true);
    // Deactivation never stops a session or cancels accepted runs.
    try { if (notifyServer) await connection.client.call('leave', { sessionId: connection.sessionId }); }
    finally {
      if (connection === this.connection) {
        this.folderSync = undefined;
        this.notebookSync?.reset();
        this.currentNotebookUris?.clear();
        this.textSync?.reset();
        this.selectedNotebooks?.clear();
        this.selectedNotebooks?.clear();
        this.connection = undefined; this.comments = []; this.commentsRevision = undefined;
        this.view = undefined; this.comments = []; this.commentsRevision = undefined;
        this.files.setConnection(undefined);
        this.status.hide();
        this.changed.fire(undefined);
        this.sessionChanged?.(undefined);
        await vscode.commands.executeCommand('setContext', 'pairNotebook.inVpsSession', false);
        await vscode.commands.executeCommand('setContext', 'pairNotebook.vpsOwner', false);
        const index = vscode.workspace.workspaceFolders?.findIndex((folder) => folder.uri.scheme === SCHEME && folder.uri.authority === connection.sessionId) ?? -1;
        if (index >= 0) vscode.workspace.updateWorkspaceFolders(index, 1);
      }
    }
  }
  private panelView(): ServerSessionView | undefined {
    if (!this.view) return undefined;
    const network = this.connection?.client.networkSnapshot?.();
    const view = { ...this.view, presenceColors: this.notebookSync.participantColors(), memberColors: Object.fromEntries(this.view.members.map(member => [member.id, participantColor(member.id)])), ...(network ? { network } : {}) };
    const notebook = vscode.window.activeNotebookEditor?.notebook;
    if (!notebook || !this.owns(notebook)) return view;
    const key = filePath(notebook.uri);
    const scope = this.files.visibilityOf(key) ?? 'public';
    const selected = this.view.devices.find(device => device.id === this.view!.target.deviceId);
    const deviceId = scope === 'private' && selected?.ownerId !== this.view.memberId ? 'vps' : this.view.target.deviceId;
    const member = this.view.members.find(item => item.id === this.view!.memberId);
    return { ...view, activeKernel: { notebook: key, scope, deviceId, ...(deviceId === this.view.target.deviceId && this.view.target.gpuUuid ? { gpuUuid: this.view.target.gpuUuid } : {}), canRestart: this.view.state === 'running' && (member?.id === this.view.ownerId || member?.permissions?.execute !== false) } };
  }
  public async saveFiles(): Promise<void> {
    const connection = this.requireConnection();
    for (const notebook of vscode.workspace.notebookDocuments.filter(document => this.owns(document))) {
      await this.notebookSync.flush(notebook, notebook.isDirty);
      if (notebook.isDirty) await notebook.save();
      this.assertConnection(connection);
    }
    for (const document of vscode.workspace.textDocuments.filter(document => document.uri.scheme === SCHEME && document.uri.authority === connection.sessionId && document.isDirty)) {
      await document.save(); this.assertConnection(connection);
    }
    void vscode.window.showInformationMessage('Server project files saved on the VPS.');
  }
  public async getSessionPassword(): Promise<string | undefined> {
    const connection = this.requireConnection();
    const key = sessionPasswordKey(connection);
    const password = await this.context.secrets.get(key);
    if (password) {
      const result = await new PersistentClient(connection.endpoint, { kind: 'anonymous' }).call<{ sessions: { id: string }[] }>('discover', { password });
      this.assertConnection(connection);
      if (result.sessions.some(session => session.id === connection.sessionId)) return password;
      await this.context.secrets.delete(key);
    }
    void vscode.window.showInformationMessage('No current session password is saved on this computer. The owner can change it under More actions > Session password.');
    return undefined;
  }
  public async copySessionPassword(): Promise<void> {
    const password = await this.getSessionPassword();
    if (password) await vscode.env.clipboard.writeText(password);
  }
  public async changeSessionPassword(): Promise<void> {
    const connection = this.requireConnection();
    const password = await this.password('Change session password');
    if (password === undefined) return;
    await this.rpcFor(connection, 'password', { password });
    await this.context.secrets.store(sessionPasswordKey(connection), password);
    this.updateUi();
  }
  public async copyInvitation(): Promise<void> {
    const connection = this.requireConnection();
    const invite = await this.rpcFor<{ sessionId: string; invitationToken: string }>(connection, 'createInvitation', { lifetimeSeconds: 86400, readOnly: false });
    this.assertConnection(connection);
    await vscode.env.clipboard.writeText(`${connection.endpoint}/#pair-invite=${invite.sessionId}.${invite.invitationToken}`);
    void vscode.window.showInformationMessage('Invitation copied. It expires in 24 hours.');
  }
  private updateUi(): void {
    if (!this.view) return;
    const target = this.view.devices.find((device) => device.id === this.view!.target.deviceId);
    this.status.text = `$(server) Server ${this.view.state} · ${target?.name ?? this.view.target.deviceId} ${this.view.target.gpuUuid ? 'GPU' : 'CPU'}`;
    this.status.tooltip = `Session ${this.view.id} · kernel generation ${this.view.generation} · ${target?.online ? 'online' : 'offline'} · continuous notebook and folder synchronization`;
    this.status.show();
    this.changed.fire(undefined);
    this.sessionChanged?.(this.panelView(), this.connection?.endpoint);
  }
  private async poll(): Promise<void> {
    if (this.polling || !this.connection || this.disposed) return;
    this.polling = true;
    const connection = this.connection;
    try {
      const view = await this.rpc<PersistentSessionView>('heartbeat');
      if (connection !== this.connection) return;
      const generation = this.view?.generation;
      this.view = view;
      if (view.collaborationRevision === undefined || this.commentsRevision !== view.collaborationRevision) {
        const comments = await this.rpcFor<{ comments: LineComment[] }>(connection, 'comments');
        this.assertConnection(connection); this.comments = comments.comments; this.commentsRevision = view.collaborationRevision;
      }
      await this.files.refresh();
      const synchronized = await Promise.allSettled((vscode.workspace.notebookDocuments ?? []).map((notebook) => this.notebookSync?.flush(notebook)));
      for (const result of synchronized) if (result.status === 'rejected') {
        if (isPermanentConnectionError(result.reason, 'file')) throw result.reason;
        this.log.appendLine(`[debug] Notebook will retry independently: ${result.reason instanceof Error ? result.reason.message : 'Unavailable.'}`);
      }
      try { await this.folderSync?.cycle(); }
      catch (error) { this.log.appendLine(`[debug] Folder synchronization will retry: ${error instanceof Error ? error.message : 'Unavailable.'}`); }
      this.updateUi();
      if (generation !== undefined && generation !== view.generation) void vscode.window.showInformationMessage('The next execution uses a new compute kernel. Python variables from the previous device do not migrate; accepted executions retain their original device.');
      for (const consent of view.consents) {
        const device = view.devices.find((device) => device.id === consent.deviceId);
        if (consent.status !== 'pending' || device?.ownerId !== view.memberId || this.promptedConsents.has(consent.id)) continue;
        this.promptedConsents.add(consent.id);
        const requester = view.members.find((member) => member.id === consent.requesterId)?.name ?? consent.requesterId;
        void Promise.resolve(vscode.window.showWarningMessage(`${requester} requests ${device.name} ${consent.gpuUuid ? 'GPU' : 'CPU'} in this session. Their Python code will run on your machine.`, 'Allow', 'Deny')).then(async (choice) => {
          if (connection === this.connection) await this.rpc('consent', { consentId: consent.id, approved: choice === 'Allow' });
        }).catch(() => { this.promptedConsents.delete(consent.id); });
      }
    } catch (error) {
      if (connection === this.connection) {
        if (isPermanentConnectionError(error)) { await this.leave(false); this.connectionProblem(error); return; }
        this.sessionChanged?.(this.panelView(), connection.endpoint, false);
        this.status.text = '$(warning) Server disconnected — reconnecting';
        this.status.tooltip = error instanceof Error ? error.message : 'Connection unavailable';
      }
    } finally { this.polling = false; }
  }
  public async refresh(): Promise<void> { await this.files.refresh(); await this.poll(); }
  public async visibility(uri: vscode.Uri | undefined, visibility: 'public' | 'private'): Promise<void> {
    if (!uri || uri.scheme !== SCHEME) throw new Error('Choose a folder in the server project.');
    await this.files.setVisibility(uri, visibility);
  }
  public async upload(): Promise<void> {
    const connection = this.requireConnection();
    const selection = await vscode.window.showQuickPick([{ label: 'Private — project owner only', description: 'Stored on this server; hidden from other participants. Available to the owner’s VPS kernel.', value: 'private' }, { label: 'Shared — project participants', description: 'Stored on this server; visible in the project Explorer and shared kernels, even while the owner is offline.', value: 'public' }], { title: `Upload from this computer to ${connection.name} — choose access` });
    if (!selection) return;
    const sources = await vscode.window.showOpenDialog({ title: `Choose a local file or folder to upload to ${connection.name}`, canSelectFiles: true, canSelectFolders: true, canSelectMany: false });
    const source = sources?.[0];
    if (!source) return;
    if (source.scheme === SCHEME) throw new Error('Select a local file or folder.');
    const sourceStat = await vscode.workspace.fs.stat(source);
    this.assertConnection(connection);
    const destination = await vscode.window.showInputBox({ title: 'Destination folder relative to the server project root', prompt: `Local ${path.basename(source.path)} → ${connection.name} on ${connection.endpoint}. Notebook paths are relative to their working directory.`, value: sourceStat.type & vscode.FileType.Directory ? path.basename(source.path) : 'data', ignoreFocusOut: true, validateInput: (value) => safeJobPath(value) ? undefined : 'Enter a safe relative project path.' });
    if (!destination) return;
    this.assertConnection(connection);
    await this.files.refresh();
    this.assertConnection(connection);
    const targetPath = sourceStat.type & vscode.FileType.Directory ? destination : `${destination}/${path.basename(source.path)}`;
    if (await vscode.window.showInformationMessage(`Upload ${source.fsPath} → ${connection.name} on ${connection.endpoint} → ${targetPath}? ${selection.value === 'private' ? 'Only the project owner can access this server folder.' : 'Project participants will have access after publication.'} Files remain on the server after leaving. This does not change the selected compute target.`, { modal: true }, 'Upload') !== 'Upload') return;
    this.assertConnection(connection);
    const existingVisibility = this.files.visibilityOf(destination);
    if (existingVisibility && existingVisibility !== selection.value) throw new Error('The destination has different access. Choose a new folder; uploading will not change access to existing files.');
    if (!existingVisibility) await this.files.createPrivateDirectory(this.files.uri(destination));
    let count = 0;
    let skipped = 0;
    const visit = async (uri: vscode.Uri, key: string): Promise<void> => {
      if (++count > 2_000) throw new Error('Upload exceeds 2,000 entries; split this folder into smaller uploads.');
      const stat = await vscode.workspace.fs.stat(uri);
      this.assertConnection(connection);
      if (stat.type & vscode.FileType.SymbolicLink) throw new Error('Symbolic links cannot be uploaded.');
      if (stat.type & vscode.FileType.Directory) {
        if (key !== destination) await this.files.createDirectory(this.files.uri(key));
        for (const [name] of await vscode.workspace.fs.readDirectory(uri)) await visit(vscode.Uri.joinPath(uri, name), `${key}/${name}`);
      } else {
        if (stat.size > 8 * 1024 * 1024) throw new Error('Individual upload files must be at most 8 MiB. Keep large datasets on the compute device.');
        const content = await vscode.workspace.fs.readFile(uri);
        this.assertConnection(connection);
        try { await this.files.writeFile(this.files.uri(key), content, { create: true, overwrite: false }); }
        catch (error) {
          if ((error as { code?: string }).code !== 'FileExists') throw error;
          if (this.files.visibilityOf(key) !== selection.value) throw new Error(`The existing file ${key} has different access. Upload with a different destination; its privacy was preserved.`);
          const choice = await vscode.window.showQuickPick([
            { label: 'Keep the existing file', description: `Skip ${key}`, action: 'skip' },
            { label: 'Upload with another name', description: key, action: 'rename' },
            { label: 'Replace this file', description: `Replace only ${key} in this upload`, action: 'replace' },
          ], { title: `File already exists: ${key}` });
          this.assertConnection(connection);
          if (!choice) throw new Error(`Upload stopped at ${key}; files already transferred remain in ${destination}.`);
          if (choice.action === 'skip') { skipped++; return; }
          let targetKey = key;
          if (choice.action === 'rename') {
            const name = await vscode.window.showInputBox({ title: `New file name in ${path.posix.dirname(key)}`, value: path.posix.basename(key),
              validateInput: value => safeJobPath(value) && !value.includes('/') ? undefined : 'Enter one safe file name.' });
            this.assertConnection(connection);
            if (!name) throw new Error(`Upload stopped at ${key}; files already transferred remain in ${destination}.`);
            targetKey = `${path.posix.dirname(key)}/${name}`;
          }
          await this.files.refresh(); this.assertConnection(connection);
          const targetVisibility = this.files.visibilityOf(targetKey);
          if (targetVisibility && targetVisibility !== selection.value) throw new Error(`The destination ${targetKey} has different access; its privacy was preserved.`);
          await this.files.writeFile(this.files.uri(targetKey), content, { create: true, overwrite: choice.action === 'replace' }, choice.action === 'replace');
        }
      }
    };
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Uploading to ${connection.name}/${destination} on the server`, cancellable: false }, () => visit(source, targetPath));
    this.assertConnection(connection);
    if (selection.value === 'public' && !existingVisibility) await this.files.setVisibility(this.files.uri(destination), 'public');
    this.assertConnection(connection);
    const action = await vscode.window.showInformationMessage(`Processed ${count} entries (${skipped} existing files kept) in ${connection.name}/${targetPath} (${selection.value === 'private' ? 'Private: owner only' : 'Shared'}). Use paths relative to the notebook’s working directory to read them.`, 'Show in Explorer');
    if (action === 'Show in Explorer') { this.assertConnection(connection); await vscode.commands.executeCommand('revealInExplorer', this.files.uri(targetPath)); }
  }
  private makeFolderSync(connection: ActiveConnection, localRoot: string, remoteRoot: string): PersistentFolderSync {
    return new PersistentFolderSync({ localRoot, remoteRoot, sessionId: connection.sessionId, client: connection.client,
      journal: path.join(this.context.globalStorageUri.fsPath, 'folder-sync', createHash('sha256').update(JSON.stringify([connection.endpoint, connection.sessionId, connection.memberId, localRoot, remoteRoot])).digest('hex') + '.json'),
      current: () => this.connection === connection && !!this.folderSync && !this.disposed,
      conflict: async ({ path: filename }) => {
        const answer = await vscode.window.showQuickPick([{ label: 'Keep both copies for now', value: 'later' as const }, { label: 'Use local copy', value: 'local' as const }, { label: 'Use server copy', value: 'remote' as const }], { title: `Folder sync conflict: ${filename}` });
        this.assertConnection(connection); return answer?.value ?? 'later';
      } });
  }
  private async synchronizeFolder(): Promise<void> {
    const connection = this.requireConnection();
    const selected = await vscode.window.showOpenDialog({ title: 'Choose a dedicated local folder for continuous two-way synchronization', canSelectFiles: false, canSelectFolders: true, canSelectMany: false });
    const uri = selected?.[0]; if (!uri || uri.scheme !== 'file') return;
    const remoteRoot = await vscode.window.showInputBox({ title: 'Server folder', prompt: 'Existing or new server folder. Conflicting edits require a choice.', ignoreFocusOut: true, validateInput: (value) => safeJobPath(value) ? undefined : 'Enter a relative folder path.' });
    if (!remoteRoot) return; this.assertConnection(connection);
    const snapshot = await this.rpcFor<PersistentSnapshot>(connection, 'snapshot');
    if (!snapshot.entries.some((entry) => entry.path === remoteRoot && entry.type === 'directory')) {
      const privacy = this.view?.memberId === this.view?.ownerId ? await vscode.window.showQuickPick([{ label: 'Private', visibility: 'private' as const }, { label: 'Public', visibility: 'public' as const }], { title: 'New folder visibility' }) : { visibility: 'public' as const };
      if (!privacy) return;
      await this.rpcFor(connection, 'mkdir', { path: remoteRoot, expectedRevision: snapshot.revision, ...(this.view?.memberId === this.view?.ownerId ? { visibility: privacy.visibility } : {}) });
    }
    this.assertConnection(connection);
    this.folderSync = this.makeFolderSync(connection, uri.fsPath, remoteRoot);
    await this.context.globalState.update(`pairNotebook.folderSync.${connection.sessionId}.${connection.memberId}`, { localRoot: uri.fsPath, remoteRoot });
    await this.folderSync.cycle();
  }
  public async selectCompute(): Promise<void> {
    const connection = this.requireConnection();
    await this.poll();
    this.assertConnection(connection);
    if (!this.view) throw new Error('Connect to a session first.');
    const choices: (vscode.QuickPickItem & { target: PersistentTarget })[] = [];
    for (const device of this.view.devices) {
      if (!device.online) continue;
      const owner = this.view.members.find((member) => member.id === device.ownerId)?.name ?? device.ownerId;
      const detail = `${device.python}; ${device.cpu}; owner ${owner}; ${device.isolation}; ${device.enabled ? 'sharing enabled' : 'sharing disabled'}; ${this.deviceUsage(device)}`;
      choices.push({ label: `${device.name} — CPU`, description: device.online ? 'online' : 'offline', detail, target: { deviceId: device.id } });
      for (const gpu of device.gpus) choices.push({ label: `${device.name} — ${gpu.name}`, description: `${gpu.memoryMb} MiB · ${device.online ? 'online' : 'offline'}`, detail, target: { deviceId: device.id, gpuUuid: gpu.uuid } });
    }
    const target = await vscode.window.showQuickPick(choices, { title: 'Select next execution device (server checks permissions and consent)' });
    if (!target || connection !== this.connection) return;
    const current = this.view.target.deviceId === target.target.deviceId && this.view.target.gpuUuid === target.target.gpuUuid;
    const action = current ? 'Request access' : 'Select device';
    const choice = await vscode.window.showWarningMessage(current
      ? 'Request permission to execute on the current device. The selected device and kernel stay unchanged.'
      : 'Changing device creates a different stateful kernel for later runs. Python objects do not migrate. Existing executions continue on their accepted device.', action);
    if (choice !== action || connection !== this.connection) return;
    const result = await this.rpc<PersistentSessionView>('select', { target: target.target });
    if (connection !== this.connection) return;
    this.view = result;
    const pending = result.consents.some((consent) => consent.status === 'pending' && consent.requesterId === result.memberId && consent.deviceId === target.target.deviceId && consent.gpuUuid === target.target.gpuUuid);
    void vscode.window.showInformationMessage(pending ? 'Consent requested. The current execution device stays active until approval.' : 'Execution device selected.');
    await this.poll();
  }
  public async shareComputer(): Promise<void> {
    const connection = this.requireConnection();
    await this.poll();
    this.assertConnection(connection);
    if (!this.view) throw new Error('Connect to a session first.');
    const own = this.view.devices.filter((device) => device.ownerId === this.view!.memberId);
    const action = await vscode.window.showQuickPick([
      { label: 'Prepare and share this computer', description: 'Install isolated Python/Jupyter; other participants need your consent', action: 'automatic' },
      { label: 'Advanced: export a compute credential', description: 'For an agent you install and run yourself; does not prepare or share this computer', action: 'setup' },
      ...own.map((device) => ({ label: `${device.enabled ? 'Stop' : 'Enable'} sharing ${device.name}`, action: 'toggle', device })),
      ...this.view.consents.filter((consent) => consent.status === 'approved' && own.some((device) => device.id === consent.deviceId)).map((consent) => ({ label: `Revoke consent: ${consent.requesterId} → ${consent.deviceId}`, action: 'revoke', consent })),
    ], { title: 'Your computer and session consent' });
    if (!action) return;
    this.assertConnection(connection);
    if (action.action === 'automatic') {
      if (await vscode.window.showInformationMessage('Prepare this computer to run session Python cells? On Windows, an Ubuntu/Debian WSL2 runtime is used. Python and Jupyter packages are installed in a managed Pair Notebook environment; project files remain in their existing project. Sharing makes this compute device available with your consent, not your entire disk. Stop sharing from this menu at any time. The current notebook target does not change automatically.', { modal: true }, 'Prepare and share') !== 'Prepare and share') return;
      this.assertConnection(connection);
      const token = await this.context.secrets.get(membershipKey(connection)); this.assertConnection(connection);
      if (!token) throw new Error('Reconnect to restore your member credential.');
      this.agent ??= new PersistentAgentLauncher(this.context, this.log);
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Preparing this computer: install Python/Jupyter, verify isolation, then enable sharing', cancellable: false }, () => this.agent!.start(connection, token, true));
        void vscode.window.showInformationMessage('This computer is prepared. Sharing starts after its readiness heartbeat. Select it from Compute when available; use Your computer to stop sharing.');
      } catch (error) {
        const action = await vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Compute setup failed.', 'Retry', 'Open output');
        if (action === 'Retry') await this.shareComputer();
        else if (action === 'Open output') this.log.show();
        return;
      }
    }
    else if (action.action === 'toggle' && 'device' in action) { const device = action.device; await this.rpcFor(connection, 'share', { deviceId: device.id, enabled: !device.enabled }); }
    else if (action.action === 'revoke' && 'consent' in action) await this.rpcFor(connection, 'revokeConsent', { consentId: action.consent.id });
    else {
      const accepted = await vscode.window.showWarningMessage('Your computer will execute session Python code in the selected isolated runtime. Other participants require your consent.', { modal: true }, 'Export agent credential');
      if (accepted !== 'Export agent credential') return;
      const destination = await vscode.window.showSaveDialog({ title: 'Save compute agent credential outside shared project folders', defaultUri: vscode.Uri.file(path.join(this.context.globalStorageUri.fsPath, 'persistent-agent.json')), filters: { JSON: ['json'] } });
      if (!destination) return;
      if (destination.scheme !== 'file') throw new Error('Save agent credentials to a local private file.');
      if (vscode.workspace.workspaceFolders?.some((folder) => folder.uri.scheme === 'file' && isWithin(folder.uri.fsPath, destination.fsPath))) {
        throw new Error('Save agent credentials outside every project workspace folder.');
      }
      this.assertConnection(connection);
      const token = await this.context.secrets.get(membershipKey(connection));
      this.assertConnection(connection);
      if (!token) throw new Error('Reconnect to restore your member credential.');
      await mkdir(path.dirname(destination.fsPath), { recursive: true, mode: 0o700 });
      const handle = await open(destination.fsPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(JSON.stringify({ endpoint: connection.endpoint, sessionId: connection.sessionId, memberId: connection.memberId, token }, null, 2));
        await handle.sync();
      } finally { await handle.close(); }
      void vscode.window.showInformationMessage('Credential exported. Linux uses your selected Linux Python with bubblewrap; Windows uses the WSL2 launcher; macOS uses an immutable Docker Desktop Linux image with Python inside it. Follow the agent setup in PERSISTENT_VPS.md and keep the credential outside synchronized folders. Readiness and CPU/CUDA are checked by the agent.');
    }
    await this.poll();
  }
  public async manage(): Promise<void> {
    if (!this.connection) { await this.connect(); return; }
    const connection = this.requireConnection();
    await this.poll();
    this.assertConnection(connection);
    if (!this.view) { await this.connect(); return; }
    const view = this.view;
    const member = view.members.find((member) => member.id === view.memberId);
    const owner = member?.role === 'owner';
    const admin = owner || member?.role === 'admin';
    const actions = [{ label: 'Leave session', action: 'leave' }, { label: 'Synchronize a local folder continuously', action: 'folderSync' }, { label: 'Stop local folder synchronization', action: 'stopFolderSync' }, { label: 'Copy session connection details', action: 'invite' }, { label: 'Choose compute device', action: 'compute' }];
    if (admin) actions.push({ label: 'Stop session', action: 'stop' }, { label: 'Start session', action: 'start' }, { label: 'Restart session', action: 'restart' }, { label: 'Delete session permanently', action: 'delete' });
    if (owner) actions.push({ label: 'Participant permissions', action: 'permissions' }, { label: 'Create expiring invitation', action: 'createInvitation' }, { label: 'Revoke invitation', action: 'revokeInvitation' }, { label: 'Revoke participant access', action: 'revoke' }, { label: view.allowMemberSwitch ? 'Disallow participant compute switching' : 'Allow participant compute switching', action: 'settings' }, { label: 'Change password', action: 'password' }, { label: 'Grant / revoke participant administration', action: 'role' });
    const action = await vscode.window.showQuickPick(actions, { title: `${view.name} · ${view.id}` });
    if (!action) return;
    this.assertConnection(connection);
    if (action.action === 'leave') { await this.leave(); return; }
    if (action.action === 'folderSync') { await this.synchronizeFolder(); return; }
    if (action.action === 'permissions') { await this.managePermissions(); return; }
    if (action.action === 'stopFolderSync') { this.folderSync = undefined; await this.context.globalState.update(`pairNotebook.folderSync.${connection.sessionId}.${connection.memberId}`, undefined); return; }
    if (action.action === 'invite') { await vscode.env.clipboard.writeText(`${connection.endpoint}\nSession ID: ${view.id}`); return; }
    if (action.action === 'compute') { await this.selectCompute(); return; }
    if (action.action === 'createInvitation') {
      const permission = await vscode.window.showQuickPick([{ label: 'Read only', readOnly: true }, { label: 'Edit and execute Public notebooks', readOnly: false }], { title: 'Invitation permissions · expires in 24 hours' });
      if (!permission) return;
      const invite = await this.rpcFor<{ sessionId: string; invitationToken: string }>(connection, 'createInvitation', { lifetimeSeconds: 86400, readOnly: permission.readOnly });
      this.assertConnection(connection);
      await vscode.env.clipboard.writeText(`${connection.endpoint}/#pair-invite=${invite.sessionId}.${invite.invitationToken}`);
      await vscode.window.showInformationMessage('Invitation copied. Access expires in 24 hours and can be revoked.'); return;
    }
    if (action.action === 'revokeInvitation') {
      const list = await this.rpcFor<{ invitations: { id: string; expiresAt: number; revoked: boolean; readOnly: boolean }[] }>(connection, 'invitations');
      const invite = await vscode.window.showQuickPick(list.invitations.filter((entry) => !entry.revoked).map((entry) => ({ label: entry.id, description: `${entry.readOnly ? 'Read only' : 'Edit'} · ${new Date(entry.expiresAt).toISOString()}`, invite: entry })), { title: 'Revoke invitation and its participant access' });
      if (invite) await this.rpcFor(connection, 'revokeInvitation', { invitationId: invite.invite.id }); return;
    }
    if (action.action === 'settings') await this.rpcFor(connection, 'settings', { allowMemberSwitch: !view.allowMemberSwitch });
    else if (action.action === 'password') {
      const password = await this.password('Change session password');
      if (password !== undefined) { await this.rpcFor(connection, 'password', { password }); await this.context.secrets.store(sessionPasswordKey(connection), password); }
    } else if (action.action === 'role' || action.action === 'revoke') {
      const target = await vscode.window.showQuickPick(view.members.filter((member) => member.role !== 'owner' && member.id !== view.memberId).map((member) => ({ label: member.name, description: member.role, member })), { title: 'Select participant' });
      if (!target) return;
      if (action.action === 'revoke') await this.rpcFor(connection, 'revoke', { memberId: target.member.id });
      else await this.rpcFor(connection, 'role', { memberId: target.member.id, role: target.member.role === 'admin' ? 'member' : 'admin' });
    } else {
      const confirmation = await vscode.window.showWarningMessage(`${action.label}? Accepted computations may still be running. Stop/restart affects future access and kernel lifecycle; deletion removes stored project data.`, { modal: true }, action.label);
      if (confirmation !== action.label) return;
      await this.rpcFor(connection, 'lifecycle', { action: action.action });
      this.assertConnection(connection);
      if (action.action === 'delete') { await this.leave(false); return; }
    }
    await this.poll();
  }
  private async kernel(uri: vscode.Uri, command: 'interrupt' | 'restart' | 'release'): Promise<void> {
    const connection = this.requireConnection();
    if (uri.scheme !== SCHEME || uri.authority !== connection.sessionId) throw new Error('Open a notebook in the connected server project first.');
    const key = filePath(uri);
    if (command === 'interrupt') this.cancellationGenerations?.set(key, (this.cancellationGenerations.get(key) ?? 0) + 1);
    const active = [...this.executions.values()].reverse().find((execution) => execution.notebook === key && execution.id);
    if (command === 'interrupt') await this.rpc('kernelControl', { notebook: key, ...(active?.id ? { executionId: active.id } : {}), command: { command } });
    else {
      const result = await this.rpc<PersistentExecution>('kernel', { notebook: key, command, requestId: randomUUID() });
      if (connection !== this.connection) throw new Error(`Kernel ${command} was accepted in the previous session. Recoverable execution ID: ${result.id}`);
      const completed = await this.observe(result);
      if (completed.state !== 'completed') throw new Error(completed.error ?? `Kernel ${command} ${completed.state}. Recoverable execution ID: ${completed.id}`);
    }
  }
  public async restartKernel(): Promise<void> {
    const uri = vscode.window.activeNotebookEditor?.notebook.uri;
    if (!uri) throw new Error('Open a Server notebook first.');
    const scope = this.files?.visibilityOf(filePath(uri)) === 'private' ? 'private (owner only)' : 'shared (everyone using this notebook)';
    if (await vscode.window.showWarningMessage(`Restart the ${scope} kernel for ${path.posix.basename(filePath(uri))}? Python variables will be cleared. Accepted computations finish first.`, { modal: true }, 'Restart kernel') === 'Restart kernel') {
      await this.kernel(uri, 'restart');
      void vscode.window.showInformationMessage('Notebook kernel restarted. Python variables were cleared; saved cell outputs remain.');
    }
  }
  public async releaseKernel(): Promise<void> {
    const uri = vscode.window.activeNotebookEditor?.notebook.uri;
    if (!uri) throw new Error('Open a Server notebook first.');
    if (await vscode.window.showWarningMessage('Release this notebook kernel to free compute memory? Its Python variables will be lost. Release waits for already accepted computations without interrupting them; the next execution starts a fresh kernel.', { modal: true }, 'Release kernel') === 'Release kernel') {
      await this.kernel(uri, 'release');
      void vscode.window.showInformationMessage('Notebook kernel released. Python variables were cleared; saved cell outputs remain.');
    }
  }
  public owns(notebook: vscode.NotebookDocument): boolean {
    return notebook.uri.scheme === SCHEME && notebook.uri.authority === this.connection?.sessionId && !this.recovery?.isDetached(notebook.uri) && !this.notebookSync?.isRetired?.(notebook);
  }
  public async interrupt(notebook: vscode.NotebookDocument): Promise<void> { await this.kernel(notebook.uri, 'interrupt'); }
  public async execute(cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument): Promise<void> {
    const connection = this.requireConnection();
    const key = filePath(notebook.uri);
    if (notebook.uri.scheme !== SCHEME || notebook.uri.authority !== connection.sessionId) throw new Error('This notebook is outside the connected Server project.');
    const requireOriginalSession = (): void => {
      if (this.disposed || connection !== this.connection) throw new Error('The persistent session changed; queued cells were not submitted.');
      this.notebookSync?.assertAvailable?.(notebook);
      if (notebook.isClosed) throw new Error('The notebook editor was closed; queued cells were not submitted.');
    };
    const previous = this.notebookQueues.get(notebook) ?? Promise.resolve();
    const cancellation = this.cancellationGenerations?.get(key) ?? 0;
    const queued = previous.catch(() => undefined).then(async () => {
      requireOriginalSession();
      for (const cell of cells) if (cell.kind === vscode.NotebookCellKind.Code && cell.document.languageId === 'python') {
        requireOriginalSession();
        if ((this.cancellationGenerations?.get(key) ?? 0) !== cancellation) break;
        const requestId = randomUUID();
        const restored = this.cellMirrors?.get(cell);
        if (restored) { restored.execution.end(undefined, Date.now()); this.cellMirrors.delete(cell); }
        const execution = this.notebook.createNotebookCellExecution(cell);
        this.managedRuns?.delete(cell);
        this.localRunning?.add(cell);
        execution.start(Date.now());
        try {
          this.executions.set(requestId, { notebook: key, requestId, endpoint: connection.endpoint, sessionId: connection.sessionId, memberId: connection.memberId, projectName: connection.name, createdAt: Date.now() });
          await this.rememberExecutions();
          await execution.clearOutput();
          requireOriginalSession();
          const shared = await this.notebookSync?.prepareExecution(notebook);
          await this.textSync?.flushAll();
          requireOriginalSession();
          if ((this.cancellationGenerations?.get(key) ?? 0) !== cancellation) { await this.endExecution(execution, cell, undefined); break; }
          const expectedSourceHash = createHash('sha256').update(cell.document.getText()).digest('hex');
          const result = await connection.client.call<PersistentExecution>('execute', { sessionId: connection.sessionId, notebook: key, cellIndex: cell.index,
            expectedRevision: shared?.revision ?? this.files.revision, expectedSourceHash, ...(shared?.identity ? { expectedNotebookIdentity: shared.identity } : {}),
            ...(this.view ? { expectedGeneration: this.view.generation } : {}), ...(shared?.cells[cell.index] ? { expectedCellId: shared.cells[cell.index]!.id } : {}), requestId });
          this.executions.set(requestId, { ...this.executions.get(requestId)!, id: result.id });
          this.managedRuns?.set(cell, result);
          await this.rememberExecutions();
          const completed = await this.observe(result, execution, connection);
          const currentOutput = (!this.view || this.view.generation === completed.generation)
            && (!completed.sourceHash || completed.sourceHash === createHash('sha256').update(cell.document.getText()).digest('hex'));
          this.managedRuns?.set(cell, completed);
          await this.endExecution(execution, cell, currentOutput ? completed.state === 'completed' : undefined);
          void this.files.refresh().catch((error) => this.log.appendLine(`[debug] Execution workspace refresh: ${error instanceof Error ? error.message : 'Unavailable.'}`));
          if (completed.state !== 'completed') break;
        } catch (error) {
          if (!this.notebookSync?.isRetired?.(notebook) && !notebook.isClosed) await execution.appendOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(new Error(`${error instanceof Error ? error.message : 'Execution failed.'} Recovery request ID: ${requestId}`))]));
          await this.endExecution(execution, cell, false);
          break;
        } finally { this.localRunning?.delete(cell); if (['queued', 'running'].includes(this.managedRuns?.get(cell)?.state ?? 'running')) this.managedRuns?.delete(cell); }
      }
    });
    this.notebookQueues.set(notebook, queued);
    try { await queued; } finally { if (this.notebookQueues.get(notebook) === queued) this.notebookQueues.delete(notebook); }
  }
  private async mirrorActiveExecutions(): Promise<void> {
    const connection = this.connection; if (!connection || !vscode.workspace.notebookDocuments?.some((notebook) => notebook.uri.scheme === SCHEME && notebook.uri.authority === connection.sessionId)) return;
    const reply = await connection.client.call<{ executions: PersistentExecution[] }>('executions', { sessionId: connection.sessionId });
    if (connection === this.connection) for (const execution of reply.executions ?? []) void this.mirrorExecution(execution.id).catch((error) => this.log.appendLine(`[debug] Execution mirror unavailable: ${error instanceof Error ? error.message : 'Disconnected.'}`));
  }
  private managesCell(cell: vscode.NotebookCell): boolean {
    const run = this.managedRuns.get(cell);
    if (!run) return this.localRunning.has(cell);
    return (!this.view || this.view.generation === run.generation) && this.files.visibilityOf(run.notebook) === (run.scope ?? 'public')
      && (!run.sourceHash || createHash('sha256').update(cell.document.getText()).digest('hex') === run.sourceHash);
  }
  private mirrorExecution(id: string): Promise<void> {
    if (this.mirroredRuns.has(id) || [...this.executions.values()].some((run) => run.id === id)) return Promise.resolve();
    const connection = this.connection; if (!connection) return Promise.resolve();
    const work = Promise.resolve().then(async () => {
      const run = this.latestExecution(id, connection) ?? await connection.client.call<PersistentExecution>('execution', { sessionId: connection.sessionId, executionId: id });
      if (connection !== this.connection || this.disposed) return;
      if (this.files.visibilityOf(run.notebook) === undefined) await this.files.refresh(); if (connection !== this.connection) return;
      if (this.files.visibilityOf(run.notebook) !== (run.scope ?? 'public') || (this.view && this.view.generation !== run.generation)) return;
      const notebook = vscode.workspace.notebookDocuments.find((item) => !this.notebookSync?.isRetired?.(item) && item.uri.scheme === SCHEME && item.uri.authority === connection.sessionId && item.uri.path.slice(1) === run.notebook);
      if (notebook && this.notebookSync?.isRetired?.(notebook)) return;
      if (notebook && run.notebookIdentity) {
        const shared = await this.notebookSync.prepareExecution(notebook);
        if (shared?.identity !== run.notebookIdentity) return;
      }
      const cell = notebook?.getCells().find((item) => (item.metadata.pairNotebookCellId ?? item.metadata.id) === run.cellId);
      if (!cell || (this.selectedNotebooks && !this.selectedNotebooks.has(notebook!)) || this.localRunning.has(cell)
        || (this.managedRuns.get(cell)?.id === run.id && this.managesCell(cell))
        || (run.sourceHash && createHash('sha256').update(cell.document.getText()).digest('hex') !== run.sourceHash)) return;
      const handle = this.notebook.createNotebookCellExecution(cell); handle.start(Date.now());
      this.managedRuns.set(cell, run);
      let success: boolean | undefined;
      try { const finished = await this.observe(run, handle, connection, false);
        this.managedRuns.set(cell, finished);
        if (connection === this.connection && (!this.view || this.view.generation === run.generation)
          && (!run.sourceHash || createHash('sha256').update(cell.document.getText()).digest('hex') === run.sourceHash)) success = finished.state === 'completed';
      } finally { if (['queued', 'running'].includes(this.managedRuns.get(cell)?.state ?? 'running')) this.managedRuns.delete(cell); if (!cell.document.isClosed) await this.endExecution(handle, cell, success); }
    });
    this.mirroredRuns.set(id, work);
    void work.finally(() => { if (this.mirroredRuns.get(id) === work) this.mirroredRuns.delete(id); }).catch(() => undefined);
    return work;
  }
  private latestExecution(id: string, connection: ActiveConnection): PersistentExecution | undefined {
    const cached = this.latestExecutions?.get(id);
    return cached && cached.connection === connection ? cached.execution : undefined;
  }
  private endExecution(handle: vscode.NotebookCellExecution, cell: vscode.NotebookCell, success: boolean | undefined): Promise<void> {
    // Native end() updates arrive asynchronously; returning early races Save's notebook version.
    const endTime = Date.now();
    return new Promise((resolve, reject) => {
      const done = (): void => { listener?.dispose(); if (timer) clearTimeout(timer); resolve(); };
      const listener = vscode.workspace.onDidChangeNotebookDocument?.((event) => {
        if (event.notebook === cell.notebook && cell.executionSummary?.timing?.endTime === endTime) done();
      });
      const timer = setTimeout(done, 1000); timer.unref();
      try {
        handle.end(success, endTime);
        if (!listener || cell.document.isClosed || cell.executionSummary?.timing?.endTime === endTime) done();
      } catch (error) { listener?.dispose(); clearTimeout(timer); reject(error); }
    });
  }
  private notifyExecution(id: string, execution?: PersistentExecution): void {
    const previous = this.latestExecution(id, this.connection!);
    if (execution?.id === id && this.connection && this.latestExecutions
      && (!previous || (execution.events.length >= previous.events.length && (['queued', 'running'].includes(previous.state) || !['queued', 'running'].includes(execution.state))))) {
      this.latestExecutions.set(id, { connection: this.connection, execution });
      if (this.latestExecutions.size > 256) { const oldest = this.latestExecutions.keys().next().value; if (oldest) this.latestExecutions.delete(oldest); }
    }
    this.executionChanges.set(id, (this.executionChanges.get(id) ?? 0) + 1);
    if (this.executionChanges.size > 256) { const oldest = this.executionChanges.keys().next().value; if (oldest) this.executionChanges.delete(oldest); }
    this.executionWaiters.get(id)?.forEach((resolve) => resolve());
  }
  private waitForExecutionUpdate(id: string, version: number): Promise<void> {
    if ((this.executionChanges?.get(id) ?? 0) > version) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.executionWaiters?.get(id) ?? new Set<() => void>();
      const finish = (): void => { clearTimeout(timer); waiters.delete(finish); if (!waiters.size) this.executionWaiters?.delete(id); resolve(); };
      const timer = setTimeout(finish, 500); waiters.add(finish); this.executionWaiters?.set(id, waiters);
    });
  }
  private async observe(initial: PersistentExecution, handle?: vscode.NotebookCellExecution, connection = this.requireConnection(), interactive = true): Promise<PersistentExecution> {
    const state = createJupyterRenderState();
    const canRender = (): boolean => (!handle?.cell?.notebook || !this.notebookSync?.isRetired?.(handle.cell.notebook)) && (!this.view || this.view.generation === initial.generation)
      && (!handle?.cell || (!handle.cell.document.isClosed && (!initial.sourceHash || initial.sourceHash === createHash('sha256').update(handle.cell.document.getText()).digest('hex'))));
    let seen = 0;
    let result = initial;
    let version = this.executionChanges?.get(initial.id) ?? 0;
    while (!this.disposed && connection === this.connection) {
      if (handle?.cell?.notebook && this.notebookSync?.isRetired?.(handle.cell.notebook)) throw new Error(`Notebook instance retired; run ${initial.id} remains recoverable on the server.`);
      for (const raw of result.events.slice(seen)) {
        if (raw.type === 'kernelState' && typeof raw.message === 'string') {
          void vscode.window.showInformationMessage(raw.message.slice(0, 4096));
        }
        const event = (raw.event && typeof raw.event === 'object' ? raw.event : raw) as unknown as JupyterKernelEvent;
        const update = applyJupyterEventToState(state, event);
        if (handle && canRender() && update.executionOrder !== undefined) handle.executionOrder = update.executionOrder;
        if (event.type === 'inputRequest' && interactive) {
          const value = await vscode.window.showInputBox({ title: `Server Jupyter input · accepted run on ${result.deviceId}`, prompt: String(event.content?.prompt ?? 'Input').slice(0, 4096), password: event.content?.password === true, ignoreFocusOut: true });
          if (connection !== this.connection || this.disposed) throw new Error('The persistent session changed during kernel input.');
          await connection.client.call('kernelControl', { sessionId: connection.sessionId, executionId: result.id,
            command: value !== undefined ? { command: 'inputReply', value } : { command: 'interrupt' } });
        }
      }
      seen = result.events.length;
      if (handle && canRender()) await handle.replaceOutput(state.outputs);
      if (!['queued', 'running'].includes(result.state)) {
        if (handle && canRender() && result.error) await handle.appendOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(new Error(result.error))]));
        return result;
      }
      await this.waitForExecutionUpdate(result.id, version);
      version = this.executionChanges?.get(result.id) ?? 0;
      const pushed = this.latestExecution(result.id, connection);
      const advances = pushed && pushed.events.length >= result.events.length
        && (pushed.events.length > result.events.length || (result.state === 'queued' && pushed.state !== 'queued') || (result.state === 'running' && !['queued', 'running'].includes(pushed.state)));
      try {
        result = advances ? pushed : await connection.client.call<PersistentExecution>('execution', { sessionId: connection.sessionId, executionId: result.id });
      } catch (error) {
        if (error instanceof PersistentHttpError && [401, 403, 404].includes(error.status)) throw error;
        // Accepted execution outlives a route failure. Keep observing its exact
        // identity instead of permanently marking the live cell failed.
        if (connection !== this.connection || this.disposed) break;
        await this.waitForExecutionUpdate(result.id, version);
      }
    }
    throw new Error(`Execution observation ended; run ${result.id} remains recoverable on the server.`);
  }
  private async rememberExecutions(): Promise<void> {
    const saved = this.context.globalState.get<AcceptedRunReference[]>('pairNotebook.persistentExecutions', []);
    const merged = new Map(saved.map(item => [`${item.endpoint}|${item.sessionId}|${item.requestId}`, item]));
    for (const item of this.executions.values()) merged.set(`${item.endpoint}|${item.sessionId}|${item.requestId}`, item);
    await this.context.globalState.update('pairNotebook.persistentExecutions', [...merged.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)).slice(-50));
  }
  public async recoverExecution(): Promise<void> {
    const connection = this.requireConnection();
    const saved = this.context.globalState.get<AcceptedRunReference[]>('pairNotebook.persistentExecutions', [])
      .filter(item => (!item.sessionId || item.sessionId === connection.sessionId)
        && (!item.endpoint || item.endpoint === connection.endpoint) && (!item.memberId || item.memberId === connection.memberId))
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const entries = await Promise.all(saved.map(async item => {
      try {
        const result = await this.rpcFor<PersistentExecution>(connection, 'execution', { ...(item.id ? { executionId: item.id } : { requestId: item.requestId }), summary: true });
        const deviceName = this.view?.devices.find(device => device.id === result.deviceId)?.name;
        return { ...presentAcceptedRun({ ...item, ...(deviceName ? { deviceName } : {}) }, result), executionId: result.id };
      } catch (error) {
        if (error instanceof PersistentHttpError && [403, 404].includes(error.status)) return undefined;
        throw error;
      }
    }));
    this.assertConnection(connection);
    const available = entries.filter((entry): entry is NonNullable<typeof entry> => !!entry);
    if (!available.length) {
      void vscode.window.showInformationMessage('No saved runs are available for this project and membership. Older or inaccessible runs were omitted.');
      return;
    }
    const picked = await vscode.window.showQuickPick(available, { title: 'Inspect saved run results — no code is rerun', matchOnDescription: true, matchOnDetail: true });
    if (!picked) return;
    this.assertConnection(connection);
    let run: PersistentExecution;
    try { run = await this.rpcFor<PersistentExecution>(connection, 'execution', { executionId: picked.executionId }); }
    catch (error) {
      if (error instanceof PersistentHttpError && [403, 404].includes(error.status)) {
        void vscode.window.showInformationMessage('This saved run is no longer available to this membership. No code was rerun.');
        return;
      }
      throw error;
    }
    this.assertConnection(connection);
    const details = [`${connection.name} / ${run.notebook} — Cell ${run.cellIndex + 1}`, `State: ${run.state}`, `Compute: ${this.view?.devices.find(device => device.id === run.deviceId)?.name ?? (run.deviceId === 'vps' ? 'VPS' : 'Computer (name unavailable)')}`, '', 'This is the saved run record. No code was rerun and no notebook outputs were replaced.', ''];
    for (const event of run.events) {
      const content = event.content as Record<string, unknown> | undefined;
      if (event.messageType === 'stream' && typeof content?.text === 'string') details.push(content.text);
      else if (event.messageType === 'error') details.push(String(content?.ename ?? 'Error') + ': ' + String(content?.evalue ?? 'Execution failed.'));
      else if (event.messageType === 'execute_result' || event.messageType === 'display_data') {
        const data = content?.data as Record<string, unknown> | undefined;
        details.push(typeof data?.['text/plain'] === 'string' ? data['text/plain'] : 'Rich output retained in the saved run record.');
      }
    }
    if (run.error) details.push(run.error);
    const fullDetails = details.join('\n');
    const shownDetails = fullDetails.length > 256 * 1024 ? fullDetails.slice(0, 256 * 1024) + '\n[Summary truncated; the full result remains on the server.]' : fullDetails;
    const summary = await vscode.workspace.openTextDocument({ language: 'plaintext', content: shownDetails });
    this.assertConnection(connection);
    await vscode.window.showTextDocument(summary, { preview: false });
    void vscode.window.showInformationMessage(`Saved results for ${run.notebook}, cell ${run.cellIndex + 1} (${run.state}) are open in a separate summary. No notebook content was replaced and no code was rerun.`);
  }
  public async shutdown(): Promise<void> {
    const connection = this.connection;
    // Flush journals before closing listeners, including when the Server is down.
    const saved = await Promise.allSettled([this.notebookSync.shutdown(), this.textSync.shutdown()]);
    for (const result of saved) if (result.status === 'rejected') this.log.appendLine(`[error] Exit journal write failed: ${result.reason instanceof Error ? result.reason.message : 'Storage unavailable.'}`);
    this.disposed = true;
    this.connection = undefined; this.comments = []; this.commentsRevision = undefined;
    if (connection) {
      let timer: NodeJS.Timeout | undefined;
      try { await Promise.race([connection.client.call('leave', { sessionId: connection.sessionId }), new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); timer.unref(); })]); }
      catch (error) { this.log.appendLine(`[debug] Server exit will expire server-side: ${error instanceof Error ? error.message : 'Disconnected.'}`); }
      finally { if (timer) clearTimeout(timer); connection.client.dispose(); }
    }
    for (const waiters of this.executionWaiters.values()) for (const finish of waiters) finish();
  }
  public dispose(): void {
    this.disposed = true;
    const connection = this.connection;
    this.connection = undefined; this.comments = []; this.commentsRevision = undefined;
    if (connection) void connection.client.call('leave', { sessionId: connection.sessionId }).catch(() => undefined);
    for (const disposable of this.disposables) disposable.dispose();
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
