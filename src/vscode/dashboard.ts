import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { normalizeRecentProjects, presentRecentExit } from '../core/recentProjects';
import { SessionRuntime, SessionSnapshot } from '../runtime/session';
import type { ServerSessionView } from './serverSessionView';

interface DashboardState {
  live: boolean;
  persistent?: ServerSessionView & { endpoint?: string; connected?: boolean; connectedAt?: number };
  isHost?: boolean;
  recent?: Array<{
    name: string;
    folder: string;
    hostName: string;
    relativeExit: string;
    exitDate: string;
  }>;
  projectName?: string;
  mode?: string;
  durationSeconds?: number;
  hostName?: string;
  participants?: Array<{
    id: string;
    name: string;
    role: string;
    active: string;
    latency: number;
    hardware: string;
    load: string;
    online: boolean;
    connectionState?: 'connected' | 'recovering' | 'disconnected';
  }>;
  autosave?: {
    folder: string;
    copies: number;
    retention: number;
  };
  network?: { direct: number; down: number; up: number; address: string };
  compute?: { name: string; cpu: string; execution: string; python: string; kernel: string; device: string };
  closed?: boolean;
  runtimeState?: string;
  runtimeDetail?: string;
  waitingForHostFolder?: boolean;
  /** Connection-quality section rendered at the top of the sidebar. */
  connection?: DashboardConnection;
}

export interface DashboardConnection {
  peers: Array<{
    id: string;
    name: string;
    routeType: 'direct' | 'relay';
    latencyMs: number;
    quality: 'good' | 'degraded' | 'unknown';
    upgradeStatus?: string;
    remoteStatus?: string;
  }>;
  optimizing: boolean;
  statusLine?: string;
  assessment: string;
  canImprove: boolean;
}

export class DashboardProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private runtime: SessionRuntime | undefined;
  private persistent: DashboardState['persistent'];
  private timer: NodeJS.Timeout | undefined;
  private messageSubscription: vscode.Disposable | undefined;
  private lastState: DashboardState = { live: false };

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log?: vscode.OutputChannel,
    private readonly sessionPassword: () => Promise<string | undefined> = async () => undefined,
  ) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      enableCommandUris: ['pairNotebook.startSession', 'pairNotebook.joinSession', 'pairNotebook.createVpsSession', 'pairNotebook.joinVpsSession', 'pairNotebook.configureVpsSessions'],
      localResourceRoots: [],
    };
    this.messageSubscription?.dispose();
    this.messageSubscription = view.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      const raw = message as Record<string, unknown>;
      const requested = typeof raw.command === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(raw.command)
        ? raw.command
        : '';
      if (requested === 'webviewReady') {
        this.push(true);
        return;
      }
      if (requested === 'revealVpsPassword') {
        const session = this.persistent;
        if (!session || session.connected === false) return;
        this.runBackground('Reveal session password', async () => {
          let password: string | undefined;
          try { password = await this.sessionPassword(); }
          catch { void vscode.window.showErrorMessage('Could not load the saved session password. Reconnect or ask the owner to set a new password.'); }
          if (this.persistent?.id !== session.id || this.persistent?.memberId !== session.memberId || this.persistent?.endpoint !== session.endpoint) return;
          await this.view?.webview.postMessage({ type: 'sessionPassword', sessionId: session.id, memberId: session.memberId, value: password });
        });
        return;
      }
      if (requested === 'webviewError') {
        const detail = typeof raw.detail === 'string' ? raw.detail.slice(0, 2048) : 'unknown error';
        this.runBackground('Panel error notification', () => vscode.window.showErrorMessage(
          `Pair Notebook panel error: ${detail}`,
        ));
        return;
      }
      const command = Object.hasOwn(commandMap, requested) ? commandMap[requested] : undefined;
      if (command) this.runBackground(`Dashboard command ${command}`, () => vscode.commands.executeCommand(command));
    });
    // Register the receiver before assigning HTML. A fast webview can execute
    // and post its ready handshake immediately after the assignment.
    view.webview.html = html();
    this.push(true);
  }

  public setRuntime(runtime: SessionRuntime | undefined): void {
    this.runtime = runtime;
    this.lastState = { live: false };
    if (this.timer) clearInterval(this.timer);
    this.timer = runtime ? setInterval(() => this.push(), 1000) : undefined;
    this.timer?.unref?.();
    this.push(true);
  }

  public reveal(): void {
    this.view?.show?.(true);
  }

  public setPersistentSession(view: ServerSessionView | undefined, endpoint?: string, connected = true): void {
    const same = view && this.persistent?.id === view.id && this.persistent?.memberId === view.memberId && this.persistent?.endpoint === endpoint;
    this.persistent = view ? { ...view, connected, connectedAt: (same ? this.persistent?.connectedAt : undefined) ?? Date.now(), ...(endpoint ? { endpoint } : {}) } : undefined;
    this.push(true);
  }

  public refresh(): void {
    this.push(true);
  }

  public dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.messageSubscription?.dispose();
    this.messageSubscription = undefined;
  }

  private push(force = false): void {
    if (!this.view) return;
    const next = this.persistent ? { live: true, persistent: this.persistent } : this.runtime ? toDashboardState(this.runtime.snapshot(), this.runtime.localComputePresence()) : {
      live: false,
      recent: dashboardRecentProjects(this.context.globalState.get<unknown>('pairNotebook.recent', [])),
    };
    const patch = force ? next : diff(this.lastState, next);
    this.lastState = next;
    if (force || Object.keys(patch).length) {
      this.runBackground('Dashboard state update', () => this.view?.webview.postMessage({
        type: 'state', patch, replace: force,
      }));
    }
  }

  private runBackground(label: string, action: () => unknown | PromiseLike<unknown>): void {
    try {
      void Promise.resolve(action()).catch((error) => {
        this.log?.appendLine(`[error] ${label}: ${formatError(error)}`);
      });
    } catch (error) {
      this.log?.appendLine(`[error] ${label}: ${formatError(error)}`);
    }
  }
}

