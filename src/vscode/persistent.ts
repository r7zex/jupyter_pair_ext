import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import type { JupyterKernelEvent } from '../core/pythonKernel';
import { PersistentClient, PersistentHttpError } from '../vps/persistentClient';
import { mergePersistentNotebookOutputs } from '../vps/persistentNotebookMerge';
import type { PersistentDevice, PersistentExecution, PersistentMembership, PersistentSessionView, PersistentSnapshot, PersistentTarget } from '../vps/persistentProtocol';
import { normalizeVpsUrl, safeJobPath } from '../vps/protocol';
import { applyJupyterEventToState, createJupyterRenderState } from './jupyterOutputState';

const SCHEME = 'pair-vps';
const CONNECTIONS_KEY = 'pairNotebook.persistentConnections';
interface SavedConnection { endpoint: string; sessionId: string; memberId: string; name: string }
interface ActiveConnection extends SavedConnection { client: PersistentClient }

function membershipKey(connection: SavedConnection): string {
  return `pairNotebook.persistentMembership.${createHash('sha256').update(JSON.stringify([connection.endpoint, connection.sessionId, connection.memberId])).digest('hex')}`;
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
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  public readonly onDidChangeFile = this.changed.event;
  private snapshot: PersistentSnapshot = { revision: 0, entries: [] };
  private readonly readRevisions = new Map<string, number>();
  private readonly readContents = new Map<string, Buffer>();
  private connection: ActiveConnection | undefined;
  private mutation = Promise.resolve();
  public setConnection(connection: ActiveConnection | undefined): void {
    this.connection = connection;
    this.snapshot = { revision: 0, entries: [] };
    this.readRevisions.clear();
    this.readContents.clear();
  }
  public get revision(): number { return this.snapshot.revision; }
  public uri(key = ''): vscode.Uri { return vscode.Uri.from({ scheme: SCHEME, authority: this.requireConnection().sessionId, path: `/${key}` }); }
  private requireConnection(): ActiveConnection {
    if (!this.connection) throw vscode.FileSystemError.Unavailable('Connect to a persistent VPS session first.');
    return this.connection;
  }
  private check(uri: vscode.Uri): string {
    if (uri.authority !== this.requireConnection().sessionId) throw vscode.FileSystemError.NoPermissions('This file belongs to another session.');
    return filePath(uri);
  }
  public accept(snapshot: PersistentSnapshot): void {
    if (snapshot.revision < this.snapshot.revision) return;
    const events = sameEntries(this.snapshot, snapshot).map((event) => ({ ...event, uri: this.uri(filePath(event.uri)) }));
    this.snapshot = snapshot;
    if (events.length) this.changed.fire(events);
  }
  public async refresh(): Promise<void> {
    const connection = this.requireConnection();
    const snapshot = await connection.client.call<PersistentSnapshot>('snapshot', { sessionId: connection.sessionId });
    if (connection === this.connection) this.accept(snapshot);
  }
  public watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }
  public async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const key = this.check(uri);
    if (!key) return { type: vscode.FileType.Directory, ctime: 0, mtime: this.snapshot.revision, size: 0 };
    await this.refresh();
    const entry = this.snapshot.entries.find((candidate) => candidate.path === key);
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: entry.type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File, ctime: entry.mtime, mtime: entry.mtime, size: entry.size };
  }
  public async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const key = this.check(uri);
    await this.refresh();
    const prefix = key ? `${key}/` : '';
    return this.snapshot.entries.filter((entry) => entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes('/'))
      .map((entry): [string, vscode.FileType] => [entry.path.slice(prefix.length), entry.type === 'directory' ? vscode.FileType.Directory : vscode.FileType.File]);
  }
  public async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const key = this.check(uri);
    const connection = this.requireConnection();
    const response = await connection.client.call<{ content: string; revision: number }>('read', { sessionId: connection.sessionId, path: key });
    // A second read may be a comparison view while the original editor stays dirty.
    // Only reopening or a successful save establishes a new editing baseline.
    const content = Buffer.from(response.content, 'base64');
    if (!this.readRevisions.has(key)) {
      this.readRevisions.set(key, response.revision);
      this.readContents.set(key, content);
    }
    return content;
  }
  private mutate(operation: string, input: Record<string, unknown>): Promise<void> {
    const connection = this.requireConnection();
    const work = this.mutation.then(async () => {
      if (connection !== this.connection) throw vscode.FileSystemError.Unavailable('The persistent session changed.');
      try {
        let request: Record<string, unknown> = { sessionId: connection.sessionId, expectedRevision: this.snapshot.revision, ...input };
        let snapshot: PersistentSnapshot;
        try { snapshot = await connection.client.call<PersistentSnapshot>(operation, request); }
        catch (error) {
          if (!(error instanceof PersistentHttpError) || error.status !== 409 || operation !== 'write' || typeof input.path !== 'string' || typeof input.content !== 'string') throw error;
          const baseline = this.readContents.get(input.path);
          if (!baseline) throw error;
          const response = await connection.client.call<{ content: string; revision: number }>('read', { sessionId: connection.sessionId, path: input.path });
          const latest = Buffer.from(response.content, 'base64');
          const desired = Buffer.from(input.content, 'base64');
          const merged = latest.equals(baseline) ? desired : input.path.endsWith('.ipynb') ? mergePersistentNotebookOutputs(baseline, desired, latest) : undefined;
          if (!merged) throw error;
          request = { ...request, expectedRevision: response.revision, content: Buffer.from(merged).toString('base64') };
          // Exactly one CAS retry. A concurrent edit after this read still fails.
          snapshot = await connection.client.call<PersistentSnapshot>(operation, request);
        }
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
  public async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    const key = this.check(uri);
    const entry = this.snapshot.entries.find((candidate) => candidate.path === key);
    if (!options.create && !entry) throw vscode.FileSystemError.FileNotFound(uri);
    if (!options.overwrite && entry) throw vscode.FileSystemError.FileExists(uri);
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
  public release(uri: vscode.Uri): void {
    if (uri.scheme === SCHEME && uri.authority === this.connection?.sessionId) {
      this.readRevisions.delete(filePath(uri));
      this.readContents.delete(filePath(uri));
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

/** UI for independent, durable VPS authority; does not start or transfer a P2P host. */
export class PersistentSessionController implements vscode.TreeDataProvider<PersistentItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<PersistentItem | undefined>();
  public readonly onDidChangeTreeData = this.changed.event;
  private readonly files = new PersistentFileSystem();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly notebook: vscode.NotebookController;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 79);
  private connection: ActiveConnection | undefined;
  private view: PersistentSessionView | undefined;
  private polling = false;
  private disposed = false;
  private readonly promptedConsents = new Set<string>();
  private readonly executions = new Map<string, { notebook: string; requestId: string; id?: string }>();
  private readonly notebookQueues = new Map<string, Promise<void>>();

  public constructor(private readonly context: vscode.ExtensionContext, private readonly log: vscode.OutputChannel) {
    this.notebook = vscode.notebooks.createNotebookController('pair-notebook-persistent', 'jupyter-notebook', 'Pair Notebook • Persistent VPS', (cells, notebook) => this.execute(cells, notebook));
    this.notebook.supportedLanguages = ['python'];
    this.notebook.supportsExecutionOrder = true;
    this.notebook.description = 'Stateful Jupyter on the VPS session compute device';
    this.notebook.interruptHandler = async (notebook) => { await this.kernel(notebook.uri, 'interrupt'); };
    this.status.command = 'pairNotebook.manageVpsSession';
    const timer = setInterval(() => { void this.poll(); }, 2_000);
    timer.unref();
    this.disposables.push(
      vscode.window.createTreeView('pairNotebook.persistentSessions', { treeDataProvider: this }),
      vscode.workspace.registerFileSystemProvider(SCHEME, this.files, { isCaseSensitive: true }),
      vscode.workspace.onDidOpenNotebookDocument((notebook) => this.claim(notebook)),
      vscode.workspace.onDidCloseNotebookDocument((notebook) => this.files.release(notebook.uri)),
      vscode.workspace.onDidCloseTextDocument((document) => this.files.release(document.uri)),
      this.notebook, this.status, this.files, this.changed, new vscode.Disposable(() => clearInterval(timer)),
    );
    const commands: Record<string, (...args: never[]) => unknown> = {
      'pairNotebook.connectVps': () => this.connect(),
      'pairNotebook.createVpsSession': () => this.create(),
      'pairNotebook.joinVpsSession': () => this.join(),
      'pairNotebook.manageVpsSession': () => this.manage(),
      'pairNotebook.leaveVpsSession': () => this.leave(),
      'pairNotebook.uploadVpsFolder': () => this.upload(),
      'pairNotebook.selectVpsCompute': () => this.selectCompute(),
      'pairNotebook.shareVpsComputer': () => this.shareComputer(),
      'pairNotebook.recoverVpsExecution': () => this.recoverExecution(),
      'pairNotebook.restartVpsKernel': () => this.restartKernel(),
      'pairNotebook.releaseVpsKernel': () => this.releaseKernel(),
      'pairNotebook.refreshVpsSession': () => this.refresh(),
      'pairNotebook.vpsFolderPublic': (uri: vscode.Uri) => this.visibility(uri, 'public'),
      'pairNotebook.vpsFolderPrivate': (uri: vscode.Uri) => this.visibility(uri, 'private'),
    };
    for (const [id, callback] of Object.entries(commands)) this.disposables.push(vscode.commands.registerCommand(id, async (...args: never[]) => {
      try { await callback(...args); }
      catch (error) {
        this.log.appendLine('[error] Persistent VPS command failed; see the VS Code notification.');
        void vscode.window.showErrorMessage(`Pair Notebook VPS: ${error instanceof Error ? error.message : 'Operation failed.'}`);
      }
    }));
    const restore = async (): Promise<void> => {
      if (!vscode.workspace.isTrusted || this.connection || this.disposed) return;
      const root = vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === SCHEME);
      if (!root) return;
      const saved = this.context.globalState.get<SavedConnection[]>(CONNECTIONS_KEY, []).find((item) => item.sessionId === root.uri.authority);
      if (!saved) return;
      const token = await this.context.secrets.get(membershipKey(saved));
      if (token) await this.attach(saved, token);
    };
    // Adding the first folder restarts VS Code's extension host. Resume the explicit VPS workspace handoff.
    if (vscode.workspace.workspaceFolders?.some((folder) => folder.uri.scheme === SCHEME)) {
      void restore().catch(() => undefined);
      this.disposables.push(vscode.workspace.onDidGrantWorkspaceTrust(() => { void restore().catch(() => undefined); }));
    }
  }
  public getTreeItem(item: PersistentItem): vscode.TreeItem { return item; }
  private deviceUsage(device: PersistentDevice | undefined): string {
    const names = device?.usingMemberIds?.map((memberId) => this.view?.members.find((member) => member.id === memberId)?.name ?? 'member') ?? [];
    return names.length ? `In use by ${names.join(', ')}` : 'Idle';
  }
  public getChildren(): PersistentItem[] {
    if (!this.connection || !this.view) return [new PersistentItem('Connect to VPS', 'pairNotebook.connectVps'), new PersistentItem('Create persistent session', 'pairNotebook.createVpsSession'), new PersistentItem('Join persistent session', 'pairNotebook.joinVpsSession')];
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
    if (!this.connection) throw new Error('Connect to a persistent VPS session first.');
    return this.connection;
  }
  private async rpc<T>(operation: string, input: Record<string, unknown> = {}): Promise<T> {
    const connection = this.requireConnection();
    return connection.client.call<T>(operation, { sessionId: connection.sessionId, ...input });
  }
  private async endpoint(): Promise<string | undefined> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before connecting to VPS.');
    const value = await vscode.window.showInputBox({ title: 'Connect to VPS', prompt: 'HTTPS address; participants only need the session password', value: this.context.globalState.get<string>('pairNotebook.persistentEndpoint', ''), ignoreFocusOut: true,
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
      { label: 'Create a persistent session', action: 'create' },
      { label: 'Import existing owner / member credential', action: 'import' },
      ...saved.map((connection) => ({ label: `Reconnect: ${connection.name}`, description: connection.endpoint, action: 'resume', connection })),
    ], { title: 'Persistent VPS sessions' });
    if (!selection) return;
    if (selection.action === 'join') await this.join();
    else if (selection.action === 'create') await this.create();
    else if (selection.action === 'import') await this.importCredential();
    else if ('connection' in selection) {
      const connection = selection.connection as SavedConnection;
      const token = await this.context.secrets.get(membershipKey(connection));
      if (!token) throw new Error('This saved identity has no credential. Join the session again.');
      await this.attach(connection, token);
    }
  }
  private async importCredential(): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before connecting to VPS.');
    const sources = await vscode.window.showOpenDialog({ title: 'Import an owner or member credential created on the VPS', canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { JSON: ['json'] } });
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
    const admin = await vscode.window.showInputBox({ title: 'VPS administrator', prompt: 'Administrative Team token — kept separate from participant credentials', password: true, ignoreFocusOut: true,
      validateInput: (value) => /^[A-Za-z0-9_-]{32,256}$/.test(value) ? undefined : 'Enter your configured administrative token.' });
    if (admin === undefined) return;
    const name = await vscode.window.showInputBox({ title: 'Persistent session name', ignoreFocusOut: true, validateInput: (value) => value.trim() ? undefined : 'Enter a name.' });
    if (name === undefined) return;
    const password = await this.password('Set session password');
    if (password === undefined) return;
    const membership = await new PersistentClient(endpoint, { kind: 'admin', token: admin }).call<PersistentMembership>('create', { name: name.trim(), password });
    await this.attach({ endpoint, ...membership }, membership.token);
  }
  public async join(): Promise<void> {
    const endpoint = await this.endpoint();
    if (!endpoint) return;
    const sessionId = await vscode.window.showInputBox({ title: 'Session ID', prompt: 'Session ID provided by its owner', ignoreFocusOut: true, validateInput: (value) => /^[A-Za-z0-9_-]{1,128}$/.test(value) ? undefined : 'Enter a valid session ID.' });
    if (sessionId === undefined) return;
    const name = await vscode.window.showInputBox({ title: 'Participant name', value: vscode.workspace.getConfiguration('pairNotebook').get<string>('displayName', ''), ignoreFocusOut: true, validateInput: (value) => value.trim() ? undefined : 'Enter your name.' });
    if (name === undefined) return;
    const password = await this.password('Join persistent session');
    if (password === undefined) return;
    const membership = await new PersistentClient(endpoint, { kind: 'anonymous' }).call<PersistentMembership>('join', { sessionId, name: name.trim(), password });
    await this.attach({ endpoint, ...membership }, membership.token);
  }
  private async attach(saved: SavedConnection, token: string): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before connecting to VPS.');
    if (this.connection) await this.leave();
    const connection: ActiveConnection = { endpoint: saved.endpoint, sessionId: saved.sessionId, memberId: saved.memberId, name: saved.name, client: new PersistentClient(saved.endpoint, { kind: 'membership', token }) };
    const view = await connection.client.call<PersistentSessionView>('heartbeat', { sessionId: connection.sessionId });
    await this.context.secrets.store(membershipKey(connection), token);
    const connections = this.context.globalState.get<SavedConnection[]>(CONNECTIONS_KEY, []).filter((item) => !(item.endpoint === connection.endpoint && item.sessionId === connection.sessionId && item.memberId === connection.memberId));
    // Explicitly pick nonsecret fields; never store the membership response or client.
    connections.unshift({ endpoint: connection.endpoint, sessionId: connection.sessionId, memberId: connection.memberId, name: connection.name });
    await this.context.globalState.update(CONNECTIONS_KEY, connections.slice(0, 20));
    this.connection = connection;
    this.view = view;
    this.files.setConnection(connection);
    await this.files.refresh();
    await vscode.commands.executeCommand('setContext', 'pairNotebook.inVpsSession', true);
    await vscode.commands.executeCommand('setContext', 'pairNotebook.vpsOwner', view.memberId === view.ownerId);
    const root = this.files.uri();
    if (!vscode.workspace.workspaceFolders?.some((folder) => folder.uri.toString() === root.toString())) {
      vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, { uri: root, name: `VPS: ${view.name}` });
    }
    for (const notebook of vscode.workspace.notebookDocuments) this.claim(notebook);
    this.updateUi();
    void vscode.window.showInformationMessage('Persistent VPS connected. Files synchronize on save; conflicting saves keep your local edit. Closing VS Code leaves the server session running.');
  }
  private claim(notebook: vscode.NotebookDocument): void {
    if (notebook.uri.scheme === SCHEME && notebook.uri.authority === this.connection?.sessionId) this.notebook.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
  }
  public async leave(notifyServer = true): Promise<void> {
    const connection = this.connection;
    if (!connection) return;
    // Deactivation never stops a session or cancels accepted runs.
    try { if (notifyServer) await connection.client.call('leave', { sessionId: connection.sessionId }); }
    finally {
      this.connection = undefined;
      this.view = undefined;
      this.files.setConnection(undefined);
      this.status.hide();
      this.changed.fire(undefined);
      await vscode.commands.executeCommand('setContext', 'pairNotebook.inVpsSession', false);
      await vscode.commands.executeCommand('setContext', 'pairNotebook.vpsOwner', false);
      const index = vscode.workspace.workspaceFolders?.findIndex((folder) => folder.uri.scheme === SCHEME && folder.uri.authority === connection.sessionId) ?? -1;
      if (index >= 0) vscode.workspace.updateWorkspaceFolders(index, 1);
    }
  }
  private updateUi(): void {
    if (!this.view) return;
    const target = this.view.devices.find((device) => device.id === this.view!.target.deviceId);
    this.status.text = `$(server) VPS ${this.view.state} · ${target?.name ?? this.view.target.deviceId} ${this.view.target.gpuUuid ? 'GPU' : 'CPU'}`;
    this.status.tooltip = `Session ${this.view.id} · kernel generation ${this.view.generation} · ${target?.online ? 'online' : 'offline'} · files synchronize on save`;
    this.status.show();
    this.changed.fire(undefined);
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
      await this.files.refresh();
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
        this.status.text = '$(warning) VPS disconnected — reconnecting';
        this.status.tooltip = error instanceof Error ? error.message : 'Connection unavailable';
      }
    } finally { this.polling = false; }
  }
  public async refresh(): Promise<void> { await this.files.refresh(); await this.poll(); }
  public async visibility(uri: vscode.Uri | undefined, visibility: 'public' | 'private'): Promise<void> {
    if (!uri || uri.scheme !== SCHEME) throw new Error('Choose a folder in the VPS workspace.');
    await this.files.setVisibility(uri, visibility);
  }
  public async upload(): Promise<void> {
    this.requireConnection();
    const selection = await vscode.window.showQuickPick([{ label: 'Private — owner only', value: 'private' }, { label: 'Public — all session participants', value: 'public' }], { title: 'Choose access BEFORE uploading files' });
    if (!selection) return;
    const sources = await vscode.window.showOpenDialog({ title: 'Upload files or a folder to VPS', canSelectFiles: true, canSelectFolders: true, canSelectMany: false });
    const source = sources?.[0];
    if (!source) return;
    if (source.scheme === SCHEME) throw new Error('Select a local file or folder.');
    const destination = await vscode.window.showInputBox({ title: 'Server destination', value: path.basename(source.path), ignoreFocusOut: true, validateInput: (value) => safeJobPath(value) ? undefined : 'Enter a safe relative project path.' });
    if (!destination) return;
    await this.files.refresh();
    // Create a private parent first; publication happens only after an explicit visibility operation.
    await this.files.createPrivateDirectory(this.files.uri(destination));
    let count = 0;
    const visit = async (uri: vscode.Uri, key: string): Promise<void> => {
      if (++count > 2_000) throw new Error('Upload exceeds 2,000 entries; split this folder into smaller uploads.');
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.SymbolicLink) throw new Error('Symbolic links cannot be uploaded.');
      if (stat.type & vscode.FileType.Directory) {
        if (key !== destination) await this.files.createDirectory(this.files.uri(key));
        for (const [name] of await vscode.workspace.fs.readDirectory(uri)) await visit(vscode.Uri.joinPath(uri, name), `${key}/${name}`);
      } else {
        if (stat.size > 8 * 1024 * 1024) throw new Error('Individual upload files must be at most 8 MiB. Keep large datasets on the compute device.');
        await this.files.writeFile(this.files.uri(key), await vscode.workspace.fs.readFile(uri), { create: true, overwrite: false });
      }
    };
    const sourceStat = await vscode.workspace.fs.stat(source);
    await visit(source, sourceStat.type & vscode.FileType.Directory ? destination : `${destination}/${path.basename(source.path)}`);
    if (selection.value === 'public') await this.files.setVisibility(this.files.uri(destination), 'public');
    void vscode.window.showInformationMessage(`Uploaded ${count} entries with ${selection.value} access.`);
  }
  public async selectCompute(): Promise<void> {
    await this.poll();
    if (!this.view) throw new Error('Connect to a session first.');
    const choices: (vscode.QuickPickItem & { target: PersistentTarget })[] = [];
    for (const device of this.view.devices) {
      const owner = this.view.members.find((member) => member.id === device.ownerId)?.name ?? device.ownerId;
      const detail = `${device.python}; ${device.cpu}; owner ${owner}; ${device.isolation}; ${device.enabled ? 'sharing enabled' : 'sharing disabled'}; ${this.deviceUsage(device)}`;
      choices.push({ label: `${device.name} — CPU`, description: device.online ? 'online' : 'offline', detail, target: { deviceId: device.id } });
      for (const gpu of device.gpus) choices.push({ label: `${device.name} — ${gpu.name}`, description: `${gpu.memoryMb} MiB · ${device.online ? 'online' : 'offline'}`, detail, target: { deviceId: device.id, gpuUuid: gpu.uuid } });
    }
    const target = await vscode.window.showQuickPick(choices, { title: 'Select next execution device (server checks permissions and consent)' });
    if (!target) return;
    const choice = await vscode.window.showWarningMessage('Changing device creates a different stateful kernel for later runs. Python objects do not migrate. Existing executions continue on their accepted device.', 'Select device');
    if (choice !== 'Select device') return;
    const result = await this.rpc<PersistentSessionView>('select', { target: target.target });
    this.view = result;
    const pending = result.consents.some((consent) => consent.status === 'pending' && consent.requesterId === result.memberId && consent.deviceId === target.target.deviceId && consent.gpuUuid === target.target.gpuUuid);
    void vscode.window.showInformationMessage(pending ? 'Consent requested. The current execution device stays active until approval.' : 'Execution device selected.');
    await this.poll();
  }
  public async shareComputer(): Promise<void> {
    await this.poll();
    if (!this.view) throw new Error('Connect to a session first.');
    const own = this.view.devices.filter((device) => device.ownerId === this.view!.memberId);
    const action = await vscode.window.showQuickPick([
      { label: 'Set up compute agent on this computer', action: 'setup' },
      ...own.map((device) => ({ label: `${device.enabled ? 'Stop' : 'Enable'} sharing ${device.name}`, action: 'toggle', device })),
      ...this.view.consents.filter((consent) => consent.status === 'approved' && own.some((device) => device.id === consent.deviceId)).map((consent) => ({ label: `Revoke consent: ${consent.requesterId} → ${consent.deviceId}`, action: 'revoke', consent })),
    ], { title: 'Your computer and session consent' });
    if (!action) return;
    if (action.action === 'toggle' && 'device' in action) { const device = action.device; await this.rpc('share', { deviceId: device.id, enabled: !device.enabled }); }
    else if (action.action === 'revoke' && 'consent' in action) await this.rpc('revokeConsent', { consentId: action.consent.id });
    else {
      const accepted = await vscode.window.showWarningMessage('Session Python code can access the compute account. Use a dedicated unprivileged account or isolated container. Sharing resources still requires approval for other participants.', { modal: true }, 'Export agent credential');
      if (accepted !== 'Export agent credential') return;
      const destination = await vscode.window.showSaveDialog({ title: 'Save compute agent credential outside shared project folders', defaultUri: vscode.Uri.file(path.join(this.context.globalStorageUri.fsPath, 'persistent-agent.json')), filters: { JSON: ['json'] } });
      if (!destination) return;
      if (destination.scheme !== 'file') throw new Error('Save agent credentials to a local private file.');
      if (vscode.workspace.workspaceFolders?.some((folder) => folder.uri.scheme === 'file' && isWithin(folder.uri.fsPath, destination.fsPath))) {
        throw new Error('Save agent credentials outside every project workspace folder.');
      }
      const connection = this.requireConnection();
      const token = await this.context.secrets.get(membershipKey(connection));
      if (!token) throw new Error('Reconnect to restore your member credential.');
      await mkdir(path.dirname(destination.fsPath), { recursive: true, mode: 0o700 });
      const handle = await open(destination.fsPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(JSON.stringify({ endpoint: connection.endpoint, sessionId: connection.sessionId, memberId: connection.memberId, token }, null, 2));
        await handle.sync();
      } finally { await handle.close(); }
      void vscode.window.showInformationMessage('Credential exported. Run scripts/pair-notebook-session-agent.py --config <saved file> --python <your environment Python> --share. Use a non-root isolated account; restrict the credential file to it. The agent reports actual CPU/CUDA capabilities.');
    }
    await this.poll();
  }
  public async manage(): Promise<void> {
    await this.poll();
    if (!this.view) { await this.connect(); return; }
    const view = this.view;
    const member = view.members.find((member) => member.id === view.memberId);
    const owner = member?.role === 'owner';
    const admin = owner || member?.role === 'admin';
    const actions = [{ label: 'Copy session connection details', action: 'invite' }, { label: 'Choose compute device', action: 'compute' }];
    if (admin) actions.push({ label: 'Stop session', action: 'stop' }, { label: 'Start session', action: 'start' }, { label: 'Restart session', action: 'restart' }, { label: 'Delete session permanently', action: 'delete' }, { label: 'Revoke participant access', action: 'revoke' });
    if (owner) actions.push({ label: view.allowMemberSwitch ? 'Disallow participant compute switching' : 'Allow participant compute switching', action: 'settings' }, { label: 'Change password', action: 'password' }, { label: 'Grant / revoke participant administration', action: 'role' });
    const action = await vscode.window.showQuickPick(actions, { title: `${view.name} · ${view.id}` });
    if (!action) return;
    if (action.action === 'invite') { await vscode.env.clipboard.writeText(`${this.requireConnection().endpoint}\nSession ID: ${view.id}`); return; }
    if (action.action === 'compute') { await this.selectCompute(); return; }
    if (action.action === 'settings') await this.rpc('settings', { allowMemberSwitch: !view.allowMemberSwitch });
    else if (action.action === 'password') {
      const password = await this.password('Change session password');
      if (password !== undefined) await this.rpc('password', { password });
    } else if (action.action === 'role' || action.action === 'revoke') {
      const target = await vscode.window.showQuickPick(view.members.filter((member) => member.role !== 'owner' && member.id !== view.memberId).map((member) => ({ label: member.name, description: member.role, member })), { title: 'Select participant' });
      if (!target) return;
      if (action.action === 'revoke') await this.rpc('revoke', { memberId: target.member.id });
      else await this.rpc('role', { memberId: target.member.id, role: target.member.role === 'admin' ? 'member' : 'admin' });
    } else {
      const confirmation = await vscode.window.showWarningMessage(`${action.label}? Accepted computations may still be running. Stop/restart affects future access and kernel lifecycle; deletion removes stored project data.`, { modal: true }, action.label);
      if (confirmation !== action.label) return;
      await this.rpc('lifecycle', { action: action.action });
      if (action.action === 'delete') { await this.leave(false); return; }
    }
    await this.poll();
  }
  private async kernel(uri: vscode.Uri, command: 'interrupt' | 'restart' | 'release'): Promise<void> {
    const connection = this.requireConnection();
    if (uri.scheme !== SCHEME || uri.authority !== connection.sessionId) throw new Error('Open a notebook in the connected persistent VPS session first.');
    const key = filePath(uri);
    const active = [...this.executions.values()].reverse().find((execution) => execution.notebook === key && execution.id);
    if (command === 'interrupt' && active?.id) await this.rpc('kernelControl', { executionId: active.id, command: { command } });
    else if (command !== 'interrupt') {
      const result = await this.rpc<PersistentExecution>('kernel', { notebook: key, command, requestId: randomUUID() });
      if (connection !== this.connection) throw new Error(`Kernel ${command} was accepted in the previous session. Recoverable execution ID: ${result.id}`);
      const completed = await this.observe(result);
      if (completed.state !== 'completed') throw new Error(completed.error ?? `Kernel ${command} ${completed.state}. Recoverable execution ID: ${completed.id}`);
    }
  }
  public async restartKernel(): Promise<void> {
    const uri = vscode.window.activeNotebookEditor?.notebook.uri;
    if (!uri) throw new Error('Open a VPS notebook first.');
    if (await vscode.window.showWarningMessage('Restart this Jupyter kernel? Its Python variables will be lost. Restart waits for already accepted computations without interrupting them.', { modal: true }, 'Restart kernel') === 'Restart kernel') {
      await this.kernel(uri, 'restart');
      void vscode.window.showInformationMessage('Notebook kernel restarted. Python variables were cleared; saved cell outputs remain.');
    }
  }
  public async releaseKernel(): Promise<void> {
    const uri = vscode.window.activeNotebookEditor?.notebook.uri;
    if (!uri) throw new Error('Open a VPS notebook first.');
    if (await vscode.window.showWarningMessage('Release this notebook kernel to free compute memory? Its Python variables will be lost. Release waits for already accepted computations without interrupting them; the next execution starts a fresh kernel.', { modal: true }, 'Release kernel') === 'Release kernel') {
      await this.kernel(uri, 'release');
      void vscode.window.showInformationMessage('Notebook kernel released. Python variables were cleared; saved cell outputs remain.');
    }
  }
  private async execute(cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument): Promise<void> {
    const key = filePath(notebook.uri);
    if (notebook.uri.scheme !== SCHEME || notebook.uri.authority !== this.connection?.sessionId) throw new Error('This notebook is outside the connected VPS project.');
    const previous = this.notebookQueues.get(key) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(async () => {
      if (!await notebook.save()) throw new Error('Save the notebook before execution. Resolve any server conflict first.');
      for (const cell of cells) if (cell.kind === vscode.NotebookCellKind.Code && cell.document.languageId === 'python') {
        const requestId = randomUUID();
        this.executions.set(requestId, { notebook: key, requestId });
        await this.context.globalState.update('pairNotebook.persistentExecutions', [...this.executions.values()].slice(-50));
        const execution = this.notebook.createNotebookCellExecution(cell);
        execution.start(Date.now());
        await execution.clearOutput();
        try {
          await this.files.refresh();
          const result = await this.rpc<PersistentExecution>('execute', { notebook: key, cellIndex: cell.index, expectedRevision: this.files.revision, requestId });
          this.executions.set(requestId, { notebook: key, requestId, id: result.id });
          await this.context.globalState.update('pairNotebook.persistentExecutions', [...this.executions.values()].slice(-50));
          const completed = await this.observe(result, execution);
          execution.end(completed.state === 'completed', Date.now());
          await this.files.refresh();
        } catch (error) {
          await execution.appendOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(new Error(`${error instanceof Error ? error.message : 'Execution failed.'} Recovery request ID: ${requestId}`))]));
          execution.end(false, Date.now());
        }
      }
    });
    this.notebookQueues.set(key, queued);
    try { await queued; } finally { if (this.notebookQueues.get(key) === queued) this.notebookQueues.delete(key); }
  }
  private async observe(initial: PersistentExecution, handle?: vscode.NotebookCellExecution): Promise<PersistentExecution> {
    const connection = this.requireConnection();
    const state = createJupyterRenderState();
    let seen = 0;
    let result = initial;
    while (!this.disposed && connection === this.connection) {
      for (const raw of result.events.slice(seen)) {
        const event = (raw.event && typeof raw.event === 'object' ? raw.event : raw) as unknown as JupyterKernelEvent;
        const update = applyJupyterEventToState(state, event);
        if (handle && update.executionOrder !== undefined) handle.executionOrder = update.executionOrder;
        if (event.type === 'inputRequest') {
          const value = await vscode.window.showInputBox({ title: 'VPS Jupyter input', prompt: String(event.content?.prompt ?? 'Input').slice(0, 4096), password: event.content?.password === true, ignoreFocusOut: true });
          if (value !== undefined) await this.rpc('kernelControl', { executionId: result.id, command: { command: 'inputReply', value } });
          else await this.rpc('kernelControl', { executionId: result.id, command: { command: 'interrupt' } });
        }
      }
      seen = result.events.length;
      if (handle) await handle.replaceOutput(state.outputs);
      if (!['queued', 'running'].includes(result.state)) {
        if (handle && result.error) await handle.appendOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(new Error(result.error))]));
        return result;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      result = await connection.client.call<PersistentExecution>('execution', { sessionId: connection.sessionId, executionId: result.id });
    }
    throw new Error(`Execution observation ended; run ${result.id} remains recoverable on the server.`);
  }
  public async recoverExecution(): Promise<void> {
    const saved = this.context.globalState.get<{ notebook: string; requestId: string; id?: string }[]>('pairNotebook.persistentExecutions', []);
    const picked = await vscode.window.showQuickPick(saved.map((item) => ({ label: item.notebook, description: item.id ?? item.requestId, item })), { title: 'Recover an accepted run' });
    if (!picked) return;
    const result = await this.rpc<PersistentExecution>('execution', picked.item.id ? { executionId: picked.item.id } : { requestId: picked.item.requestId });
    void vscode.window.showInformationMessage(`Execution ${result.id}: ${result.state}. Device ${result.deviceId}; kernel generation ${result.generation}.`);
    await this.files.refresh();
    await vscode.commands.executeCommand('vscode.open', this.files.uri(result.notebook));
  }
  public dispose(): void {
    this.disposed = true;
    const connection = this.connection;
    this.connection = undefined;
    if (connection) void connection.client.call('leave', { sessionId: connection.sessionId }).catch(() => undefined);
    for (const disposable of this.disposables) disposable.dispose();
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
