import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { SessionRuntime, SessionSnapshot } from '../runtime/session';

interface DashboardState {
  live: boolean;
  isHost?: boolean;
  recent?: Array<{ name: string; folder: string; at: number }>;
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
  }>;
  autosave?: {
    folder: string;
    copies: number;
    retention: number;
  };
  network?: { direct: number; down: number; up: number; address: string };
  compute?: { name: string; cpu: string; execution: string; python: string; kernel: string; device: string };
  cursors?: { share: boolean; remote: boolean; names: boolean; color: string };
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
  private timer: NodeJS.Timeout | undefined;
  private messageSubscription: vscode.Disposable | undefined;
  private lastState: DashboardState = { live: false };

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log?: vscode.OutputChannel,
  ) {}

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      enableCommandUris: ['pairNotebook.startSession', 'pairNotebook.joinSession'],
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

  public dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.messageSubscription?.dispose();
    this.messageSubscription = undefined;
  }

  private push(force = false): void {
    if (!this.view) return;
    const next = this.runtime ? toDashboardState(this.runtime.snapshot(), this.runtime.localComputePresence()) : {
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
  start: 'pairNotebook.startSession',
  join: 'pairNotebook.joinSession',
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
  hardware: 'pairNotebook.refreshHardware',
  recent: 'pairNotebook.openRecentProject',
  cursorShare: 'pairNotebook.toggleShareMyCursor',
  cursors: 'pairNotebook.toggleRemoteCursors',
  cursorNames: 'pairNotebook.toggleRemoteCursorNames',
  cursorPeople: 'pairNotebook.manageParticipantCursors',
  cursorColor: 'pairNotebook.changeMyCursorColor',
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
  const configuredColor = vscode.workspace.getConfiguration('pairNotebook').get<string>('myCursorColor', '#4FC3F7');
  const connection = buildConnectionView(snapshot);
  return {
    live: true,
    isHost: snapshot.isHost,
    projectName: snapshot.descriptor.projectName,
    mode: snapshot.descriptor.mode === 'resilient' ? 'Закреплённый хост' : 'Только хост',
    durationSeconds: Math.floor((Date.now() - snapshot.startedAt) / 1000),
    hostName: host?.peer.displayName ?? snapshot.peers.find((peer) => peer.peerId === snapshot.clock.hostId)?.displayName ?? 'Недоступно',
    participants: snapshot.peers.map((peer) => {
      const state = presence.get(peer.peerId);
      const gpu = state?.hardware?.gpus[0];
      const resources = state?.resources;
      return {
        id: peer.peerId,
        name: state?.peer.displayName ?? peer.displayName,
        role: `${peer.peerId === snapshot.clock.hostId ? '👑 ХОСТ ' : ''}${peer.peerId === snapshot.computeExecutorId ? '⚡ ВЫЧИСЛЕНИЯ' : ''}`.trim(),
        active: state?.activeFile
          ? `${state.activeFile}${state.activeNotebookCell !== undefined ? ` • ячейка ${state.activeNotebookCell + 1}` : ''}`
          : 'Нет активного файла',
        latency: peer.latency,
        hardware: gpu
          ? `${gpu.model} • ${(gpu.vramMb / 1024).toFixed(0)} GB`
          : state?.hardware?.cpuModel ?? 'Ожидание данных об устройстве',
        load: resources
          ? `CPU ${resources.cpuPercent.toFixed(0)}%${resources.gpus[0] ? ` • GPU ${resources.gpus[0].utilizationPercent}%` : ''}`
          : '',
        online: peer.online,
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
    cursors: {
      share: vscode.workspace.getConfiguration('pairNotebook').get<boolean>('shareMyCursor', true),
      remote: vscode.workspace.getConfiguration('pairNotebook').get<boolean>('showRemoteCursors', true),
      names: vscode.workspace.getConfiguration('pairNotebook').get<boolean>('showRemoteCursorNames', true),
      color: /^#[0-9a-f]{6}$/i.test(configuredColor) ? configuredColor : '#4FC3F7',
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

function dashboardRecentProjects(value: unknown): Array<{ name: string; folder: string; at: number }> {
  if (!Array.isArray(value)) return [];
  const result: Array<{ name: string; folder: string; at: number }> = [];
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 256
      || typeof raw.workingFolder !== 'string' || !raw.workingFolder.trim() || raw.workingFolder.length > 4096
      || !Number.isSafeInteger(raw.at) || Number(raw.at) < 0) continue;
    result.push({ name: raw.name, folder: raw.workingFolder, at: Number(raw.at) });
  }
  return result;
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
    .button-label { flex: 0 0 auto; }
    .button-value { flex: 1 1 auto; font-size: 9px; font-weight: 700; letter-spacing: .04em; color: var(--vscode-descriptionForeground); }
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
    .badge { flex: none; border: 1px solid var(--vscode-widget-border); border-radius: 999px; padding: 2px 7px; color: var(--vscode-textLink-foreground); font-size: 10px; font-weight: 600; }
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
    .actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(136px, 100%), 1fr)); gap: 5px; }
    .actions .wide { grid-column: 1 / -1; }
    .action-tooltip { position: relative; display: flex; min-width: 0; }
    .action-tooltip > button { width: 100%; }
    .action-tooltip::after { content: attr(data-tooltip); position: absolute; z-index: 1000; left: 0; bottom: calc(100% + 6px); width: max-content; max-width: calc(100vw - 32px); box-sizing: border-box; border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-widget-border)); border-radius: 4px; padding: 5px 7px; color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground)); background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background)); box-shadow: 0 2px 8px var(--vscode-widget-shadow); font-size: 11px; line-height: 1.35; overflow-wrap: anywhere; white-space: normal; pointer-events: none; opacity: 0; visibility: hidden; transform: translateY(2px); transition: opacity .08s ease, transform .08s ease, visibility .08s; }
    .action-tooltip:hover::after, .action-tooltip:focus::after, .action-tooltip:focus-within::after { opacity: 1; visibility: visible; transform: translateY(0); }
    .color-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 5px; vertical-align: -1px; border: 1px solid var(--vscode-contrastBorder, transparent); }
    details { margin-top: 10px; border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border)); border-radius: 6px; padding: 7px; }
    summary { color: var(--vscode-foreground); cursor: pointer; font-size: 11px; font-weight: 600; user-select: none; }
    .danger { color: var(--vscode-errorForeground) !important; }
  </style>