const commandMap: Record<string, string> = {
  createVps: 'pairNotebook.createVpsSession',
  joinVps: 'pairNotebook.joinVpsSession',
  manageVps: 'pairNotebook.manageVpsSession',
  leaveVps: 'pairNotebook.leaveVpsSession',
  computeVps: 'pairNotebook.selectVpsCompute',
  shareVps: 'pairNotebook.shareVpsComputer',
  uploadVps: 'pairNotebook.uploadVpsFolder',
  restartVps: 'pairNotebook.restartVpsKernel',
  recoverVps: 'pairNotebook.recoverVpsExecution',
  copyVpsPassword: 'pairNotebook.copyVpsSessionPassword',
  changeVpsPassword: 'pairNotebook.changeVpsSessionPassword',
  inviteVps: 'pairNotebook.copyVpsInvitation',
  saveVps: 'pairNotebook.saveVpsFiles',
  start: 'pairNotebook.startSession',
  join: 'pairNotebook.joinSession',
  vps: 'pairNotebook.configureVpsSessions',
  invite: 'pairNotebook.copyInvite',
  leave: 'pairNotebook.leaveSession',
  end: 'pairNotebook.endSession',
  transfer: 'pairNotebook.transferHost',
  diagnostics: 'pairNotebook.showDiagnostics',
  advancedDiag: 'pairNotebook.showAdvancedDiagnostics',
  improve: 'pairNotebook.tryImproveConnection',
  flush: 'pairNotebook.flush',
  autosaveFolder: 'pairNotebook.selectAutosaveFolder',
  autosaveNow: 'pairNotebook.createAutosave',
  backingFolder: 'pairNotebook.selectBackingFolder',
  compute: 'pairNotebook.changeCompute',
  shell: 'pairNotebook.openSharedTerminal',
  permissions: 'pairNotebook.managePermissions',
  hardware: 'pairNotebook.refreshHardware',
  recent: 'pairNotebook.openRecentProject',
};

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toDashboardState(snapshot: SessionSnapshot, localPresence?: ReturnType<SessionRuntime['localComputePresence']>): DashboardState {
  const presence = new Map(snapshot.awareness.map((state) => [state.peer.peerId, state]));
  if (localPresence) presence.set(localPresence.peer.peerId, localPresence);
  const host = presence.get(snapshot.clock.hostId);
  const compute = presence.get(snapshot.computeExecutorId);
  const computePeer = snapshot.peers.find((peer) => peer.peerId === snapshot.computeExecutorId);
  const computeName = compute?.peer.displayName ?? computePeer?.displayName ?? snapshot.computeExecutorId;
  const autosaveFolder = host?.autosaveFolder
    ?? (snapshot.isHost ? snapshot.autosave.folder : 'Локально на компьютере хоста');
  const gpuIndex = snapshot.computeDevice.startsWith('gpu:')
    ? Number(snapshot.computeDevice.slice(4))
    : undefined;
  const selectedGpu = gpuIndex !== undefined
    ? compute?.hardware?.gpus.find((gpu) => gpu.index === gpuIndex)
    : undefined;
  const connection = buildConnectionView(snapshot);
  return {
    live: true,
    isHost: snapshot.isHost,
    projectName: snapshot.descriptor.projectName,
    mode: snapshot.descriptor.mode === 'resilient' ? 'Persistent host' : 'Host only',
    durationSeconds: Math.floor((Date.now() - snapshot.startedAt) / 1000),
    hostName: host?.peer.displayName ?? snapshot.peers.find((peer) => peer.peerId === snapshot.clock.hostId)?.displayName ?? 'Unavailable',
    participants: snapshot.peers.map((peer) => {
      const state = presence.get(peer.peerId);
      const gpu = state?.hardware?.gpus[0];
      const resources = state?.resources;
      return {
        id: peer.peerId,
        name: state?.peer.displayName ?? peer.displayName,
        role: `${peer.peerId === snapshot.clock.hostId ? '👑 HOST ' : ''}${peer.peerId === snapshot.computeExecutorId ? '⚡ COMPUTE' : ''}`.trim(),
        active: state?.activeFile
          ? `${state.activeFile}${state.activeNotebookCell !== undefined ? ` • ячейка ${state.activeNotebookCell + 1}` : ''}`
          : 'No active file',
        latency: peer.connectionState === 'recovering' ? -1 : peer.latency,
        hardware: gpu
          ? `${gpu.model} • ${(gpu.vramMb / 1024).toFixed(0)} GB`
          : state?.hardware?.cpuModel ?? 'Ожидание данных об устройстве',
        load: resources
          ? `CPU ${resources.cpuPercent.toFixed(0)}%${resources.gpus[0] ? ` • GPU ${resources.gpus[0].utilizationPercent}%` : ''}`
          : '',
        online: peer.online,
        ...(peer.connectionState ? { connectionState: peer.connectionState } : {}),
      };
    }),
    autosave: {
      folder: autosaveFolder,
      copies: snapshot.autosave.copies,
      retention: snapshot.autosave.retention,
    },
    network: {
      direct: snapshot.metrics.directPeers,
      down: snapshot.metrics.bytesReceivedPerSecond,
      up: snapshot.metrics.bytesSentPerSecond,
      address: 'Trystero • Nostr discovery',
    },
    compute: {
      name: computeName,
      cpu: compute?.hardware?.cpuModel ?? 'Определение…',
      execution: snapshot.computeDevice === 'cpu'
        ? `Выполнение на CPU у ${computeName}`
        : selectedGpu
          ? `Выполнение на GPU у ${computeName}: ${selectedGpu.model} • ${(selectedGpu.vramMb / 1024).toFixed(1)} GB • CUDA device ${selectedGpu.index}`
          : `Выполнение на GPU ${gpuIndex ?? ''} у ${computeName} • данные устройства недоступны`,
      python: compute?.hardware?.python.version ?? 'неизвестно',
      kernel: snapshot.kernelStatus,
      device: snapshot.computeDevice === 'cpu' ? 'CPU' : `GPU ${gpuIndex ?? ''}`.trim(),
    },
    closed: snapshot.closed,
    runtimeState: snapshot.runtimeState,
    runtimeDetail: snapshot.runtimeDetail,
    waitingForHostFolder: snapshot.waitingForHostFolder,
    ...(connection !== undefined ? { connection } : {}),
  };
}

