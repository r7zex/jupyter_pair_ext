import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import * as vscode from 'vscode';
import type { SessionRuntime } from '../runtime/session';
import type { VpsRelayConnection } from '../runtime/vpsFrameRelay';
import { VpsClient } from '../vps/client';
import { type JobSubmission, type VpsAgent, type VpsDevice,
  MAX_JOB_BYTES, MAX_JOB_FILES, normalizeVpsUrl, safeJobPath, terminalJob, validateSubmission, vpsSecretKey } from '../vps/protocol';

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

  public constructor(private readonly context: vscode.ExtensionContext, private readonly currentRuntime: () => SessionRuntime | undefined) {
    this.view = vscode.window.createTreeView('pairNotebook.vpsCompute', { treeDataProvider: this });
    this.refreshTimer = setInterval(() => { if (this.view.visible) this.refresh(); }, 10_000);
    this.refreshTimer.unref();
  }
  public dispose(): void {
    this.disposed = true;
    this.logGeneration++;
    clearInterval(this.refreshTimer);
    if (this.logTimer) clearTimeout(this.logTimer);
    this.changed.dispose();
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
      if (item.group === 'agents') return (await client.agents()).map((agent) => {
        const result = new ComputeItem(agent.name);
        result.description = `${agent.online ? 'online' : 'offline'} • ${agent.resources.cpuCount} CPUs • ${agent.resources.gpus.length} GPUs`;
        result.tooltip = `${agent.id}\nPython: ${agent.resources.python}\n${agent.resources.gpus.map((gpu) => `${gpu.name} (${gpu.memoryMb} MB)`).join('\n')}`;
        result.iconPath = new vscode.ThemeIcon(agent.online ? 'vm-active' : 'vm-outline');
        result.command = { command: 'pairNotebook.runVpsJob', title: 'Run on this machine', arguments: [agent.id] };
        return result;
      });
      return (await client.jobs()).slice(0, 100).map((job) => {
        const result = new ComputeItem(job.title);
        result.id = job.id;
        result.description = `${job.status}${job.cancelRequested && !terminalJob(job.status) ? ' • cancellation requested' : ''} • ${job.agentId} • ${job.device}`;
        result.tooltip = `Job: ${job.id}\n${new Date(job.createdAt).toLocaleString()}\nClick to watch output`;
        result.iconPath = new vscode.ThemeIcon(job.status === 'running' ? 'sync~spin' : job.status === 'succeeded' ? 'pass' : 'tasklist');
        result.command = { command: 'pairNotebook.showVpsJob', title: 'Show job output', arguments: [job.id] };
        return result;
      });
    } catch {
      const retry = new ComputeItem('VPS unavailable — click to retry');
      retry.command = { command: 'pairNotebook.refreshVpsJobs', title: 'Retry VPS connection' };
      return [retry];
    }
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
    await configuration.update('vpsUrl', url, vscode.ConfigurationTarget.Global);
    this.refresh();
    void vscode.window.showInformationMessage('VPS connected. Start or rejoin a P2P session to use its relay. Background jobs are available immediately.');
  }

  public async submit(preferredAgent?: string): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before submitting Python for remote execution.');
    const client = await this.client();
    const pending = this.context.globalState.get<{ endpoint: string; id: string }>('pairNotebook.pendingVpsJob');
    if (pending?.endpoint === client.endpoint) {
      // Resolve an earlier ambiguous submission before allowing a fresh training run.
      const existing = (await client.jobs()).find((job) => job.id === pending.id);
      await this.context.globalState.update('pairNotebook.pendingVpsJob', undefined);
      if (existing) { await this.showJob(existing.id); return; }
    }
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
    const job = validateSubmission({ id: randomUUID(), agentId: selected.agent.id, device: selected.device,
      title: path.basename(input.entrypoint).slice(0, 200), ...input, args: [] });
    await this.context.globalState.update('pairNotebook.pendingVpsJob', { endpoint: client.endpoint, id: job.id });
    try { await client.submit(job); }
    catch { throw new Error(`Could not confirm job ${job.id}. Open VPS Jobs to check it; the next submission will reconcile this request first.`); }
    await this.context.globalState.update('pairNotebook.pendingVpsJob', undefined);
    this.refresh();
    void vscode.window.showInformationMessage('Background job submitted. It will keep running when you close VS Code or switch off this computer.');
    await this.showJob(job.id);
  }

  private target(agent: VpsAgent, device: VpsDevice, detail?: string): vscode.QuickPickItem & { agent: VpsAgent; device: VpsDevice } {
    return { label: `${agent.name} • ${device === 'cpu' ? 'CPU' : `GPU ${device.slice(4)}`}`,
      description: `${agent.online ? 'online' : 'offline — queue for later'} • ${agent.id}`, detail: detail ?? `${agent.resources.cpuCount} CPU threads`, agent, device };
  }

  private async sourceSnapshot(): Promise<Pick<JobSubmission, 'entrypoint' | 'files'> | undefined> {
    const active = this.currentRuntime();
    const files: Record<string, string> = Object.create(null) as Record<string, string>;
    let sourceBytes = 0;
    // Only Python sources are sent; existing PC datasets and credentials are never uploaded automatically.
    if (active) for (const key of active.project.keys()) {
      if (key.endsWith('.py') && safeJobPath(key) && active.project.kindOf(key) === 'text') {
        const text = active.project.text(key);
        if (text.length > MAX_JOB_BYTES || Object.keys(files).length >= MAX_JOB_FILES) throw new Error('Python source snapshot is too large for a background job.');
        const value = text.toString();
        sourceBytes += Buffer.byteLength(value);
        if (sourceBytes > MAX_JOB_BYTES) throw new Error('Python source snapshot is too large for a background job.');
        files[key] = value;
      }
    }
    const notebook = vscode.window.activeNotebookEditor;
    const editor = vscode.window.activeTextEditor;
    const uri = notebook?.notebook.uri ?? editor?.document.uri;
    if (!uri) throw new Error('Open a Python file or notebook to submit a background job.');
    let entrypoint = active ? path.relative(active.descriptor.workingFolder, uri.fsPath).split(path.sep).join('/') : path.basename(uri.fsPath);
    if (!safeJobPath(entrypoint)) throw new Error('The active file must be inside the current collaborative project.');
    if (notebook) {
      const scope = await vscode.window.showQuickPick([
        { label: 'Whole notebook', description: 'Python cells in a fresh process', value: 'all' },
        { label: 'Active cell', description: 'Fresh process; existing kernel variables are unavailable', value: 'cell' },
      ], { title: 'Run notebook in background' });
      if (!scope) return undefined;
      const cells = scope.value === 'all' ? notebook.notebook.getCells() : [notebook.notebook.cellAt(notebook.selection.start)];
      const python = cells.filter((cell) => cell.kind === vscode.NotebookCellKind.Code && cell.document.languageId === 'python');
      if (!python.length) throw new Error('No Python code cells selected.');
      const code = python.map((cell) => cell.document.getText()).join('\n\n');
      entrypoint = entrypoint.replace(/\.ipynb$/i, '') + '.pair-job.py';
      files[entrypoint] = code;
    } else {
      if (!editor || !entrypoint.endsWith('.py')) throw new Error('Open a .py file or a Python notebook.');
      files[entrypoint] = editor.document.getText();
    }
    return { entrypoint, files };
  }

  public async showJobs(): Promise<void> {
    const jobs = await (await this.client()).jobs();
    const selected = await vscode.window.showQuickPick(jobs.map((job) => ({ label: job.title,
      description: `${job.status} • ${job.agentId} • ${job.device}`, detail: job.id, job })), { title: 'Shared VPS jobs' });
    if (!selected) return;
    await this.showJob(selected.job.id);
  }

  public async cancel(): Promise<void> {
    const client = await this.client();
    const selected = await vscode.window.showQuickPick((await client.jobs()).filter((job) => !terminalJob(job.status)).map((job) => ({
      label: job.title, description: `${job.status} • ${job.agentId}`, detail: job.id, job,
    })), { title: 'Cancel background job' });
    if (!selected) return;
    if (await vscode.window.showWarningMessage(`Cancel ${selected.job.title}?`, { modal: true }, 'Cancel job') !== 'Cancel job') return;
    await client.cancel(selected.job.id);
    this.refresh();
    void vscode.window.showInformationMessage('Cancellation requested. A disconnected agent will receive it when its connection returns.');
  }

  public async showJob(id: string): Promise<void> {
    const client = await this.client();
    const generation = ++this.logGeneration;
    if (this.logTimer) clearTimeout(this.logTimer);
    this.output.clear();
    this.output.show(true);
    let offset = 0;
    let headerShown = false;
    let unavailable = false;
    const decoder = new StringDecoder('utf8');
    const poll = async (): Promise<void> => {
      try {
        const job = await client.job(id, offset);
        if (this.disposed || generation !== this.logGeneration) return;
        if (!headerShown) { this.output.appendLine(`${job.title} • ${job.agentId} • ${job.device}\nJob: ${job.id}`); headerShown = true; }
        unavailable = false;
        if (offset < job.logStart) { this.output.appendLine('[Earlier output is retained only on the compute machine.]'); offset = job.logStart; }
        const bytes = Buffer.from(job.log, 'base64').subarray(Math.max(0, offset - job.logStart));
        this.output.append(decoder.write(bytes));
        offset = job.logEnd;
        if (terminalJob(job.status)) {
          this.output.append(decoder.end());
          this.output.appendLine(`\nStatus: ${job.status}${job.exitCode === undefined ? '' : ` • exit ${job.exitCode}`}`);
          this.refresh(); return;
        }
      } catch {
        if (this.disposed || generation !== this.logGeneration) return;
        if (!unavailable) this.output.appendLine('[VPS unavailable; reconnecting. Running jobs continue on their compute machines.]');
        unavailable = true;
      }
      if (!this.disposed && generation === this.logGeneration) {
        this.logTimer = setTimeout(() => { void poll(); }, 2000);
        this.logTimer.unref();
      }
    };
    await poll();
  }
}