</head>
<body>
  <h1>PAIR NOTEBOOK</h1>
  <main id="content">
    <p class="hero">Совместная работа с Jupyter и кодом через защищённое P2P-подключение.</p>
    <div class="actions"><a class="fallback-button" href="command:pairNotebook.startSession">Начать сессию</a><a class="fallback-button" href="command:pairNotebook.joinSession">Подключиться</a></div>
    <p class="tiny">Если интерактивная панель не загрузится, эти две команды всё равно работают.</p>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = { live: false };
    const command = (name) => vscode.postMessage({ command: name });
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const duration = (seconds) => [Math.floor(seconds/3600), Math.floor(seconds/60)%60, seconds%60].map(x => String(x).padStart(2,'0')).join(':');
    const bytes = (value) => value < 1024 ? value + ' B/s' : (value/1024).toFixed(1) + ' KB/s';
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
    const toggle = (id, pressed, label) => '<button id="'+id+'" class="secondary toggle" aria-pressed="'+Boolean(pressed)+'" title="'+esc(label+': '+(pressed?'включено':'выключено'))+'"><span class="button-label">'+esc(label)+'</span>'+value(pressed?'ВКЛ':'ВЫКЛ',Boolean(pressed))+'</button>';
    const action = (id, label, current, options={}) => {
      const fullLabel = String(options.title || (current ? label+': '+current : label));
      const classes = (options.secondary===false?'':'secondary')+(options.danger?' danger':'')+(options.wide?' wide':'')+(options.path?' path-action':'');
      const button = '<button id="'+id+'" class="'+classes+'" '+(options.disabled?'disabled ':'')+(options.tooltip?'':'title="'+esc(fullLabel)+'" ')+'aria-label="'+esc(fullLabel)+'"><span class="button-label">'+esc(label)+'</span>'+(current?value(current):'')+'</button>';
      if (!options.tooltip) return button;
      return '<span id="'+id+'Tooltip" class="action-tooltip'+(options.wide?' wide':'')+'" data-tooltip="'+esc(fullLabel)+'"'+(options.disabled?' tabindex="0" role="group" aria-label="'+esc(fullLabel)+'"':'')+'>'+button+'</span>';
    };
    const section = (id, title, content, className='') => '<section class="section '+className+'" aria-labelledby="'+id+'Title"><h2 id="'+id+'Title">'+esc(title)+'</h2><div class="section-content">'+content+'</div></section>';
    const connection = () => {
      if (state.closed) return { className:'offline', text:'○ СЕССИЯ ЗАВЕРШЕНА' };
      if (state.runtimeState === 'host-unavailable') return { className:'offline', text:'○ ХОСТ НЕДОСТУПЕН' };
      if (state.waitingForHostFolder) return { className:'pending', text:'Ⅱ ПАУЗА • ОЖИДАНИЕ ПАПКИ ХОСТА' };
      if (state.runtimeState === 'connecting') return { className:'pending', text:'◐ ПОДКЛЮЧЕНИЕ' };
      if (state.runtimeState === 'reconnecting') return { className:'pending', text:'◐ ПЕРЕПОДКЛЮЧЕНИЕ' };
      if (['executor-unavailable','kernel-failed','file-synchronization-failed'].includes(state.runtimeState)) return { className:'pending', text:'● В СЕТИ • ЕСТЬ ПРОБЛЕМА' };
      return { className:'online', text:'● В СЕТИ' };
    };
    function render() {
      const root = document.getElementById('content');
      if (!state.live) {
        const recent = (state.recent || []).map(item => '<div class="card"><strong>'+esc(item.name)+'</strong><div class="tiny">'+esc(item.folder)+'</div></div>').join('');
        root.innerHTML = '<p class="hero">Совместная работа с Jupyter и кодом с задержкой, близкой к сетевой.</p><div class="actions"><button id="start">Начать сессию</button><button id="join" class="secondary">Подключиться</button></div>'+(recent?'<h2>НЕДАВНИЕ ПРОЕКТЫ</h2>'+recent+'<button id="recent" class="secondary">Открыть недавний</button>':'');
        document.getElementById('start').onclick = () => command('start');
        document.getElementById('join').onclick = () => command('join');
        if (document.getElementById('recent')) document.getElementById('recent').onclick = () => command('recent');
        return;
      }
      const detailsOpen = document.getElementById('moreActions')?.open ?? false;
      const focusedId = document.activeElement?.id || '';
      const onlineParticipants = (state.participants || []).filter(p => p.online);
      const people = onlineParticipants.map(p => '<div class="card participant"><div class="row"><strong>🟢 '+esc(p.name)+'</strong><span>'+ (p.latency >= 0 ? p.latency+' мс' : '—') +'</span></div>'+(p.role?'<div class="role">'+esc(p.role)+'</div>':'')+'<div class="tiny">'+esc(p.active)+'</div><div class="tiny">'+esc(p.hardware)+'</div><div class="tiny">'+esc(p.load)+'</div></div>').join('') || '<div class="tiny">Нет подключённых участников</div>';
      const connectionState = connection();
      const conn = state.connection;
      const remoteStatusLines = { 'checking-better-route': 'проверяет лучший маршрут…', 'switching-path': 'переключает сетевой путь…', 'switched-path': 'сменил(а) сетевой путь' };
      const upgradeLines = { requesting: 'Проверяем возможность прямого соединения…', 'waiting-peer': 'Согласуем проверку нового маршрута…', authenticating: 'Проверяем новое соединение…', verifying: 'Проверяем стабильность прямого канала…', promoting: 'Переключаемся на лучшее соединение…', completed: 'Соединение улучшено', failed: 'Улучшить не удалось — текущее соединение сохранено' };
      let connCard = '<div class="tiny">Нет подключённых участников</div>';
      if (conn && conn.peers.length) {
        const rows = conn.peers.map(p => {
          const cls = p.quality === 'good' ? 'q-good' : p.quality === 'degraded' ? 'q-degraded' : 'q-unknown';
          const routeLabel = p.routeType === 'direct' ? 'Прямой P2P · WebRTC' : 'Резервный шифрованный релей';
          const rtt = p.latencyMs >= 0 ? ' · ' + p.latencyMs + ' мс' : '';
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
        const improveBtn = action('improve', 'Попробовать улучшить', conn.optimizing ? 'ПРОВЕРЯЕМ…' : 'ЗАПУСТИТЬ', { disabled: conn.optimizing, secondary: true, wide: true, title: 'Текущее соединение не будет разорвано: новый путь проверяется параллельно' });
        connCard = '<div class="card">' + rows + '<div class="tiny ' + assessmentCls + '">' + esc(conn.assessment) + '</div>' + improveBtn + '</div>';
      }
      const statusCard = '<div class="card"><strong>'+esc(stateNames[state.runtimeState]||state.runtimeState)+'</strong><div class="tiny">'+esc(state.runtimeDetail)+'</div></div>';
      const hostCard = '<div class="card"><strong>👑 '+esc(state.hostName)+'</strong></div>';
      const computeCard = '<div class="card"><div class="row"><strong>🖥 '+esc(state.compute?.name)+'</strong><span class="badge">'+esc(state.compute?.device)+'</span></div><div class="tiny">'+esc(state.compute?.cpu)+'</div><div class="tiny">'+esc(state.compute?.execution)+'</div><div class="tiny">Python '+esc(state.compute?.python)+' • '+esc(kernelNames[state.compute?.kernel]||state.compute?.kernel)+'</div></div>';
      const networkCard = '<div class="card"><div class="row"><span>Прямые P2P-подключения</span><span>'+esc(state.network?.direct)+'</span></div><div class="row"><span>↓ '+bytes(state.network?.down||0)+'</span><span>↑ '+bytes(state.network?.up||0)+'</span></div><div class="tiny">'+esc(state.network?.address)+'</div></div>';
      const cursorActions = '<div class="actions">'+toggle('cursorShare',state.cursors?.share,'Мой курсор')+toggle('cursors',state.cursors?.remote,'Чужие курсоры')+toggle('cursorNames',state.cursors?.names,'Имена')+action('cursorColor','Цвет',colorName(state.cursors?.color),{title:'Текущий цвет: '+colorName(state.cursors?.color)+' ('+state.cursors?.color+')'})+action('cursorPeople','Участники','НАСТРОИТЬ')+'</div>';
      const autosaveFolder = state.autosave?.folder || 'Папка не выбрана';
      const paused = Boolean(state.waitingForHostFolder);
      const quickActions = '<div class="actions">'+action('invite','Приглашение',state.isHost?'КОПИРОВАТЬ':'ТОЛЬКО ХОСТ',{secondary:false,disabled:!state.isHost||paused})+action('compute','⚙ Вычисления',state.isHost?state.compute?.device:'ТОЛЬКО ХОСТ',{disabled:!state.isHost||paused})+action('flush','Сохранить',state.isHost?'ХОСТ':'ТОЛЬКО ХОСТ',{disabled:!state.isHost||paused})+action('autosaveNow','Автосейв',state.isHost?(state.autosave?.copies||0)+'/'+(state.autosave?.retention||3):'ТОЛЬКО ХОСТ',{disabled:!state.isHost||paused})+action('autosaveFolder','Папка автосейвов',autosaveFolder,{disabled:!state.isHost||paused,title:'Папка автосейвов: '+autosaveFolder,tooltip:true,wide:true,path:true})+'</div>';
      const transferAction = state.isHost && paused ? '' : action('transfer','Передать хоста',state.hostName,{disabled:!state.isHost});
      const endAction = state.isHost && !paused ? action('end','Завершить сессию','ДЛЯ ВСЕХ',{danger:true,title:'Завершить сессию для всех участников'}) : '';
      const pauseAction = paused && state.isHost ? '<div class="actions">'+action('backingFolder','Настроить папку нового хоста','ПРОДОЛЖИТЬ',{secondary:false,wide:true})+action('transfer','Передать хоста','ДРУГОМУ УЧАСТНИКУ',{secondary:true,wide:true})+action('end','Завершить сессию','БЕЗ НОВОЙ ПАПКИ',{danger:true,wide:true,title:'Завершить сессию и сохранить состояние в локальных рабочих копиях'})+'</div>' : '';
      const pauseNotice = paused ? '<div class="card"><strong>Совместная сессия приостановлена</strong><div class="tiny">'+esc(state.isHost?'Настройте общую папку, передайте роль хоста или завершите сессию. Отменённый выбор папки можно открыть снова.':'Новый хост выбирает папку, передаёт роль или завершает сессию. Дождитесь его решения.')+'</div>'+pauseAction+'</div>' : '';
      root.innerHTML = '<div class="connection '+connectionState.className+'">'+esc(connectionState.text)+'</div><div class="titleline"><div class="title">'+esc(state.projectName)+'</div><span class="badge" title="Режим сессии">'+esc(state.mode)+'</span></div><div class="muted">'+duration(state.durationSeconds||0)+'</div>'+pauseNotice+
        section('connectionSection','СОЕДИНЕНИЕ',connCard,'section-connection')+
        section('status','СОСТОЯНИЕ',statusCard)+
        section('host','ХОСТ СЕССИИ',hostCard)+
        section('participants','УЧАСТНИКИ В СЕТИ: '+onlineParticipants.length,people,'section-participants')+
        section('compute','ВЫЧИСЛЕНИЯ',computeCard,'section-compute')+
        section('network','СЕТЬ',networkCard)+
        section('cursorsSection','КУРСОРЫ',cursorActions)+
        section('quickActions','БЫСТРЫЕ ДЕЙСТВИЯ',quickActions)+
        '<details id="moreActions"'+(detailsOpen?' open':'')+'><summary id="moreActionsSummary">Дополнительные действия</summary><div class="actions">'+transferAction+action('diagnostics','Диагностика','ОТКРЫТЬ')+action('advancedDiag','Расширенная диагностика','ЗАПУСТИТЬ',{secondary:true,title:'Пассивная проверка сети: адаптеры (VPN/TUN), DNS, прокси, TURN-транспорты. Только чтение; права администратора не требуются и ничего в системе не изменяется.'})+action('leave','Покинуть сессию','ВЫЙТИ',{danger:true,disabled:paused&&state.isHost})+endAction+'</div></details>';
      for (const name of ['backingFolder','invite','compute','flush','autosaveNow','autosaveFolder','transfer','diagnostics','leave','end','improve','advancedDiag','cursorShare','cursors','cursorNames','cursorPeople','cursorColor']) {
        const button = document.getElementById(name);
        if (button && !button.disabled) button.onclick = () => command(name);
      }
      if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
    }
    window.addEventListener('message', event => {
      const message = event.data;
      if (!message || typeof message !== 'object' || message.type !== 'state' || !message.patch || typeof message.patch !== 'object') return;
      state = message.replace ? message.patch : Object.assign({}, state, message.patch);
      render();
    });
    try {
      render();
      command('webviewReady');
    } catch (error) {
      document.getElementById('content').innerHTML = '<div class="card danger"><strong>Панель не загрузилась</strong><div class="tiny">'+esc(error?.message||error)+'</div></div>';
      vscode.postMessage({ command:'webviewError', detail:String(error?.stack||error) });
    }
  </script>
</body>
</html>`;
}

function randomNonce(): string {
  return randomBytes(24).toString('base64url');
}