const UPGRADE_STATUS_LINES: Record<string, string> = {
  requesting: '↻ Проверяем возможность прямого соединения…',
  'waiting-peer': '↻ Согласуем проверку нового маршрута…',
  authenticating: '↻ Проверяем новое соединение…',
  verifying: '↻ Проверяем стабильность прямого канала…',
  promoting: '↻ Переключаемся на лучшее соединение…',
  completed: '✓ Соединение улучшено',
};

/**
 * Evidence-based assessment for the sidebar. A relay route means direct ICE
 * previously failed, so a better path MAY exist - phrased as possibility,
 * never as certainty. Direct routes are reported as optimal without
 * speculative claims.
 */
function buildConnectionView(snapshot: SessionSnapshot): DashboardConnection | undefined {
  const connections = (snapshot as unknown as { connections?: Array<import('../runtime/session').PeerConnectionView> }).connections;
  if (!connections) return undefined;
  const peers = connections.map((connection) => ({
    id: connection.peerId,
    name: connection.displayName,
    routeType: connection.routeType,
    latencyMs: connection.latencyMs,
    quality: connection.routeType === 'direct'
      ? (connection.latencyMs >= 0 && connection.latencyMs <= 120 ? 'good' as const : 'unknown' as const)
      : 'degraded' as const,
    ...(connection.upgradeStatus ? { upgradeStatus: connection.upgradeStatus } : {}),
    ...(connection.remoteStatus ? { remoteStatus: connection.remoteStatus } : {}),
  }));
  const optimizing = peers.some((peer) => peer.upgradeStatus
    && !['completed', 'failed'].includes(peer.upgradeStatus));
  const activeUpgrade = connections.find((connection) => connection.upgradeStatus);
  const statusLine = optimizing && activeUpgrade?.upgradeStatus
    ? UPGRADE_STATUS_LINES[activeUpgrade.upgradeStatus]
    : undefined;
  const relayPeer = peers.find((peer) => peer.routeType === 'relay');
  let assessment: string;
  if (optimizing) assessment = 'Текущее соединение продолжает работать';
  else if (relayPeer) assessment = 'Возможно доступно более прямое соединение';
  else if (peers.length === 0) assessment = '';
  else assessment = '✓ Соединение уже оптимально';
  return {
    peers,
    optimizing,
    ...(statusLine ? { statusLine } : {}),
    assessment,
    canImprove: Boolean(relayPeer) || optimizing,
  };
}

function dashboardRecentProjects(value: unknown): NonNullable<DashboardState['recent']> {
  return normalizeRecentProjects(value).map((item) => {
    const exit = presentRecentExit(item.leftAt);
    return {
      name: item.name,
      folder: item.workingFolder,
      hostName: item.hostDisplayName,
      relativeExit: exit.relative,
      exitDate: exit.date,
    };
  });
}

function diff(previous: DashboardState, next: DashboardState): Partial<DashboardState> {
  const patch: Partial<DashboardState> = {};
  for (const key of Object.keys(next) as Array<keyof DashboardState>) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) {
      (patch as Record<string, unknown>)[key] = next[key];
    }
  }
  return patch;
}

