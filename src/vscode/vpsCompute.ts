import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { readFile, readdir, stat } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { SessionRuntime } from '../runtime/session';
import type { VpsRelayConnection } from '../runtime/vpsFrameRelay';
import { classifyFile, decodeUtf8ProjectFile, MAX_TRACKED_PROJECT_ENTRIES, shouldTrackProjectPath } from '../core/projectFiles';
import { VpsClient, VpsHttpError } from '../vps/client';
import { PendingSubmissionStore } from '../vps/pendingSubmission';
import { pythonNotebookProgram } from '../vps/notebookProgram';
import { type CancellationChallenge, type ComputeScope, type JobSubmission, type JobSummary, type VpsAgent, type VpsDevice,
  MAX_JOB_BYTES, MAX_JOB_FILES, normalizeVpsUrl, safeJobPath, terminalJob, validateSubmission, validComputeScope, vpsSecretKey } from '../vps/protocol';

const OBSERVATION_KEY = 'pairNotebook.vpsObservation';
const JOB_CACHE_KEY = 'pairNotebook.vpsJobCache';
const MAX_VISIBLE_OUTPUT_BYTES = 1024 * 1024;

function elapsed(job: JobSummary): string {
  if (job.startedAt === undefined) return 'not started';
  const seconds = Math.max(0, Math.floor(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000));
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${seconds % 60}s`;
}

function jobState(job: JobSummary): string {
  return job.cancelRequested && !terminalJob(job.status) ? 'cancel_pending — awaiting executor stop acknowledgement' : job.status;
}

function jobDetails(job: JobSummary): string {
  return `Experiment: ${job.title}; job/run ID: ${job.id}; executor: ${job.agentId} (${job.device}); elapsed: ${elapsed(job)}; `
    + `session: ${job.sessionId ?? 'legacy unscoped'}; project: ${job.projectId ?? 'legacy unscoped'}; `
    + `${job.dataset ? `data: ${job.dataset.version} (${job.dataset.sha256}); ` : ''}`
    + `last checkpoint: not reported by this executor${job.failureReason ? `; failure: ${job.failureReason}` : ''}`;
}

export async function readVpsConnection(context: vscode.ExtensionContext): Promise<VpsRelayConnection | undefined> {
  if (!vscode.workspace.isTrusted) return undefined;
  const endpoint = vscode.workspace.getConfiguration('pairNotebook').get<string>('vpsUrl', '').trim();
  if (!endpoint) return undefined;
  const url = normalizeVpsUrl(endpoint);
  const token = await context.secrets.get(vpsSecretKey(url));
  if (token && !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error('The stored VPS access token is invalid. Connect to VPS again.');
  return token ? { url, token } : undefined;
}

class ComputeItem extends vscode.TreeItem {
  public constructor(label: string, public readonly group?: 'agents' | 'jobs') {
    super(label, group ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
  }
}

/** Shared VPS jobs are independent of both the session host and the editor lifetime. */
export class VpsComputeController implements vscode.TreeDataProvider<ComputeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<ComputeItem | undefined>();
  public readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<ComputeItem>;
  private readonly output = vscode.window.createOutputChannel('Pair Notebook VPS Jobs');
  private readonly refreshTimer: NodeJS.Timeout;
  private logTimer: NodeJS.Timeout | undefined;
  private logGeneration = 0;
  private disposed = false;
  private submitting = false;
  private visibleOutputBytes = 0;
  private readonly settingsSubscription: vscode.Disposable;
  private readonly pending: PendingSubmissionStore;

  public constructor(private readonly context: vscode.ExtensionContext, private readonly currentRuntime: () => SessionRuntime | undefined) {
    this.view = vscode.window.createTreeView('pairNotebook.vpsCompute', { treeDataProvider: this });
    this.pending = new PendingSubmissionStore(path.join(context.globalStorageUri.fsPath, 'pending-vps-jobs'));
    this.settingsSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('pairNotebook.vpsUrl')) return;
      this.stopWatching();
      this.refresh();
    });
    this.refreshTimer = setInterval(() => { if (this.view.visible) this.refresh(); }, 10_000);
    this.refreshTimer.unref();
    setImmediate(() => { void this.restoreObservation().catch(() => undefined); }).unref();
  }
  public dispose(): void {
    this.disposed = true;
    this.logGeneration++;
    clearInterval(this.refreshTimer);
    if (this.logTimer) clearTimeout(this.logTimer);
    this.changed.dispose();
    this.settingsSubscription.dispose();
    this.view.dispose();
    this.output.dispose();
  }
  public refresh(): void { if (!this.disposed) this.changed.fire(undefined); }
  public getTreeItem(item: ComputeItem): vscode.TreeItem { return item; }
  public async getChildren(item?: ComputeItem): Promise<ComputeItem[]> {
    try {
      const connection = await readVpsConnection(this.context);
      if (!connection) {
        const connect = new ComputeItem('Connect to your VPS');
        connect.command = { command: 'pairNotebook.connectVps', title: 'Connect to VPS' };
        return [connect];
      }
      if (!item) return [new ComputeItem('Compute machines', 'agents'), new ComputeItem('Background jobs', 'jobs')];
      const client = new VpsClient(connection.url, connection.token);
      if (item.group === 'agents') {
        const agents = await client.agents();
        if (!agents.length) return [new ComputeItem('Start the compute agent on your PC to register it')];
        return agents.map((agent) => {
        const result = new ComputeItem(agent.name);
        result.description = `${agent.online ? 'online' : 'offline'} • ${agent.resources.cpuCount} CPUs • ${agent.resources.gpus.length} GPUs`;
        result.tooltip = `${agent.id}\nPython: ${agent.resources.python}\n${agent.resources.gpus.map((gpu) => `${gpu.name} (${gpu.memoryMb} MB)`).join('\n')}`;
        result.iconPath = new vscode.ThemeIcon(agent.online ? 'vm-active' : 'vm-outline');
        result.command = { command: 'pairNotebook.runVpsJob', title: 'Run on this machine', arguments: [agent.id] };
        return result;
        });
      }
      const jobs = await client.jobs();
      await this.context.globalState.update(JOB_CACHE_KEY, { endpoint: client.endpoint, jobs: jobs.slice(0, 100) });
      if (!jobs.length) return [new ComputeItem('No background jobs yet')];
      return jobs.slice(0, 100).map((job) => this.jobItem(job));
    } catch (error) {
      const auth = error instanceof VpsHttpError && [401, 403].includes(error.status);
      const retry = new ComputeItem(auth ? 'VPS access denied — click to reconnect' : 'VPS unavailable — click to retry');
      retry.command = { command: auth ? 'pairNotebook.connectVps' : 'pairNotebook.refreshVpsJobs', title: 'Retry VPS connection' };
      const cached = this.context.globalState.get<{ endpoint: string; jobs: JobSummary[] }>(JOB_CACHE_KEY);
      const configured = vscode.workspace.getConfiguration('pairNotebook').get<string>('vpsUrl', '').trim();
      if (!auth && item?.group === 'jobs' && cached?.endpoint === configured.replace(/\/+$/, '')) {
        return [retry, ...cached.jobs.slice(0, 100).map((job) => this.jobItem(job, true))];
      }
      return [retry];
    }
  }

  private jobItem(job: JobSummary, unavailable = false): ComputeItem {
    const result = new ComputeItem(job.title);
    result.id = job.id;
    result.description = `${unavailable ? 'observation unavailable • last known ' : ''}${jobState(job)} • ${job.agentId} • ${job.device} • ${elapsed(job)}`;
    result.tooltip = `${jobDetails(job)}\n${new Date(job.createdAt).toLocaleString()}\nClick to reattach output; this does not execute the job again`;
    result.iconPath = new vscode.ThemeIcon(job.cancelRequested && !terminalJob(job.status) ? 'debug-pause'
      : job.status === 'running' ? 'sync~spin' : job.status === 'succeeded' ? 'pass' : 'tasklist');
    result.command = { command: 'pairNotebook.showVpsJob', title: 'Show job output', arguments: [job.id] };
    return result;
  }

  private async client(): Promise<VpsClient> {
    const connection = await readVpsConnection(this.context);
    if (!connection) throw new Error('Connect your VPS with Pair Notebook: Connect to VPS first.');
    return new VpsClient(connection.url, connection.token);
  }

  public async connect(): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before connecting its compute service.');
    const configuration = vscode.workspace.getConfiguration('pairNotebook');
    const endpoint = await vscode.window.showInputBox({ title: 'Your VPS', prompt: 'HTTPS address of your Pair Notebook VPS service',
      value: configuration.get<string>('vpsUrl', ''), ignoreFocusOut: true,
      validateInput: (value) => { try { normalizeVpsUrl(value); return undefined; } catch { return 'Enter an HTTPS URL without credentials.'; } } });
    if (endpoint === undefined) return;
    const url = normalizeVpsUrl(endpoint);
    const token = await vscode.window.showInputBox({ title: 'VPS access', prompt: 'Team access token (saved in VS Code SecretStorage)',
      password: true, ignoreFocusOut: true,
      validateInput: (value) => /^[A-Za-z0-9_-]{32,256}$/.test(value) ? undefined : 'Enter the team token configured on your VPS.' });
    if (token === undefined) return;
    const client = new VpsClient(url, token);
    await client.agents();
    await this.context.secrets.store(vpsSecretKey(url), token);
    this.stopWatching();
    await configuration.update('vpsUrl', url, vscode.ConfigurationTarget.Global);
    this.refresh();
    void vscode.window.showInformationMessage('VPS connected. Its relay is available to the current session; background jobs are ready.');
  }

  public async submit(preferredAgent?: string): Promise<void> {
    if (this.submitting) throw new Error('A background submission is already in progress. Finish its selection or retry first.');
    this.submitting = true;
    try { await this.submitOnce(preferredAgent); }
    finally { this.submitting = false; }
  }

  private async submitOnce(preferredAgent?: string): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before submitting Python for remote execution.');
    const initial = await readVpsConnection(this.context);
    if (!initial) throw new Error('Connect your VPS with Pair Notebook: Connect to VPS first.');
    const client = new VpsClient(initial.url, initial.token);
    const legacy = this.context.globalState.get<{ endpoint: string; id: string }>('pairNotebook.pendingVpsJob');
    if (legacy?.endpoint === client.endpoint) {
      // Older extension versions did not retain the input. An absent listing is
      // not proof that an earlier request cannot still commit.
      const existing = (await client.jobs()).find((job) => job.id === legacy.id);
      if (!existing) throw new Error(`An earlier submission (${legacy.id}) remains unconfirmed. Check VPS Jobs before clearing its legacy receipt.`);
      await this.context.globalState.update('pairNotebook.pendingVpsJob', undefined);
      await this.showJob(existing.id); return;
    }
    const pending = await this.pending.load(client.endpoint);
    if (pending) { await this.deliver(client, pending); return; }
    const runtime = this.currentRuntime();
    const scope = await this.computeScope();
    const agents = await client.agents();
    const targets = agents.filter((agent) => typeof preferredAgent !== 'string' || agent.id === preferredAgent).flatMap((agent) => [
      this.target(agent, 'cpu'), ...agent.resources.gpus.map((gpu) => this.target(agent, `gpu:${gpu.index}`, `${gpu.name} • ${gpu.memoryMb} MB`)),
    ]);
    if (!targets.length) throw new Error('No compute agents have registered. Start the standalone agent on your PC or VPS first.');
    const selected = await vscode.window.showQuickPick(targets, { title: 'Background compute',
      placeHolder: 'Choose CPU or GPU; offline machines will run queued jobs when they return' });
    if (!selected) return;
    const input = await this.sourceSnapshot();
    if (!input) return;
    const current = await readVpsConnection(this.context);
    if (this.disposed || !current || current.url !== client.endpoint || current.token !== initial.token) {
      throw new Error('The VPS configuration changed during selection. Start the submission again.');
    }
    if (runtime !== this.currentRuntime() || !this.sameScope(scope, await this.computeScope())) {
      throw new Error('The session or project changed during selection. Start the submission again.');
    }
    const gpuUuid = selected.agent.resources.gpus.find((gpu) => `gpu:${gpu.index}` === selected.device)?.uuid;
    const job = validateSubmission({ id: randomUUID(), agentId: selected.agent.id, device: selected.device,
      ...scope,
      ...(gpuUuid ? { gpuUuid } : {}),
      ...(selected.agent.resources.dataset ? { dataset: { version: selected.agent.resources.dataset.version, sha256: selected.agent.resources.dataset.sha256 } } : {}),
      title: path.basename(input.entrypoint).slice(0, 200).replace(/[\uD800-\uDBFF]$/u, ''), ...input, args: [] });
    await this.pending.save(client.endpoint, job);
    await this.deliver(client, job);
  }

  private async deliver(client: VpsClient, job: JobSubmission): Promise<void> {
    try { await client.submit(job); }
    catch { throw new Error(`Could not confirm job ${job.id}. Open VPS Jobs to check it; the next submission will reconcile this request first.`); }
    await this.pending.clear(job.id);
    this.refresh();
    void vscode.window.showInformationMessage('Background job submitted. Reattach through VPS Jobs after closing the editor; the compute machine must stay powered on.');
    await this.showJob(job.id);
  }

  private target(agent: VpsAgent, device: VpsDevice, detail?: string): vscode.QuickPickItem & { agent: VpsAgent; device: VpsDevice } {
    return { label: `${agent.name} • ${device === 'cpu' ? 'CPU' : `GPU ${device.slice(4)}`}`,
      description: `${agent.online ? 'online' : 'offline — queue for later'} • ${agent.id}`,
      detail: `${detail ?? `${agent.resources.cpuCount} CPU threads`} • ${agent.resources.dataset
        ? `prepared data ${agent.resources.dataset.version} (${agent.resources.dataset.sha256}, ${agent.resources.dataset.files} files)`
        : 'No prepared data manifest; binary host datasets are not transferred by the source snapshot'}`, agent, device };
  }

  private sameScope(left: ComputeScope, right: ComputeScope): boolean {
    return left.projectId === right.projectId && left.sessionId === right.sessionId;
  }

  private async computeScope(): Promise<ComputeScope> {
    const descriptor = this.currentRuntime()?.descriptor;
    if (descriptor) {
      if (!validComputeScope(descriptor)) throw new Error('The current session has no valid compute identity. Reopen the session before submitting or stopping its jobs.');
      return { projectId: descriptor.projectId, sessionId: descriptor.sessionId };
    }
    const uri = vscode.window.activeNotebookEditor?.notebook.uri ?? vscode.window.activeTextEditor?.document.uri;
    const folder = vscode.workspace.workspaceFolders?.find((item) => uri && safeJobPath(path.relative(item.uri.fsPath, uri.fsPath).split(path.sep).join('/')))?.uri.fsPath
      ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? (uri ? path.dirname(uri.fsPath) : undefined);
    if (!folder) throw new Error('Open a project before submitting or stopping its VPS jobs.');
    const identity = path.resolve(folder);
    const projectId = createHash('sha256').update(process.platform === 'win32' ? identity.toLowerCase() : identity).digest('hex');
    const key = `pairNotebook.vpsStandaloneSession.${projectId}`;
    let sessionId = this.context.globalState.get<string>(key);
    if (!sessionId) { sessionId = randomUUID(); await this.context.globalState.update(key, sessionId); }
    return { projectId, sessionId };
  }

  private async sourceSnapshot(): Promise<Pick<JobSubmission, 'entrypoint' | 'files'> | undefined> {
    const active = this.currentRuntime();
    const files: Record<string, string> = Object.create(null) as Record<string, string>;
    const notebook = vscode.window.activeNotebookEditor;
    const editor = vscode.window.activeTextEditor;
    const uri = notebook?.notebook.uri ?? editor?.document.uri;
    if (!uri) throw new Error('Open a Python file or notebook to submit a background job.');
    const folder = vscode.workspace.workspaceFolders?.find((item) => {
      const key = path.relative(item.uri.fsPath, uri.fsPath).split(path.sep).join('/');
      return safeJobPath(key);
    })?.uri.fsPath;
    const projectRoot = active?.descriptor.workingFolder ?? folder;
    let entrypoint = projectRoot ? path.relative(projectRoot, uri.fsPath).split(path.sep).join('/') : path.basename(uri.fsPath);
    if (!safeJobPath(entrypoint)) throw new Error('The active file must be inside the current collaborative project.');
    let scope: 'all' | 'cell' | undefined;
    if (notebook) {
      const selectedScope = await vscode.window.showQuickPick([
        { label: 'Whole notebook', description: 'Python cells in a fresh process', value: 'all' },
        { label: 'Active cell', description: 'Fresh process; existing kernel variables are unavailable', value: 'cell' },
      ], { title: 'Run notebook in background' });
      if (!selectedScope) return undefined;
      scope = selectedScope.value as 'all' | 'cell';
    }
    if (this.disposed || active !== this.currentRuntime()) throw new Error('The collaborative session changed during source selection. Try again.');
    // Read standalone project resources before capturing dirty editors. Collaborative
    // state is captured synchronously so canonical dependencies form one snapshot.
    let sourceBytes = 0;
    const putSource = (key: string, value: string): void => {
      sourceBytes += Buffer.byteLength(value) - (files[key] === undefined ? 0 : Buffer.byteLength(files[key]));
      if (sourceBytes > MAX_JOB_BYTES) throw new Error('Python source snapshot is too large for a background job.');
      files[key] = value;
    };
    if (!active && projectRoot) {
      let visited = 0;
      const visit = async (directory: string): Promise<void> => {
        for (const entry of await readdir(path.join(projectRoot, directory), { withFileTypes: true })) {
          const key = directory ? `${directory}/${entry.name}` : entry.name;
          if (!shouldTrackProjectPath(key)) continue;
          if (++visited > MAX_TRACKED_PROJECT_ENTRIES) throw new Error('Project has too many entries to snapshot.');
          if (entry.isDirectory()) { await visit(key); continue; }
          if (!entry.isFile() || !safeJobPath(key)) continue;
          const absolute = path.join(projectRoot, key);
          const size = (await stat(absolute)).size;
          // Binary datasets stay on the compute PC; never hash or load them here.
          if (classifyFile(key, size) !== 'text') continue;
          if (size > MAX_JOB_BYTES || Object.keys(files).length >= MAX_JOB_FILES) throw new Error('Project snapshot is too large. Keep large datasets on the compute machine in PAIR_NOTEBOOK_WORKSPACE.');
          const bytes = await readFile(absolute);
          const text = decodeUtf8ProjectFile(bytes);
          if (text !== undefined) putSource(key, text);
        }
      };
      await visit('');
    }
    if (this.disposed || active !== this.currentRuntime()) throw new Error('The collaborative session changed during source capture. Try again.');
    if (active) for (const key of active.project.keys()) {
      if (safeJobPath(key) && shouldTrackProjectPath(key) && active.project.kindOf(key) === 'text') {
        const text = active.project.text(key);
        if (text.length > MAX_JOB_BYTES || Object.keys(files).length >= MAX_JOB_FILES) throw new Error('Python source snapshot is too large for a background job.');
        putSource(key, text.toString());
      }
    }
    if (projectRoot) for (const document of vscode.workspace.textDocuments) {
      if (!document.isDirty || document.uri.scheme !== 'file') continue;
      const key = path.relative(projectRoot, document.uri.fsPath).split(path.sep).join('/');
      if (!key.endsWith('.ipynb') && safeJobPath(key) && shouldTrackProjectPath(key)) putSource(key, document.getText());
    }
    if (notebook) {
      const cells = scope === 'all' ? notebook.notebook.getCells() : [notebook.notebook.cellAt(notebook.selection.start)];
      const python = cells.filter((cell) => cell.kind === vscode.NotebookCellKind.Code && cell.document.languageId === 'python');
      if (!python.length) throw new Error('No Python code cells selected.');
      const code = pythonNotebookProgram(python.map((cell) => cell.document.getText()));
      const directory = path.posix.dirname(entrypoint);
      const suffix = `.pair-job-${randomUUID()}.py`;
      let stem = '';
      const prefix = directory === '.' ? '' : `${directory}/`;
      for (const character of path.posix.basename(entrypoint).replace(/\.ipynb$/i, '')) {
        if (Buffer.byteLength(stem + character) > 255 - suffix.length || prefix.length + stem.length + character.length + suffix.length > 512) break;
        stem += character;
      }
      entrypoint = prefix + stem + suffix;
      putSource(entrypoint, code);
    } else {
      if (!editor || !entrypoint.endsWith('.py')) throw new Error('Open a .py file or a Python notebook.');
      putSource(entrypoint, editor.document.getText());
    }
    if (Object.keys(files).length > MAX_JOB_FILES || Buffer.byteLength(JSON.stringify(files)) > MAX_JOB_BYTES) throw new Error('Python source snapshot is too large for a background job.');
    return { entrypoint, files };
  }

  public async showJobs(): Promise<void> {
    const jobs = await (await this.client()).jobs();
    const selected = await vscode.window.showQuickPick(jobs.map((job) => ({ label: job.title,
      description: `${jobState(job)} • ${job.agentId} • ${job.device} • ${elapsed(job)}`, detail: jobDetails(job), job })), { title: 'Shared VPS jobs' });
    if (!selected) return;
    await this.showJob(selected.job.id);
  }

  public async cancel(id?: string): Promise<void> {
    const client = await this.client();
    const jobs = (await client.jobs()).filter((job) => !terminalJob(job.status));
    const selected = typeof id === 'string' ? jobs.find((job) => job.id === id)
      : (await vscode.window.showQuickPick(jobs.map((job) => ({ label: job.title, description: `${jobState(job)} • ${job.agentId}`,
        detail: jobDetails(job), job })), { title: 'Stop one background job' }))?.job;
    if (!selected) return;
    const scope = selected.projectId && selected.sessionId ? { projectId: selected.projectId, sessionId: selected.sessionId } : undefined;
    const challenge = await client.requestCancellation({ action: 'cancel_job', targetIds: [selected.id], ...(scope ? { scope } : {}) });
    await this.confirmCancellation(client, challenge);
  }

  public async stopSession(): Promise<void> {
    const runtime = this.currentRuntime();
    const scope = await this.computeScope();
    const client = await this.client();
    const challenge = await client.requestCancellation({ action: 'stop_session', scope });
    await this.confirmCancellation(client, challenge, async () => runtime === this.currentRuntime() && this.sameScope(scope, await this.computeScope()));
  }

  /** Explicitly replace a standalone intake scope after an emergency stop. */
  public async startComputeSession(): Promise<string | undefined> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before starting a compute session.');
    if (this.currentRuntime()) throw new Error('A collaborative session owns this compute scope. Start a new collaborative session to obtain a new scope.');
    const scope = await this.computeScope();
    const selected = await vscode.window.showQuickPick([
      { label: 'Start a new compute session', description: 'New submissions use a fresh scope; existing jobs remain observable by their IDs', start: true },
      { label: 'Keep the current compute session', start: false },
    ], { title: 'Standalone VPS compute session' });
    if (!selected?.start) return undefined;
    if (this.disposed || this.currentRuntime() || !this.sameScope(scope, await this.computeScope())) {
      throw new Error('The project or collaborative session changed during selection. Start the action again.');
    }
    const sessionId = randomUUID();
    await this.context.globalState.update(`pairNotebook.vpsStandaloneSession.${scope.projectId}`, sessionId);
    this.refresh();
    void vscode.window.showInformationMessage(`New compute session: ${sessionId}. Existing jobs remain available through VPS Jobs.`);
    return sessionId;
  }

  private async confirmCancellation(client: VpsClient, challenge: CancellationChallenge, stillCurrent?: () => Promise<boolean>): Promise<void> {
    const details = challenge.targets.map(jobDetails).join(' | ') || 'No currently active jobs; further submissions in this session will be blocked.';
    const text = await vscode.window.showInputBox({ title: challenge.action === 'stop_session' ? 'Emergency stop: current project session' : 'Stop the selected background job',
      value: '', ignoreFocusOut: true,
      prompt: `${challenge.scope ? `Scope: project ${challenge.scope.projectId}, session ${challenge.scope.sessionId}. ` : ''}${details} | Stops the managed training process, subprocesses and DataLoader workers for these exact IDs. State after the last completed checkpoint may be lost. Type CONFIRM exactly.`,
      validateInput: (value) => value === 'CONFIRM' ? undefined : 'Type the exact uppercase word CONFIRM with no spaces.' });
    if (text !== 'CONFIRM') return;
    const connection = await readVpsConnection(this.context);
    if (this.disposed || !connection || connection.url !== client.endpoint || (stillCurrent && !await stillCurrent())) {
      throw new Error('The VPS, session or project changed while confirmation was open. Nothing was cancelled; start the action again.');
    }
    const result = await client.applyCancellation(challenge.id, text);
    if (challenge.action === 'stop_session' && challenge.scope) {
      for await (const pending of this.pending.list(client.endpoint)) if (validComputeScope(pending) && this.sameScope(pending, challenge.scope)) {
        // The broker has durably closed this scope. A delayed unaccepted request
        // can no longer commit; any accepted target was frozen into this stop.
        await this.pending.clear(pending.id);
      }
    }
    this.refresh();
    // A replayed operation returns its original durable receipt. Observe current
    // execution states before describing a stop that may have completed since.
    const observed = await client.jobs().catch(() => result.jobs);
    const pending = observed.filter((job) => result.targetIds.includes(job.id) && !terminalJob(job.status));
    const message = pending.length
      ? 'Stop intent saved. cancel_pending: awaiting executor connection and acknowledgement that its managed processes stopped.'
      : 'Stop confirmed. The selected executions have reached a terminal state.';
    void vscode.window.showInformationMessage(message + (challenge.action === 'stop_session' ? ' This project session is closed to new submissions.' : ''));
  }

  private async restoreObservation(): Promise<void> {
    const saved = this.context.globalState.get<{ endpoint: string; id: string }>(OBSERVATION_KEY);
    const generation = this.logGeneration;
    if (!saved || this.disposed || generation !== 0) return;
    const connection = await readVpsConnection(this.context);
    if (this.disposed || generation !== this.logGeneration || !connection || connection.url !== saved.endpoint) return;
    await this.showJob(saved.id);
  }

  private appendOutput(value: string): void {
    let bytes = Buffer.from(value, 'utf8');
    if (this.visibleOutputBytes + bytes.length > MAX_VISIBLE_OUTPUT_BYTES) {
      this.output.clear();
      const notice = '[Visible output window rotated. Retained broker output is available by reattaching; experiment metrics and checkpoints belong in saved artifacts.]\n';
      this.output.append(notice);
      this.visibleOutputBytes = Buffer.byteLength(notice);
    }
    if (bytes.length > MAX_VISIBLE_OUTPUT_BYTES - this.visibleOutputBytes) {
      let start = bytes.length - (MAX_VISIBLE_OUTPUT_BYTES - this.visibleOutputBytes);
      while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
      bytes = bytes.subarray(start);
    }
    this.output.append(bytes.toString('utf8'));
    this.visibleOutputBytes += bytes.length;
  }

  public async showJob(id: string): Promise<void> {
    const generation = ++this.logGeneration;
    if (this.logTimer) clearTimeout(this.logTimer);
    this.logTimer = undefined;
    const client = await this.client();
    if (this.disposed || generation !== this.logGeneration) return;
    await this.context.globalState.update(OBSERVATION_KEY, { endpoint: client.endpoint, id });
    if (this.disposed || generation !== this.logGeneration) return;
    this.output.clear();
    this.visibleOutputBytes = 0;
    this.output.show(true);
    let offset = 0;
    let headerShown = false;
    let unavailable = false;
    let lastState = '';
    let decoder = new StringDecoder('utf8');
    const poll = async (): Promise<void> => {
      try {
        const job = await client.job(id, offset);
        if (this.disposed || generation !== this.logGeneration) return;
        if (!headerShown) { this.appendOutput(`${jobDetails(job)}\n`); headerShown = true; }
        const state = jobState(job);
        if (state !== lastState) { this.appendOutput(`[State: ${state}]\n`); lastState = state; }
        if (unavailable) this.appendOutput('[Observation reattached to the same job; execution was not restarted.]\n');
        unavailable = false;
        if (offset < job.logStart) {
          this.appendOutput(decoder.end()); decoder = new StringDecoder('utf8');
          this.appendOutput('[Earlier output exceeds broker retention; check executor artifacts for retained history.]\n'); offset = job.logStart;
        }
        const bytes = Buffer.from(job.log, 'base64').subarray(Math.max(0, offset - job.logStart));
        this.appendOutput(decoder.write(bytes));
        offset = job.logEnd;
        if (terminalJob(job.status)) {
          this.appendOutput(decoder.end());
          this.appendOutput(`\nStatus: ${job.status}${job.exitCode === undefined ? '' : ` • exit ${job.exitCode}`}${job.failureReason ? ` • ${job.failureReason}` : ''}\n`);
          this.refresh(); return;
        }
      } catch (error) {
        if (this.disposed || generation !== this.logGeneration) return;
        if (error instanceof VpsHttpError && [401, 403, 404].includes(error.status)) {
          this.appendOutput(error.status === 404 ? '[Job not found on this VPS. Refresh VPS Jobs.]\n'
            : '[VPS access denied. Use Connect to VPS to update your credentials.]\n');
          this.logTimer = undefined;
          return;
        }
        if (!unavailable) this.appendOutput('[Observation unavailable; reconnecting to the same job. Loss of observation does not confirm execution stopped.]\n');
        unavailable = true;
      }
      if (!this.disposed && generation === this.logGeneration) {
        this.logTimer = setTimeout(() => { void poll(); }, 2000);
        this.logTimer.unref();
      }
    };
    await poll();
  }

  private stopWatching(): void {
    this.logGeneration++;
    if (this.logTimer) clearTimeout(this.logTimer);
    this.logTimer = undefined;
  }
}