function html(): string {
  const nonce = randomNonce();
  const csp = `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';`;
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    body { padding: 8px; color: var(--vscode-foreground); font: 12px var(--vscode-font-family); }
    h1 { font-size: 12px; letter-spacing: .08em; margin: 0 0 10px; }
    h2 { color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground)); font-size: 11px; letter-spacing: .08em; margin: 0; }
    .hero { color: var(--vscode-descriptionForeground); line-height: 1.4; margin: 0 0 10px; }
    button, a.fallback-button { min-width: 0; min-height: 30px; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); padding: 4px 7px; cursor: pointer; font: 11px/1.2 var(--vscode-font-family); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-decoration: none; }
    button:hover, a.fallback-button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
    button:disabled { cursor: default; opacity: .55; }
    button:focus-visible, summary:focus-visible, .action-tooltip:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    button.toggle[aria-pressed="true"] { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    button.toggle::before { content: '○'; }
    button.toggle[aria-pressed="true"]::before { content: '●'; color: var(--vscode-testing-iconPassed); }
    .button-label, .button-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .button-label { flex: 1 1 auto; text-align: left; }
    .button-value { flex: 0 1 auto; text-align: right; font-size: 9px; font-weight: 700; letter-spacing: .04em; color: var(--vscode-descriptionForeground); }
    .path-action .button-value { text-align: left; direction: ltr; }
    .path-action:disabled { opacity: .8; }
    .button-value.on { color: var(--vscode-testing-iconPassed); }
    .button-value.off { color: var(--vscode-errorForeground); }
    .connection { font-weight: 700; letter-spacing: .04em; }
    .connection.online { color: var(--vscode-testing-iconPassed); }
    .connection.pending { color: var(--vscode-editorWarning-foreground); }
    .connection.offline { color: var(--vscode-errorForeground); }
    .titleline { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin: 4px 0; }
    .title { font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
    .badge { flex: none; border: 0; padding: 0; color: var(--vscode-button-background); font-size: 11px; font-weight: 600; }
    .muted { color: var(--vscode-descriptionForeground); }
    .section { position: relative; overflow: visible; border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); border-radius: 6px; margin: 10px 0; background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background)); }
    .section > h2 { padding: 7px 8px; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editorWidget-background)); }
    .section-content { padding: 7px; }
    .section-connection { border-left: 3px solid var(--vscode-charts-green, var(--vscode-testing-iconPassed)); }
    .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; display: inline-block; }
    .q-good { background: var(--vscode-charts-green, #89d185); }
    .q-degraded { background: var(--vscode-charts-orange, #d18616); }
    .q-unknown { background: var(--vscode-descriptionForeground); opacity: .7; }
    .q-warn { color: var(--vscode-editorWarning-foreground); }
    .q-ok { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
    .section-participants { border-left: 3px solid var(--vscode-charts-blue, var(--vscode-focusBorder)); }
    .section-compute { border-left: 3px solid var(--vscode-charts-yellow, var(--vscode-editorWarning-foreground)); }
    .card { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 4px; margin: 4px 0; padding: 7px; background: var(--vscode-sideBar-background); }
    .row { display: flex; justify-content: space-between; gap: 6px; margin: 2px 0; }
    .role { color: var(--vscode-textLink-foreground); font-size: 11px; }
    .tiny { color: var(--vscode-descriptionForeground); font-size: 11px; overflow-wrap: anywhere; }
    .actions { display: grid; grid-template-columns: 1fr; gap: 5px; }
    .actions .wide { grid-column: 1 / -1; }
    .action-tooltip { position: relative; display: flex; min-width: 0; }
    .action-tooltip > button { width: 100%; }
    .action-tooltip::after { content: attr(data-tooltip); position: absolute; z-index: 1000; left: 0; bottom: calc(100% + 6px); width: max-content; max-width: calc(100vw - 32px); box-sizing: border-box; border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border)); border-radius: 4px; padding: 5px 7px; color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground)); background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background)); box-shadow: 0 2px 8px var(--vscode-widget-shadow); font-size: 11px; line-height: 1.35; overflow-wrap: anywhere; white-space: normal; pointer-events: none; opacity: 0; visibility: hidden; transform: translateY(2px); transition: opacity .08s ease, transform .08s ease, visibility .08s; }
    .action-tooltip:hover::after, .action-tooltip:focus::after, .action-tooltip:focus-within::after { opacity: 1; visibility: visible; transform: translateY(0); }
    .color-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 5px; vertical-align: -1px; border: 1px solid var(--vscode-contrastBorder, transparent); }
    details { margin-top: 10px; border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); border-radius: 6px; padding: 7px; }
    summary { color: var(--vscode-foreground); cursor: pointer; font-size: 11px; font-weight: 600; user-select: none; }
    .password-row { margin-top: 9px; }
    .password-row input { min-width: 0; width: 100%; border: 1px solid var(--vscode-input-border, transparent); color: var(--vscode-input-foreground); background: var(--vscode-input-background); padding: 4px 6px; box-sizing: border-box; }
    .icon-button { flex: none; padding: 4px 6px; }
    .endpoint { overflow-wrap: anywhere; margin-bottom: 7px; }
    .danger { color: var(--vscode-errorForeground) !important; }
  </style>
</head>
<body>
  <h1>PAIR NOTEBOOK</h1>
  <main id="content">
    <p class="hero">Collaborate on notebooks and code in encrypted sessions.</p>
    <div class="actions"><a class="fallback-button" href="command:pairNotebook.startSession">Start self-host session</a><a class="fallback-button" href="command:pairNotebook.joinSession">Join self-host session</a><a class="fallback-button" href="command:pairNotebook.createVpsSession">Create server project</a><a class="fallback-button" href="command:pairNotebook.joinVpsSession">Connect to server</a><a class="fallback-button" href="command:pairNotebook.configureVpsSessions">Saved connections</a></div>
    <p class="tiny">These commands also work if the interactive panel cannot load.</p>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = { live: false };
    let revealedPassword;
    let passwordIdentity = '';
    let passwordRequested = false;
    const command = (name) => vscode.postMessage({ command: name });
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const duration = (seconds) => [Math.floor(seconds/3600), Math.floor(seconds/60)%60, seconds%60].map(x => String(x).padStart(2,'0')).join(':');
    const bytes = (value) => value < 1024 ? Math.round(value) + ' B/s' : (value/1024).toFixed(1) + ' KB/s';
    const qualityLabel = (quality) => quality === 'good' ? 'хорошее соединение' : quality === 'degraded' ? 'резервное соединение' : 'качество определяется';
    const stateNames = { connecting:'Подключение', connected:'Подключено', syncing:'Синхронизация', ready:'Готово', executing:'Выполнение', 'waiting-for-stdin':'Ожидание ввода', reconnecting:'Переподключение', 'host-unavailable':'Хост недоступен', 'executor-unavailable':'Вычислитель недоступен', 'waiting-for-host-folder':'Пауза: нужна папка нового хоста', 'kernel-starting':'Запуск ядра', 'kernel-failed':'Ошибка ядра', 'file-synchronization-failed':'Ошибка синхронизации файлов' };
    const kernelNames = { Idle:'ожидает', Busy:'занято', Offline:'выключено' };
    const palette = [['красный','#F44336'],['оранжевый','#FF9800'],['жёлтый','#FFEB3B'],['зелёный','#4CAF50'],['голубой','#4FC3F7'],['синий','#2196F3'],['фиолетовый','#9C27B0'],['розовый','#E91E63'],['белый','#FFFFFF'],['серый','#9E9E9E']];
    const rgb = (hex) => [1,3,5].map(i => Number.parseInt(String(hex||'#4FC3F7').slice(i,i+2),16));
    const colorName = (hex) => {
      const current = rgb(hex);
      return palette.map(item => ({ name:item[0], distance:rgb(item[1]).reduce((sum,part,index) => sum + (part-current[index])**2,0) })).sort((a,b) => a.distance-b.distance)[0].name;
    };
    const value = (text, enabled) => '<span class="button-value '+(enabled===true?'on':enabled===false?'off':'')+'">'+esc(text)+'</span>';
    const toggle = (id, pressed, label) => '<button id="'+id+'" class="secondary toggle" aria-pressed="'+Boolean(pressed)+'" title="'+esc(label+': '+(pressed?'включено':'выключено'))+'"><span class="button-label">'+esc(label)+'</span>'+value(pressed?'ON':'OFF',Boolean(pressed))+'</button>';
    const action = (id, label, current, options={}) => {
      const fullLabel = String(options.title || (current ? label+': '+current : label));
      const classes = (options.secondary===false?'':'secondary')+(options.danger?' danger':'')+(options.wide?' wide':'')+(options.path?' path-action':'');
      const button = '<button id="'+id+'" class="'+classes+'" '+(options.disabled?'disabled ':'')+(options.tooltip?'':'title="'+esc(fullLabel)+'" ')+'aria-label="'+esc(fullLabel)+'"><span class="button-label">'+esc(label)+'</span>'+(current?value(current):'')+'</button>';
      if (!options.tooltip) return button;
      return '<span id="'+id+'Tooltip" class="action-tooltip'+(options.wide?' wide':'')+'" data-tooltip="'+esc(fullLabel)+'"'+(options.disabled?' tabindex="0" role="group" aria-label="'+esc(fullLabel)+'"':'')+'>'+button+'</span>';
    };
    const section = (id, title, content, className='') => '<section class="section '+className+'" aria-labelledby="'+id+'Title"><h2 id="'+id+'Title">'+esc(title).toUpperCase()+'</h2><div class="section-content">'+content+'</div></section>';
    const eyeIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
    const eyeOffIcon = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m3 3 18 18M10 5c7-1 12 7 12 7s-2 4-6 6M6 6c-3 2-4 6-4 6s4 7 10 7h2"/></svg>';
    const sessionHeader = (status, label, name, mode) => '<div class="connection '+status+'">'+esc(label)+'</div><div class="titleline"><div class="title">'+esc(name)+'</div><span class="badge">'+esc(mode)+'</span></div>';
    const participantCard = (name, role, detail, extra) => '<div class="card participant"><div class="row"><strong>'+esc(name)+'</strong><span>'+esc(detail)+'</span></div>'+(role?'<div class="role">'+esc(role)+'</div>':'')+extra+'</div>';
    const computeSummary = (name, device, cpu, status, extra) => '<div class="card"><div class="row"><strong>'+esc(name)+'</strong><span class="badge">'+esc(device)+'</span></div><div class="tiny">'+esc(cpu)+'</div><div class="tiny">'+esc(status)+'</div>'+extra+'</div>';
    const connection = () => {
      if (state.closed) return { className:'offline', text:'○ SESSION ENDED' };
      if (state.runtimeState === 'host-unavailable') return { className:'offline', text:'○ HOST OFFLINE' };
      if (state.waitingForHostFolder) return { className:'pending', text:'Ⅱ ПАУЗА • ОЖИДАНИЕ ПАПКИ ХОСТА' };
      if (state.runtimeState === 'connecting') return { className:'pending', text:'◐ CONNECTING' };
      if (state.runtimeState === 'reconnecting') return { className:'pending', text:'◐ RECONNECTING' };
      if (['executor-unavailable','kernel-failed','file-synchronization-failed'].includes(state.runtimeState)) return { className:'pending', text:'● ONLINE • NEEDS ATTENTION' };
      return { className:'online', text:'● ONLINE' };
    };
    function render() {
      const root = document.getElementById('content');
      if (!state.live) {
        const recent = (state.recent || []).map(item => '<div class="card"><strong>Session: '+esc(item.name)+'</strong><div>Host: '+esc(item.hostName)+'</div><div class="tiny">Left '+esc(item.relativeExit)+' • '+esc(item.exitDate)+'</div><div class="tiny">'+esc(item.folder)+'</div></div>').join('');
        root.innerHTML = '<p class="hero">Collaborate on notebooks and code in encrypted sessions.</p><div class="actions"><button id="start">Start self-host session</button><button id="join" class="secondary">Join self-host session</button><button id="createVps" class="secondary">Create server project</button><button id="joinVps" class="secondary">Connect to server</button><button id="vps" class="secondary">Saved connections</button></div>'+(recent?'<h2>RECENT PROJECTS</h2>'+recent+'<button id="recent" class="secondary">Open recent</button>':'');
        document.getElementById('start').onclick = () => command('start');
        document.getElementById('join').onclick = () => command('join');
        document.getElementById('vps').onclick = () => command('vps');
        document.getElementById('createVps').onclick = () => command('createVps');
        document.getElementById('joinVps').onclick = () => command('joinVps');
        if (document.getElementById('recent')) document.getElementById('recent').onclick = () => command('recent');
        return;
      }
      if (state.persistent) {
        const session = state.persistent;
        const target = session.devices.find(device => device.id === (session.activeKernel?.deviceId || session.target.deviceId));
        const owner = session.members.find(member => member.id === session.ownerId);
        const own = session.memberId === session.ownerId;
        const identity = [session.endpoint, session.id, session.memberId].join('|');
        if (passwordIdentity !== identity || session.connected === false) { revealedPassword = undefined; passwordRequested = false; passwordIdentity = identity; }
        const detailsOpen = document.getElementById('moreActions')?.open ?? false;
        const online = session.members.filter(member => member.online);
        const people = online.map(member => participantCard('🟢 '+member.name, (member.id === session.ownerId ? '👑 OWNER' : member.role === 'admin' ? 'ADMINISTRATOR' : 'PARTICIPANT')+(member.id === session.memberId ? ' · YOU' : ''), '', '<div class="tiny">'+esc(member.id === session.memberId && session.activeKernel ? session.activeKernel.notebook : '')+'</div>')).join('') || '<div class="tiny">No participants online</div>';
        const kernel = session.activeKernel;
        const scope = kernel?.scope === 'private' ? 'Private' : 'Shared';
        const password = '<div class="password-row"><span class="tiny">Session password</span><div class="row"><input id="sessionPassword" readonly aria-label="Session password" type="'+(revealedPassword === undefined ? 'password' : 'text')+'" value="'+esc(revealedPassword === undefined ? '************' : revealedPassword)+'" /><button id="togglePassword" class="secondary icon-button" aria-label="'+(revealedPassword === undefined ? 'Show password' : 'Hide password')+'" title="'+(revealedPassword === undefined ? 'Show password' : 'Hide password')+'">'+(revealedPassword === undefined ? eyeIcon : eyeOffIcon)+'</button>'+(revealedPassword === undefined ? '' : action('copyVpsPassword','Copy',''))+'</div></div>';
        const connectionCard = '<div class="card"><div class="tiny">Server address</div><div class="endpoint">'+esc(session.endpoint)+'</div><div class="row"><span>Owner</span><strong>'+esc(owner?.name || 'Unknown')+(own ? ' (you)' : '')+'</strong></div>'+password+'</div>';
        const hostCard = '<div class="card"><strong>🖥 VPS</strong><div class="tiny">Owner: '+esc(owner?.name || 'Unknown')+(own ? ' · You' : '')+'</div></div>';
        const kernelDetail = kernel ? '<div class="row"><span>'+scope+' kernel</span><strong>'+esc(kernel.notebook)+'</strong></div><div class="tiny">'+(kernel.scope === 'private' ? 'Only the project owner can access this kernel and its results.' : 'Everyone with access to this notebook shares its Python variables and results.')+'</div>' : '<div class="tiny">Open a notebook in this server project to select its kernel.</div>';
        const gpuUuid = kernel ? kernel.gpuUuid : session.target.gpuUuid;
        const computeCard = computeSummary(target?.name || session.target.deviceId, gpuUuid ? 'GPU' : 'CPU', target?.cpu || '', target?.online ? 'Online' : 'Offline', kernelDetail);
        const networkCard = '<div class="card"><div class="row"><span>Server response</span><span>'+esc(session.network?.latencyMs === undefined ? '—' : session.network.latencyMs+' ms')+'</span></div><div class="row"><span>↓ '+bytes(session.network?.down || 0)+'</span><span>↑ '+bytes(session.network?.up || 0)+'</span></div><div class="tiny">HTTPS · VPS payload traffic</div></div>';
        const controls = (own ? action('inviteVps','Invitation','COPY',{secondary:false}) : '')+action('computeVps','Compute',gpuUuid ? 'GPU' : 'CPU')+action('restartVps','Restart '+scope.toLowerCase()+' kernel','RESTART',{disabled:!kernel?.canRestart || session.connected === false,title:kernel ? 'Restart '+scope.toLowerCase()+' kernel for '+kernel.notebook+'; clear Python variables' : 'Open a server notebook first'})+action('saveVps','Save','VPS')+(own ? action('uploadVps','Upload files','UPLOAD') : '');
        root.innerHTML = sessionHeader(session.connected === false ? 'pending' : session.state === 'running' ? 'online' : 'offline', session.connected === false ? '◐ RECONNECTING' : session.state === 'running' ? '● ONLINE' : '○ STOPPED', session.name, 'Persistent host')+'<div class="muted">'+duration(Math.max(0,Math.floor((Date.now()-(session.connectedAt || Date.now()))/1000)))+'</div>'+
          section('connectionSection','Connection',connectionCard,'section-connection')+
          section('host','Session host',hostCard)+
          section('participants','Participants online: '+online.length,people,'section-participants')+
          section('compute','Compute',computeCard,'section-compute')+
          section('network','Network',networkCard)+
          section('quickActions','Quick actions','<div class="actions">'+controls+'</div>')+
          '<details id="moreActions"'+(detailsOpen?' open':'')+'><summary>More actions</summary><div class="actions">'+action('manageVps','Manage session','MANAGE')+(own ? action('permissions','Participant permissions','CONFIGURE')+action('changeVpsPassword','Session password','CHANGE') : '')+action('shareVps','My computer','CONFIGURE')+action('recoverVps','Recover interrupted run','RECOVER',{title:'Restore an interrupted execution into its notebook cells'})+action('leaveVps','Leave session','LEAVE',{danger:true})+'</div></details>';
        document.getElementById('togglePassword').onclick = () => {
          if (revealedPassword !== undefined || passwordRequested) { revealedPassword = undefined; passwordRequested = false; render(); }
          else { passwordRequested = true; command('revealVpsPassword'); }
        };
        for (const name of ['computeVps','shareVps','manageVps','uploadVps','permissions','restartVps','recoverVps','leaveVps','copyVpsPassword','changeVpsPassword','inviteVps','saveVps']) {
          const button = document.getElementById(name); if (button && !button.disabled) button.onclick = () => command(name);
        }
        return;
      }
      const detailsOpen = document.getElementById('moreActions')?.open ?? false;
      const focusedId = document.activeElement?.id || '';
      const visibleParticipants = (state.participants || []).filter(p => p.online || p.connectionState === 'recovering');
      const onlineParticipants = visibleParticipants.filter(p => p.online);
      const people = visibleParticipants.map(p => {
        const recovering = p.connectionState === 'recovering';
        const indicator = recovering ? '🟡' : '🟢';
        const stateLine = recovering ? '<div class="tiny q-warn">↻ Reconnecting</div>' : '';
        const latency = recovering || p.latency < 0 ? '—' : p.latency+' ms';
        return participantCard(indicator+' '+p.name,p.role,latency,stateLine+'<div class="tiny">'+esc(p.active)+'</div><div class="tiny">'+esc(p.hardware)+'</div><div class="tiny">'+esc(p.load)+'</div>');
      }).join('') || '<div class="tiny">No participants online</div>';
      const connectionState = connection();
      const conn = state.connection;
      const remoteStatusLines = { 'checking-better-route': 'проверяет лучший маршрут…', 'switching-path': 'переключает сетевой путь…', 'switched-path': 'сменил(а) сетевой путь' };
      const upgradeLines = { requesting: 'Проверяем возможность прямого соединения…', 'waiting-peer': 'Согласуем проверку нового маршрута…', authenticating: 'Проверяем новое соединение…', verifying: 'Проверяем стабильность прямого канала…', promoting: 'Переключаемся на лучшее соединение…', completed: 'Соединение улучшено', failed: 'Улучшить не удалось — текущее соединение сохранено' };
      let connCard = '<div class="tiny">No participants online</div>';
      if (conn && conn.peers.length) {
        const rows = conn.peers.map(p => {
          const cls = p.quality === 'good' ? 'q-good' : p.quality === 'degraded' ? 'q-degraded' : 'q-unknown';
          const routeLabel = p.routeType === 'direct' ? 'Прямой P2P · WebRTC' : 'Резервный шифрованный релей';
          const rtt = p.latencyMs >= 0 ? ' · ' + p.latencyMs + ' ms' : '';
          let line = '<div class="row"><span class="dot ' + cls + '" role="img" aria-label="' + esc(qualityLabel(p.quality)) + '"></span><strong>' + esc(p.name) + '</strong><span class="muted">' + esc(routeLabel) + esc(rtt) + '</span></div>';
          if (p.upgradeStatus && !['completed','failed'].includes(p.upgradeStatus)) {
            line += '<div class="tiny q-warn">↻ ' + esc(upgradeLines[p.upgradeStatus] || 'Проверяем лучший маршрут…') + ' Текущее соединение активно.</div>';
          } else if (p.upgradeStatus === 'failed') {
            line += '<div class="tiny q-warn">△ Улучшить не удалось — текущее соединение сохранено</div>';
          } else if (p.remoteStatus) {
            line += '<div class="tiny q-warn">' + esc(p.name) + ' ' + esc(remoteStatusLines[p.remoteStatus] || 'меняет соединение…') + '</div>';
          }
          return line;
        }).join('');
        const assessmentCls = conn.optimizing ? 'q-warn' : (conn.peers.some(p => p.routeType === 'relay') ? 'q-warn' : 'q-ok');
        const improveBtn = action('improve', 'Попробовать улучшить', conn.optimizing ? 'ПРОВЕРЯЕМ…' : 'RUN', { disabled: conn.optimizing, secondary: true, wide: true, title: 'Текущее соединение не будет разорвано: новый путь проверяется параллельно' });
        connCard = '<div class="card">' + rows + '<div class="tiny ' + assessmentCls + '">' + esc(conn.assessment) + '</div>' + improveBtn + '</div>';
      }
      const statusCard = '<div class="card"><strong>'+esc(stateNames[state.runtimeState]||state.runtimeState)+'</strong><div class="tiny">'+esc(state.runtimeDetail)+'</div></div>';
      const hostCard = '<div class="card"><strong>👑 '+esc(state.hostName)+'</strong></div>';
      const computeCard = computeSummary(state.compute?.name,state.compute?.device,state.compute?.cpu,state.compute?.execution,'<div class="tiny">Python '+esc(state.compute?.python)+' • '+esc(kernelNames[state.compute?.kernel]||state.compute?.kernel)+'</div>');
      const networkCard = '<div class="card"><div class="row"><span>Прямые P2P-подключения</span><span>'+esc(state.network?.direct)+'</span></div><div class="row"><span>↓ '+bytes(state.network?.down||0)+'</span><span>↑ '+bytes(state.network?.up||0)+'</span></div><div class="tiny">'+esc(state.network?.address)+'</div></div>';
      const autosaveFolder = state.autosave?.folder || 'No folder selected';
      const paused = Boolean(state.waitingForHostFolder);
      const quickActions = '<div class="actions">'+action('shell','Host terminal',state.isHost?'TYPE COMMANDS':'VIEW')+action('invite','Invitation',state.isHost?'COPY':'HOST ONLY',{secondary:false,disabled:!state.isHost||paused})+action('compute','Compute',state.isHost?state.compute?.device:'HOST ONLY',{disabled:!state.isHost||paused})+action('flush','Save',state.isHost?'ХОСТ':'HOST ONLY',{disabled:!state.isHost||paused})+action('autosaveNow','Autosave',state.isHost?(state.autosave?.copies||0)+'/'+(state.autosave?.retention||3):'HOST ONLY',{disabled:!state.isHost||paused})+action('autosaveFolder','Autosave folder',autosaveFolder,{disabled:!state.isHost||paused,title:'Autosave folder: '+autosaveFolder,tooltip:true,wide:true,path:true})+'</div>';
      const transferAction = state.isHost && paused ? '' : action('transfer','Transfer host',state.hostName,{disabled:!state.isHost});
      const endAction = state.isHost && !paused ? action('end','End session','FOR EVERYONE',{danger:true,title:'End session for everyone'}) : '';
      const pauseAction = paused && state.isHost ? '<div class="actions">'+action('backingFolder','Choose new host folder','CONTINUE',{secondary:false,wide:true})+action('transfer','Transfer host','TO ANOTHER PARTICIPANT',{secondary:true,wide:true})+action('end','End session','WITHOUT A NEW FOLDER',{danger:true,wide:true,title:'End session и сохранить состояние в локальных рабочих копиях'})+'</div>' : '';
      const pauseNotice = paused ? '<div class="card"><strong>Совместная сессия приостановлена</strong><div class="tiny">'+esc(state.isHost?'Настройте общую папку, передайте роль хоста или завершите сессию. Отменённый выбор папки можно открыть снова.':'Новый хост выбирает папку, передаёт роль или завершает сессию. Дождитесь его решения.')+'</div>'+pauseAction+'</div>' : '';
      root.innerHTML = sessionHeader(connectionState.className,connectionState.text,state.projectName,state.mode)+'<div class="muted">'+duration(state.durationSeconds||0)+'</div>'+pauseNotice+
        section('connectionSection','CONNECTION',connCard,'section-connection')+
        section('status','STATUS',statusCard)+
        section('host','SESSION HOST',hostCard)+
        section('participants','PARTICIPANTS ONLINE: '+onlineParticipants.length,people,'section-participants')+
        section('compute','COMPUTE',computeCard,'section-compute')+
        section('network','NETWORK',networkCard)+
        section('quickActions','QUICK ACTIONS',quickActions)+
        '<details id="moreActions"'+(detailsOpen?' open':'')+'><summary id="moreActionsSummary">More actions</summary><div class="actions">'+transferAction+action('permissions','Participant permissions','CONFIGURE',{disabled:!state.isHost})+action('diagnostics','Diagnostics','OPEN')+action('advancedDiag','Advanced diagnostics','RUN',{secondary:true,title:'Пассивная проверка сети: адаптеры (VPN/TUN), DNS, прокси, TURN-транспорты. Только чтение; права администратора не требуются и ничего в системе не изменяется.'})+action('leave','Leave session','LEAVE',{danger:true,disabled:paused&&state.isHost})+endAction+'</div></details>';
      for (const name of ['permissions','backingFolder','shell','invite','compute','flush','autosaveNow','autosaveFolder','transfer','diagnostics','leave','end','improve','advancedDiag']) {
        const button = document.getElementById(name);
        if (button && !button.disabled) button.onclick = () => command(name);
      }
      if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
    }
    window.addEventListener('message', event => {
      const message = event.data;
      if (!message || typeof message !== 'object') return;
      if (message.type === 'sessionPassword') {
        if (passwordRequested && message.sessionId === state.persistent?.id && message.memberId === state.persistent?.memberId) { revealedPassword = typeof message.value === 'string' ? message.value : undefined; passwordRequested = false; render(); }
        return;
      }
      if (message.type !== 'state' || !message.patch || typeof message.patch !== 'object') return;
      state = message.replace ? message.patch : Object.assign({}, state, message.patch);
      render();
    });
    try {
      render();
      command('webviewReady');
    } catch (error) {
      document.getElementById('content').innerHTML = '<div class="card danger"><strong>Panel could not load</strong><div class="tiny">'+esc(error?.message||error)+'</div></div>';
      vscode.postMessage({ command:'webviewError', detail:String(error?.stack||error) });
    }
  </script>
</body>
</html>`;
}

function randomNonce(): string {
  return randomBytes(24).toString('base64url');
}
