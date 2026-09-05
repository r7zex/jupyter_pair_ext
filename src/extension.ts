import { lstat, mkdir, open, rm } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { atomicWriteFile } from './core/atomicFile';
import { buildNetworkDiagnostics, type SignallingFamilyDiagnostic } from './runtime/diagnostics';
import { formatLifecycleDiagnostics, type LifecycleDiagnosticEvent } from './runtime/lifecycleDiagnostics';
import {
  generateIdentityCredentials,
  publicKeyFromPrivate,
  validateIdentityPrivateKey,
  validateIdentityPublicKey,
} from './core/identity';
import { discoverPythonEnvironments } from './core/pythonEnvironments';
import { copyProject } from './core/projectFiles';
import {
  accessibleRecentProjects,
  assertRecentReconnectMatchesDescriptor,
  clearRecentReconnect,
  forgetRecentProject,
  normalizeRecentProjects,
  recentProjectForFolder,
  reconnectIdentityFromDescriptor,
  rememberRecentProject,
} from './core/recentProjects';
import { SessionTerminatedError } from './core/sessionTermination';
import {
  InviteData,
  PeerIdentity,
  SessionDescriptor,
  cleanDisplayName,
  cleanProjectName,
  computeSelectionChanged,
  formatInvite,
  newId,
  newToken,
  normalizeDisplayName,
  parseInvite,
  validateDisplayName,
  validateProjectName,
} from './core/types';
import { SnapshotBootstrapError, downloadProjectSnapshot } from './runtime/bootstrap';
import { configureMeshNetwork } from './runtime/mesh';
import { EXPLICIT_PROXY_PASSWORD_ERROR, inspectExplicitProxyPassword } from './runtime/proxy';
import { BackingFolderMismatchError, SessionRuntime, SessionTerminalLifecycle } from './runtime/session';
import { readWindowsSystemProxy } from './runtime/systemProxy';
import { DashboardProvider } from './vscode/dashboard';
import { PresenceRenderer } from './vscode/presence';
import { statusBarTextForRuntimeState } from './vscode/connectionProgress';
import { EditorSynchronizer } from './vscode/sync';
import { PairNotebookController } from './vscode/jupyterController';
import { closeIsolatedPairTabs, type PairTabCloseResult } from './vscode/sessionTabs';
import {
  PROXY_CREDENTIAL_MIGRATION_KEY,
  PROXY_CREDENTIAL_MIGRATION_VERSION,
  migrateLegacyProxyPassword,
  readBoundProxyPassword,
  shouldMigrateLegacyProxyPassword,
  storeBoundProxyPassword,
} from './vscode/proxyCredentials';

const MARKER = '.pair-notebook-session.json';
const MAX_SESSION_MARKER_BYTES = 64 * 1024 * 1024;
const MAX_RESTORED_PEERS = 255;

let runtime: SessionRuntime | undefined;
let synchronizer: EditorSynchronizer | undefined;
let presence: PresenceRenderer | undefined;
let notebookController: PairNotebookController;
let dashboard: DashboardProvider;
let status: vscode.StatusBarItem;
let statusTimer: NodeJS.Timeout | undefined;
let output: vscode.OutputChannel;
let hostFolderPromptOpen = false;
let meshNetworkConfigurationGeneration = 0;
let automaticNetworkRecovery: Promise<void> | undefined;
let automaticNetworkRecoveryPending = false;
let observedSystemProxyFingerprint: string | undefined;
let systemProxyPollInFlight = false;
let lastLifecycleDiagnostics: LifecycleDiagnosticEvent[] = [];
let workspaceSessionRestore: Promise<void> | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  activationContext = context;
  output = vscode.window.createOutputChannel('Pair Notebook');
  const proxyMigrationPending = shouldMigrateLegacyProxyPassword(
    context.globalState.get<unknown>(PROXY_CREDENTIAL_MIGRATION_KEY),
  );
  await applyMeshNetworkConfiguration(context, { allowLegacyProxyMigration: proxyMigrationPending });
  if (proxyMigrationPending) {
    await context.globalState.update(PROXY_CREDENTIAL_MIGRATION_KEY, PROXY_CREDENTIAL_MIGRATION_VERSION);
  }
  dashboard = new DashboardProvider(context, output);
  notebookController = new PairNotebookController(output);
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 80);
  status.command = 'pairNotebook.openPanel';
  context.subscriptions.push(
    output,
    dashboard,
    notebookController,
    status,
    vscode.window.registerWebviewViewProvider('pairNotebook.dashboard', dashboard, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if ([
        'pairNotebook.proxyUrl',
        'pairNotebook.turnUrls',
        'pairNotebook.turnUsername',
        'http.proxy',
        'http.proxySupport',
        'http.noProxy',
      ].some((setting) => event.affectsConfiguration(setting))) {
        void applyMeshNetworkConfiguration(context).catch((error) => {
          const message = `Could not refresh network configuration: ${formatError(error)}`;
          output.appendLine(`[error] ${message}`);
          void vscode.window.showErrorMessage(`Pair Notebook: ${message}`);
        });
      }
    }),
  );
  if (process.platform === 'win32') {
    const proxyWatchTimer = setInterval(() => {
      void checkWindowsSystemProxyChange(context);
    }, 2_000);
    proxyWatchTimer.unref?.();
    context.subscriptions.push({ dispose: () => clearInterval(proxyWatchTimer) });
  }

  register(context, 'pairNotebook.startSession', () => startSession(context));
  register(context, 'pairNotebook.joinSession', () => joinSession(context));
  register(context, 'pairNotebook.leaveSession', () => leaveSession());
  register(context, 'pairNotebook.endSession', () => endSession());
  register(context, 'pairNotebook.copyInvite', () => copyInvite());
  register(context, 'pairNotebook.openPanel', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.pairNotebook');
    dashboard.reveal();
  });
  register(context, 'pairNotebook.transferHost', () => transferHost());
  register(context, 'pairNotebook.showDiagnostics', () => showDiagnostics());
  register(context, 'pairNotebook.tryImproveConnection', () => tryImproveConnection());
  register(context, 'pairNotebook.showAdvancedDiagnostics', () => showDiagnostics(true));
  register(context, 'pairNotebook.setTurnPassword', async () => {
    const password = await vscode.window.showInputBox({
      prompt: 'TURN password for the configured turnUrls (stored in VS Code secret storage, never in settings or logs)',
      password: true,
    });
    if (password === undefined) return;
    await context.secrets.store('pairNotebook.turnPassword', password);
    await applyMeshNetworkConfiguration(context);
    void vscode.window.showInformationMessage('Pair Notebook: TURN пароль сохранён в защищённом хранилище.');
  });
  register(context, 'pairNotebook.setProxyPassword', async () => {
    const password = await vscode.window.showInputBox({
      prompt: 'Password for pairNotebook.proxyUrl (bound to its endpoint and optional username; empty clears it)',
      password: true,
    });
    if (password === undefined) return;
    const configuration = vscode.workspace.getConfiguration('pairNotebook');
    const explicitProxy = configuration.get<string>('proxyUrl', '').trim();
    await storeBoundProxyPassword(context.secrets, explicitProxy, password);
    await applyMeshNetworkConfiguration(context);
    void vscode.window.showInformationMessage(password
      ? 'Pair Notebook: proxy password saved in VS Code SecretStorage.'
      : 'Pair Notebook: stored proxy password cleared.');
  });
  register(context, 'pairNotebook.selectBackingFolder', () => selectBackingFolder());
  register(context, 'pairNotebook.flush', async () => {
    await requireRuntime().saveAsHost();
    void vscode.window.showInformationMessage('Pair Notebook: проект сохранён хостом.');
  });
  register(context, 'pairNotebook.selectAutosaveFolder', () => selectAutosaveFolder());
  register(context, 'pairNotebook.createAutosave', () => createAutosave());
  register(context, 'pairNotebook.reconnect', async () => {
    await applyMeshNetworkConfiguration(context);
    const refreshed = await requireRuntime().reconnect();
    const requested = refreshed.nostr.requestedSockets + refreshed.mqtt.requestedSockets;
    const verified = refreshed.nostr.verifiedEndpoints + refreshed.mqtt.verifiedEndpoints;
    const detail = `${verified}/${requested} refreshed signalling endpoints verified; existing authenticated routes were kept.`;
    if (refreshed.status === 'timed-out') {
      void vscode.window.showWarningMessage(`Pair Notebook: signalling refresh timed out; ${detail}`);
    } else if (refreshed.status === 'partial') {
      void vscode.window.showWarningMessage(`Pair Notebook: signalling refresh was partial; ${detail}`);
    } else if (refreshed.status === 'verified') {
      void vscode.window.showInformationMessage(`Pair Notebook: signalling refresh verified; ${detail}`);
    } else {
      void vscode.window.showInformationMessage(
        'Pair Notebook: no live signalling socket required a forced refresh; remembered peers were reannounced.',
      );
    }
  });
  register(context, 'pairNotebook.changeCompute', () => changeCompute());
  register(context, 'pairNotebook.refreshHardware', async () => {
    await requireRuntime().refreshHardware();
    void vscode.window.showInformationMessage('Pair Notebook hardware capabilities refreshed.');
  });
  register(context, 'pairNotebook.showComputeResources', () => showComputeResources());
  register(context, 'pairNotebook.selectPythonEnvironment', () => selectPythonEnvironment());
  register(context, 'pairNotebook.runActiveCell', async () => notebookController.executeActive());
  register(context, 'pairNotebook.restartKernel', async () => notebookController.restartActive());
  register(context, 'pairNotebook.openRecentProject', () => openRecentProject(context));

  // A restored guest can legitimately wait for the host's first project state
  // for up to 45 seconds. Do not make VS Code wait for that network operation
  // before the dashboard and commands become available.
  startWorkspaceSessionRestore(context);
}

export function deactivate(): Thenable<void> | undefined {
  if (statusTimer) clearInterval(statusTimer);
  synchronizer?.dispose();
  presence?.dispose();
  notebookController?.dispose();
  return runtime?.leave();
}

async function startSession(context: vscode.ExtensionContext): Promise<void> {
  if (workspaceSessionRestore) {
    throw new Error('The existing Pair Notebook workspace session is still restoring. Wait for it to finish or report an error.');
  }
  if (runtime) throw new Error('A Pair Notebook session is already active in this window.');
  await applyMeshNetworkConfiguration(context);
  const localDisplayName = await promptDisplayName(
    displayName(),
    'Введите имя, которое увидят остальные участники.',
  );
  if (!localDisplayName) return;
  await vscode.workspace.getConfiguration('pairNotebook').update(
    'displayName',
    localDisplayName,
    vscode.ConfigurationTarget.Global,
  ).then(undefined, (error) => output.appendLine(`[error] Could not remember display name: ${formatError(error)}`));
  const chosen = await vscode.window.showOpenDialog({
    title: 'Select Shared Backing Folder',
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Use as backing folder',
  });
  if (!chosen?.[0]) return;
  const backingFolder = chosen[0].fsPath;
  const projectName = path.basename(backingFolder);
  const projectNameError = validateProjectName(projectName);
  if (projectNameError) throw new Error(`The selected folder name cannot be used as a project name: ${projectNameError}`);
  const sessionId = newId();
  const projectId = newId();
  const peerId = newId();
  const identity = generateIdentityCredentials();
  const workingFolder = sessionWorkingFolder(sessionId, peerId, context);
  try {
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Pair Notebook: creating isolated working copy',
      cancellable: false,
    }, async () => copyProject(backingFolder, workingFolder));
  } catch (error) {
    await rm(workingFolder, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  const localPeer: PeerIdentity = {
    peerId,
    displayName: localDisplayName,
    joinOrder: 0,
    identityKey: identity.publicKey,
  };
  const descriptor: SessionDescriptor = {
    sessionId,
    projectId,
    projectName: cleanProjectName(projectName),
    mode: 'resilient',
    role: 'host',
    localPeer,
    hostPeerId: peerId,
    backingFolder,
    workingFolder,
    createdAt: Date.now(),
    sessionEpoch: Date.now(),
    hostEpoch: 0,
    computeExecutorId: peerId,
    pythonPath: vscode.workspace.getConfiguration('pairNotebook').get<string>('pythonPath', 'python'),
    freshStart: true,
    knownPeers: [],
  };
  const token = newToken();
  try {
    await saveDescriptor(context, descriptor, token, identity.privateKey);
  } catch (error) {
    await rm(workingFolder, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  await rememberProject(context, descriptor).catch((error) => {
    output.appendLine(`[error] Could not update recent projects: ${formatError(error)}`);
  });
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(workingFolder), false);
}

async function joinSession(context: vscode.ExtensionContext): Promise<void> {
  if (workspaceSessionRestore) {
    throw new Error('The existing Pair Notebook workspace session is still restoring. Wait for it to finish or report an error.');
  }
  if (runtime) throw new Error('A Pair Notebook session is already active in this window.');
  await applyMeshNetworkConfiguration(context);
  const raw = await vscode.window.showInputBox({
    title: 'Join Pair Notebook Session',
    prompt: 'Paste the complete pair-notebook:// invite',
    ignoreFocusOut: true,
  });
  if (!raw) return;
  const invite = parseInvite(raw);
  let nickname = await promptDisplayName(
    displayName(),
    'Введите имя для этой совместной сессии. Имена участников не могут повторяться.',
  );
  if (!nickname) return;
  const peerId = newId();
  const identity = generateIdentityCredentials();
  const localPeer: PeerIdentity = {
    peerId,
    displayName: nickname,
    joinOrder: Date.now(),
    identityKey: identity.publicKey,
  };
  const workingFolder = sessionWorkingFolder(invite.sessionId, peerId, context);
  let lastCompletedFiles = 0;
  for (;;) {
    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Pair Notebook: receiving project snapshot',
        cancellable: false,
      }, async (progress) => downloadProjectSnapshot(invite, localPeer, workingFolder, (state) => {
        const completedDelta = Math.max(0, state.completedFiles - lastCompletedFiles);
        lastCompletedFiles = state.completedFiles;
        progress.report({
          ...(state.currentFile !== undefined ? { message: state.currentFile } : {}),
          ...(state.totalFiles ? { increment: completedDelta * 100 / state.totalFiles } : {}),
        });
      }, undefined, identity.privateKey));
      break;
    } catch (error) {
      if (!(error instanceof SnapshotBootstrapError) || error.kind !== 'display-name-conflict') {
        await rm(workingFolder, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      const replacement = await promptDisplayName(nickname, 'Этот никнейм уже занят подключённым участником.');
      if (!replacement) {
        await rm(workingFolder, { recursive: true, force: true }).catch(() => undefined);
        return;
      }
      nickname = replacement;
      localPeer.displayName = replacement;
    }
  }
  await vscode.workspace.getConfiguration('pairNotebook').update(
    'displayName',
    localPeer.displayName,
    vscode.ConfigurationTarget.Global,
  ).then(undefined, (error) => output.appendLine(`[error] Could not remember display name: ${formatError(error)}`));
  const descriptor: SessionDescriptor = {
    sessionId: invite.sessionId,
    projectId: invite.projectId,
    projectName: invite.projectName,
    // Keep the legacy wire value for compatible invites. Runtime authority is
    // pinned to the host until that host explicitly transfers it.
    mode: 'resilient',
    role: 'peer',
    localPeer,
    hostPeerId: invite.hostPeerId,
    backingFolder: '',
    workingFolder,
    createdAt: Date.now(),
    sessionEpoch: invite.sessionEpoch,
    hostEpoch: invite.hostEpoch ?? 0,
    computeExecutorId: invite.hostPeerId,
    pythonPath: vscode.workspace.getConfiguration('pairNotebook').get<string>('pythonPath', 'python'),
    freshStart: false,
    knownPeers: [{
      peerId: invite.hostPeerId,
      displayName: invite.hostDisplayName,
      joinOrder: 0,
      identityKey: invite.hostIdentityKey,
    }],
  };
  try {
    await saveDescriptor(context, descriptor, invite.token, identity.privateKey);
  } catch (error) {
    await rm(workingFolder, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  await rememberProject(context, descriptor).catch((error) => {
    output.appendLine(`[error] Could not update recent projects: ${formatError(error)}`);
  });
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(workingFolder), false);
}

async function restoreWorkspaceSession(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const marker = path.join(folder.uri.fsPath, MARKER);
  let descriptor: SessionDescriptor;
  try {
    const markerBytes = await readBoundedRegularFile(marker, MAX_SESSION_MARKER_BYTES);
    descriptor = normalizeSessionDescriptor(JSON.parse(markerBytes.toString('utf8')), folder.uri.fsPath);
    if (descriptor.role === 'peer') {
      const reconnectIdentity = reconnectIdentityFromDescriptor(descriptor);
      if (!reconnectIdentity) {
        throw new Error('Stored guest session has no authenticated pinned host identity; rejoin using a fresh invite.');
      }
      const recent = normalizeRecentProjects(context.globalState.get<unknown>('pairNotebook.recent', []));
      const remembered = recentProjectForFolder(recent, descriptor.workingFolder);
      if (remembered?.reconnect) assertRecentReconnectMatchesDescriptor(remembered.reconnect, descriptor);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      output.appendLine(`[error] Invalid session marker: ${formatError(error)}`);
      void vscode.window.showErrorMessage(`Pair Notebook session marker is invalid: ${formatError(error)}`);
    }
    return;
  }
  let storedSecret: StoredSessionSecret | undefined;
  try {
    storedSecret = await descriptorSecret(context, descriptor);
  } catch (error) {
    output.appendLine(`[error] Could not read session credentials: ${formatError(error)}`);
    void vscode.window.showErrorMessage(
      `Pair Notebook could not read this session from VS Code SecretStorage: ${formatError(error)}`,
    );
    return;
  }
  if (!storedSecret) {
    void vscode.window.showErrorMessage('Pair Notebook session token is unavailable. Rejoin using a fresh invite.');
    return;
  }
  try {
    const identityPrivateKey = await ensureDescriptorIdentity(context, descriptor, storedSecret);
    output.appendLine(`[info] Starting session ${descriptor.sessionId} in ${descriptor.mode} mode.`);
    runtime = new SessionRuntime(descriptor, storedSecret.token, context, output, identityPrivateKey);
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Pair Notebook: connecting to session',
      cancellable: false,
    }, async () => runtime!.start());
    synchronizer = new EditorSynchronizer(
      runtime.project,
      descriptor.workingFolder,
      output,
      runtime.notebookCellIds,
      notebookController,
      (key, cellId, changes, canonicalSource) => runtime?.lineLockMessage(
        key,
        cellId,
        changes,
        canonicalSource,
      ),
    );
    runtime.setWorkingCopyWriter(
      (relativePath, bytes) => synchronizer?.persistWorkingCopy(relativePath, bytes) ?? Promise.resolve(false),
      () => synchronizer?.prepareWorkingCopy() ?? Promise.resolve(),
    );
    presence = new PresenceRenderer(runtime);
    notebookController.setSynchronizer(synchronizer);
    notebookController.setRuntime(runtime);
    dashboard.setRuntime(runtime);
    runtime.on('computeChanged', () => {
      runUiBackground('Compute-change notification', async () => {
        const choice = await vscode.window.showInformationMessage(
          'Compute changed. A fresh Jupyter kernel will be used; previous in-memory variables are unavailable.',
          'Run All',
        );
        if (choice === 'Run All') await vscode.commands.executeCommand('notebook.execute');
      });
    });
    runtime.on('sessionEnding', () => {
      void vscode.window.showInformationMessage('Pair Notebook: хост завершает сессию и сохраняет последние изменения.');
    });
    runtime.on('hostPaused', () => {
      if (runtime?.coordinator.isCurrentHost()) return;
      void vscode.window.showWarningMessage(
        'Pair Notebook: сессия на паузе. Новый хост должен выбрать папку на своём компьютере; изменения в общей папке пока не записываются.',
      );
    });
    runtime.on('hostFolderRequired', () => {
      if (runtime) runUiBackground('New-host folder prompt', () => promptForNewHostFolder(runtime!));
    });
    runtime.on('hostResumed', () => {
      void vscode.window.showInformationMessage('Pair Notebook: новый хост подготовил папку. Совместная сессия продолжена.');
    });
    runtime.on('sessionEnded', (peer: PeerIdentity) => {
      void forgetEndedSession(context, descriptor).then(() => {
        void vscode.window.showInformationMessage(`Pair Notebook: ${peer.displayName} завершил сессию для всех.`);
      }).catch((error) => {
        output.appendLine(`[error] Could not forget ended session: ${formatError(error)}`);
      });
    });
    runtime.on('networkChanged', () => {
      queueAutomaticNetworkRecovery(context, 'Network interface route changed');
    });
    runtime.on('terminal', (event: SessionTerminalLifecycle) => {
      const closedRuntime = runtime;
      const reason = event.reason;
      if (statusTimer) clearInterval(statusTimer);
      statusTimer = undefined;
      synchronizer?.dispose();
      synchronizer = undefined;
      presence?.dispose();
      presence = undefined;
      notebookController.setSynchronizer(undefined);
      notebookController.setRuntime(undefined);
      runtime = undefined;
      lastLifecycleDiagnostics = closedRuntime?.lifecycleDiagnostics() ?? lastLifecycleDiagnostics;
      dashboard.setRuntime(undefined);
      status.hide();
      if (reason === 'host-unreachable' || reason === 'session-ended') {
        runUiBackground('Close ended Pair Notebook editors', async () => {
          const correlationId = event.correlationId ?? closedRuntime?.newLifecycleCorrelationId();
          if (closedRuntime && correlationId) {
            closedRuntime.recordLifecycleDiagnostic('pair-tabs-close-started', {
              correlationId, remotePeerId: event.hostId, connectionState: 'closed', routeKind: 'none',
              reason: 'tab-cleanup',
            });
          }
          const tabs = await closeSessionTabs(descriptor.workingFolder);
          if (closedRuntime && correlationId) {
            closedRuntime.recordLifecycleDiagnostic('pair-tabs-close-completed', {
              correlationId, remotePeerId: event.hostId, connectionState: 'closed', routeKind: 'none',
              reason: 'tab-cleanup', metadata: { tabMatched: tabs.matched, tabClosed: tabs.closed, tabFailed: tabs.failed },
            });
            lastLifecycleDiagnostics = closedRuntime.lifecycleDiagnostics();
          }
          if (reason !== 'host-unreachable') return;
          let reconnectable = true;
          try {
            await rememberProject(context, descriptor, { pinnedHostId: event.hostId, requireReconnectable: true });
            if (closedRuntime && correlationId) {
              closedRuntime.recordLifecycleDiagnostic('recent-session-saved', {
                correlationId, remotePeerId: event.hostId, connectionState: 'closed', routeKind: 'none',
                reason: 'recent-session-saved',
              });
              lastLifecycleDiagnostics = closedRuntime.lifecycleDiagnostics();
            }
          } catch (error) {
            reconnectable = false;
            output.appendLine(`[error] Could not retain reconnectable Recent Session: ${formatError(error)}`);
          }
          const tabDetail = tabs.failed
            ? `Pair tabs: закрыто ${tabs.closed} из ${tabs.matched}; остальные вкладки не затронуты.`
            : 'Pair tabs закрыты; остальные вкладки VS Code не затронуты.';
          const message = reconnectable
            ? `Pair Notebook: связь с закреплённым хостом не восстановилась за 30 секунд. ${tabDetail} Сессия сохранена в Recent Sessions и доступна для reconnect к исходному host.`
            : `Pair Notebook: связь с закреплённым хостом не восстановилась за 30 секунд. ${tabDetail} Безопасные reconnect-данные сохранить не удалось; см. Pair Notebook output.`;
          const choice = reconnectable
            ? await vscode.window.showWarningMessage(message, 'Open Recent Sessions')
            : await vscode.window.showWarningMessage(message);
          if (choice === 'Open Recent Sessions') void vscode.commands.executeCommand('pairNotebook.openRecentProject');
        });
      } else if (reason === 'local-route-failed') {
        void showLocalRouteFailedMessage();
      }
    });
    startStatusUpdates();
    const restored = runtime.snapshot();
    if (restored.waitingForHostFolder) {
      if (restored.isHost) runUiBackground('Restored new-host folder prompt', () => promptForNewHostFolder(runtime!));
      else void vscode.window.showWarningMessage(
        'Pair Notebook: сессия на паузе до выбора папки новым хостом.',
      );
    }
  } catch (error) {
    output.appendLine(`[error] Session startup failed: ${formatError(error)}`);
    const startupTerminal = runtime?.terminalLifecycle();
    await runtime?.leave().catch(() => undefined);
    if (error instanceof SessionTerminatedError) {
      await forgetEndedSession(context, descriptor).catch((cleanupError) => {
        output.appendLine(`[error] Could not forget terminated session: ${formatError(cleanupError)}`);
      });
      void vscode.window.showInformationMessage(
        `Pair Notebook: сессия уже завершена (${error.termination.endedByDisplayName}). Рабочая копия сохранена.`,
      );
      runtime = undefined;
      return;
    }
    if (startupTerminal?.reason === 'local-route-failed') {
      await showLocalRouteFailedMessage();
      runtime = undefined;
      return;
    }
    void vscode.window.showErrorMessage(`Pair Notebook could not start: ${formatError(error)}`);
    runtime = undefined;
  }
}

function startWorkspaceSessionRestore(context: vscode.ExtensionContext): void {
  if (workspaceSessionRestore) return;
  workspaceSessionRestore = restoreWorkspaceSession(context)
    .catch((error) => {
      output.appendLine(`[error] Background session restore failed: ${formatError(error)}`);
      void vscode.window.showErrorMessage(`Pair Notebook could not restore the previous session: ${formatError(error)}`);
    })
    .finally(() => {
      workspaceSessionRestore = undefined;
    });
}

async function leaveSession(): Promise<void> {
  const active = requireRuntime();
  const answer = await vscode.window.showWarningMessage(
    'Leave the current Pair Notebook session? The isolated working copy is kept for recovery.',
    { modal: true },
    'Leave Session',
  );
  if (answer !== 'Leave Session') return;
  await active.leave();
  const context = requireActivationContext();
  await forgetWorkspaceSession(context, active.descriptor);
  const recent = normalizeRecentProjects(context.globalState.get<unknown>('pairNotebook.recent', []));
  await context.globalState.update(
    'pairNotebook.recent',
    clearRecentReconnect(recent, active.descriptor.workingFolder),
  );
}

/** Closes only editor tabs backed by this session's isolated working copy. */
async function closeSessionTabs(workingFolder: string): Promise<PairTabCloseResult> {
  const tabGroups = (vscode.window as unknown as { tabGroups?: vscode.TabGroups }).tabGroups;
  const result = await closeIsolatedPairTabs(tabGroups, path.resolve(workingFolder));
  for (const error of result.errors) output.appendLine(`[debug] Pair tab close: ${error}`);
  return result;
}

async function showLocalRouteFailedMessage(): Promise<void> {
  await vscode.window.showWarningMessage(
    'Pair Notebook: локальный сетевой маршрут не удалось запустить. Сессия не подключена; проверьте VPN/proxy и повторите reconnect. Это не потеря удалённого host.',
  );
}

async function endSession(): Promise<void> {
  const active = requireRuntime();
  if (!active.coordinator.isCurrentHost()) throw new Error('Только текущий хост может завершить сессию для всех.');
  const waitingForHostFolder = active.snapshot().waitingForHostFolder;
  const answer = await vscode.window.showWarningMessage(
    waitingForHostFolder
      ? 'Завершить Pair Notebook для всех участников? Общая папка нового хоста ещё не выбрана, поэтому последнее объединённое состояние останется в изолированных рабочих копиях участников и не будет записано в новую общую папку.'
      : 'Завершить Pair Notebook для всех участников? Общая копия будет сохранена, а повторное подключение по старому приглашению станет невозможным.',
    { modal: true },
    'Завершить для всех',
  );
  if (answer !== 'Завершить для всех') return;
  await active.endSession();
  await forgetEndedSession(requireActivationContext(), active.descriptor);
  void vscode.window.showInformationMessage(waitingForHostFolder
    ? 'Pair Notebook: сессия завершена. Последнее состояние сохранено в локальных рабочих копиях.'
    : 'Pair Notebook: сессия завершена для всех участников.');
}

async function copyInvite(): Promise<void> {
  const active = requireRuntime();
  if (!active.coordinator.isCurrentHost()) throw new Error('Only the current Session Host can create the active invite.');
  if (active.snapshot().waitingForHostFolder) {
    throw new Error('Choose the new host folder before inviting more participants.');
  }
  const descriptor = active.descriptor;
  const invite: InviteData = {
    sessionId: descriptor.sessionId,
    projectId: descriptor.projectId,
    projectName: descriptor.projectName,
    mode: descriptor.mode,
    token: await getRuntimeToken(descriptor),
    sessionEpoch: descriptor.sessionEpoch,
    hostEpoch: active.coordinator.clock.hostEpoch,
    hostPeerId: descriptor.localPeer.peerId,
    hostDisplayName: descriptor.localPeer.displayName,
    hostIdentityKey: descriptor.localPeer.identityKey,
  };
  await vscode.env.clipboard.writeText(formatInvite(invite));
  void vscode.window.showInformationMessage('Pair Notebook invite copied. Share it only with people you trust.');
}

async function transferHost(): Promise<void> {
  const active = requireRuntime();
  if (!active.coordinator.isCurrentHost()) throw new Error('Ask the current Session Host to transfer the role.');
  const snapshot = active.snapshot();
  const choices = snapshot.peers
    .filter((peer) => peer.peerId !== snapshot.descriptor.localPeer.peerId && peer.online)
    .map((peer) => ({
      label: peer.displayName,
      description: `${peer.route} • ${peer.latency >= 0 ? `${peer.latency} ms` : 'measuring'}`,
      peerId: peer.peerId,
    }));
  if (!choices.length) {
    void vscode.window.showWarningMessage('Нет другого подключённого участника, которому можно передать роль хоста.');
    return;
  }
  const target = await vscode.window.showQuickPick(choices, { title: 'Transfer Host', placeHolder: 'Choose the new Session Host' });
  if (!target) return;
  const confirm = await vscode.window.showWarningMessage(
    snapshot.waitingForHostFolder
      ? `Передать роль хоста участнику ${target.label}? Сессия останется на паузе, пока этот участник не выберет папку на своём компьютере.`
      : `Transfer host to ${target.label}? The session will pause until they choose a folder on their computer.`,
    { modal: true },
    'Transfer',
  );
  if (confirm !== 'Transfer') return;
  await active.transferHost(target.peerId);
  void vscode.window.showInformationMessage(`Host transferred to ${target.label}. Waiting for their host folder.`);
}

async function selectBackingFolder(): Promise<void> {
  const active = requireRuntime();
  if (!active.coordinator.isCurrentHost()) throw new Error('Только текущий хост может выбрать папку проекта.');
  await chooseHostFolder(active);
}

async function promptForNewHostFolder(active: SessionRuntime): Promise<void> {
  if (hostFolderPromptOpen || runtime !== active) return;
  const snapshot = active.snapshot();
  if (!snapshot.isHost || !snapshot.waitingForHostFolder) return;
  hostFolderPromptOpen = true;
  try {
    const action = await vscode.window.showWarningMessage(
      'Вы стали новым хостом. Сессия поставлена на паузу. Можно настроить общую папку, передать роль другому участнику или завершить сессию без создания новой общей папки.',
      { modal: true },
      'Настроить папку',
      'Передать хоста',
      'Завершить сессию',
    );
    if (runtime !== active) return;
    if (action === 'Настроить папку') await chooseHostFolder(active);
    else if (action === 'Передать хоста') await transferHost();
    else if (action === 'Завершить сессию') await endSession();
  } finally {
    hostFolderPromptOpen = false;
  }
}

async function chooseHostFolder(active: SessionRuntime): Promise<void> {
  const choice = await vscode.window.showQuickPick([
    {
      label: '$(new-folder) Пустая папка',
      description: 'Записать в неё полное текущее состояние сессии',
      detail: 'Непустая папка будет отклонена без изменения её файлов.',
      mode: 'empty' as const,
    },
    {
      label: '$(cloud) Существующая общая папка',
      description: 'Подключить уже синхронизированную копию, например Dropbox',
      detail: 'Сначала выполняется проверка всех файлов; совпадающая папка не перезаписывается.',
      mode: 'existing' as const,
    },
  ], {
    title: 'Папка нового хоста Pair Notebook',
    placeHolder: 'Выберите безопасный способ продолжить сессию',
  });
  if (!choice || runtime !== active) return;

  for (;;) {
    const chosen = await vscode.window.showOpenDialog({
      title: choice.mode === 'empty' ? 'Выберите пустую папку хоста' : 'Выберите существующую общую папку',
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: choice.mode === 'empty' ? 'Проверить пустую папку' : 'Проверить общую папку',
    });
    if (!chosen?.[0] || runtime !== active) return;
    const folder = chosen[0].fsPath;
    let inspection = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Pair Notebook: проверка папки хоста',
      cancellable: false,
    }, () => active.inspectBackingFolder(folder));
    if (runtime !== active) return;

    if (choice.mode === 'empty') {
      if (!inspection.empty) {
        const retry = await vscode.window.showWarningMessage(
          'Эта папка не пуста. Ничего не было изменено. Выберите другую пустую папку.',
          { modal: true },
          'Выбрать другую папку',
        );
        if (retry === 'Выбрать другую папку') continue;
        return;
      }
      await active.setBackingFolder(folder, 'replace');
      void vscode.window.showInformationMessage(`Pair Notebook: текущее состояние записано в ${folder}; сессия продолжена.`);
      return;
    }

    if (inspection.empty) {
      const retry = await vscode.window.showWarningMessage(
        'В выбранной папке нет файлов общей копии. Выберите папку Dropbox с проектом или используйте режим пустой папки.',
        { modal: true },
        'Выбрать другую папку',
      );
      if (retry === 'Выбрать другую папку') continue;
      return;
    }
    if (inspection.matches) {
      try {
        await active.setBackingFolder(folder, 'reuse-existing');
        void vscode.window.showInformationMessage(`Pair Notebook: общая папка ${folder} проверена и подключена без перезаписи; сессия продолжена.`);
        return;
      } catch (error) {
        if (!(error instanceof BackingFolderMismatchError)) throw error;
        inspection = error.inspection;
      }
    }

    const mismatchCount = inspection.missing.length + inspection.different.length + inspection.extra.length;
    const decision = await vscode.window.showWarningMessage(
      `Общая папка отличается от текущей сессии (${mismatchCount} несовпадений: отсутствуют ${inspection.missing.length}, изменены ${inspection.different.length}, лишние ${inspection.extra.length}). `
      + 'Она не была изменена. Можно явно записать в неё состояние сессии: конфликтующие файлы будут заменены, а лишние отслеживаемые файлы удалены.',
      { modal: true },
      'Записать текущую сессию',
      'Выбрать другую папку',
    );
    if (decision === 'Выбрать другую папку') continue;
    if (decision !== 'Записать текущую сессию') return;
    await active.setBackingFolder(folder, 'replace');
    void vscode.window.showInformationMessage(`Pair Notebook: состояние сессии записано в ${folder}; сессия продолжена.`);
    return;
  }
}

async function selectAutosaveFolder(): Promise<void> {
  const active = requireRuntime();
  if (!active.coordinator.isCurrentHost()) throw new Error('Только текущий хост может выбрать диск для локальных автосейвов.');
  const chosen = await vscode.window.showOpenDialog({
    title: 'Выберите папку локальных автосейвов',
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Использовать для автосейвов',
  });
  if (!chosen?.[0]) return;
  await active.setAutosaveFolder(chosen[0].fsPath);
  await vscode.workspace.getConfiguration('pairNotebook').update(
    'autosaveFolder',
    chosen[0].fsPath,
    vscode.ConfigurationTarget.Global,
  );
  void vscode.window.showInformationMessage(`Pair Notebook: автосейвы будут храниться в ${chosen[0].fsPath}.`);
}

async function createAutosave(): Promise<void> {
  const folder = await requireRuntime().createAutosaveNow();
  void vscode.window.showInformationMessage(`Pair Notebook: локальный автосейв создан в ${folder}.`);
}

async function changeCompute(): Promise<void> {
  const active = requireRuntime();
  const snapshot = active.snapshot();
  if (!snapshot.isHost) throw new Error('Only the current Session Host can configure shared compute.');
  const notebook = vscode.window.activeNotebookEditor?.notebook;
  if (!notebook) throw new Error('Open the notebook whose compute target you want to change.');
  const notebookKey = active.notebookKey(notebook.uri);
  if (!notebookKey) throw new Error('The active notebook is outside the Pair Notebook working copy.');
  const workload = await vscode.window.showQuickPick([
    { label: '$(server) Any', value: 'any' },
    { label: '$(dashboard) CPU', value: 'cpu' },
    { label: '$(circuit-board) GPU', value: 'gpu' },
  ], { title: 'Compute workload', placeHolder: 'Filter suitable targets' });
  if (!workload) return;
  const current = active.computeForNotebook(notebookKey);
  const localPeerId = snapshot.descriptor.localPeer.peerId;
  const state = active.localComputePresence();
  if (!state) throw new Error('The Session Host compute environment is not available.');
  const candidates: Array<{ device: `gpu:${number}` | 'cpu'; gpu?: NonNullable<typeof state.hardware>['gpus'][number] }> = [];
  const discoveredEnvironments = state.environments ?? [];
  const cpuEnvironmentReady = !discoveredEnvironments.length
    || discoveredEnvironments.some((environment) => environment.jupyterReady);
  const gpuEnvironmentReady = discoveredEnvironments.length
    ? discoveredEnvironments.some((environment) => environment.jupyterReady && environment.cudaAvailable)
    : state.hardware?.python.torchCudaAvailable === true;
  if (workload.value !== 'gpu' && cpuEnvironmentReady) candidates.push({ device: 'cpu' });
  if (workload.value !== 'cpu' && gpuEnvironmentReady) {
    for (const gpu of state.hardware?.gpus ?? []) candidates.push({ device: `gpu:${gpu.index}`, gpu });
  }
  const options = candidates.map(({ device, gpu }) => ({
    label: `${device === current.device ? '$(check) ' : ''}${state.peer.displayName} • ${device === 'cpu' ? 'CPU' : `GPU ${gpu?.index}`}`,
    description: gpu ? `${gpu.model} • ${(gpu.vramMb / 1024).toFixed(1)} GB` : state.hardware?.cpuModel ?? 'Hardware pending',
    detail: `${state.hardware?.logicalThreads ?? '?'} threads • Python ${state.hardware?.python.version ?? '?'}`,
    peerId: localPeerId,
    device,
    pythonPath: device === current.device ? current.pythonPath ?? state.hardware?.python.executable : state.hardware?.python.executable,
  }));
  if (!options.length) throw new Error(`No online ${workload.value === 'any' ? 'compute' : workload.value.toUpperCase()} target is available.`);
  if (options[0]) options[0].label = `$(star-full) Session Host • ${options[0].label.replace(/^\$\(check\) /, '')}`;
  const selected = await vscode.window.showQuickPick(options, { title: 'Select Compute', placeHolder: 'Choose CPU or GPU executor' });
  if (!selected) return;
  const selectedState = state;
  const gpuSelected = selected.device.startsWith('gpu:');
  const discovered = selectedState?.environments ?? [];
  const environments = discovered
    .filter((environment) => environment.jupyterReady && (!gpuSelected || environment.cudaAvailable))
    .slice()
    .sort((a, b) => Number(b.cudaAvailable) - Number(a.cudaAvailable));
  if (discovered.length && !environments.length) {
    throw new Error(gpuSelected
      ? 'The selected executor has no Jupyter-ready Python environment with CUDA.'
      : 'The selected executor has no Jupyter-ready Python environment.');
  }
  if (environments.length) {
    const environment = await vscode.window.showQuickPick(environments.map((item) => ({
      label: `Python ${item.version} • ${path.basename(item.environment) || item.environment}`,
      description: `${item.jupyterReady ? 'Jupyter ✓' : 'Jupyter missing'} • ${item.torchVersion ? `PyTorch ${item.torchVersion}` : 'PyTorch not installed'} • ${item.cudaAvailable ? 'CUDA ✓' : 'CUDA —'}`,
      detail: item.executable,
      item,
    })), { title: `Python environment on ${selectedState?.peer.displayName ?? selected.peerId}` });
    if (!environment) return;
    selected.pythonPath = environment.item.executable;
  }
  if (!computeSelectionChanged(
    current,
    { executorId: selected.peerId, device: selected.device, pythonPath: selected.pythonPath },
  )) return;
  const confirm = await vscode.window.showWarningMessage(
    'Switch compute? A fresh Python kernel will be used; in-memory variables cannot migrate.',
    { modal: true },
    'Switch',
  );
  if (confirm === 'Switch') active.changeCompute(selected.peerId, notebookKey, selected.device, selected.pythonPath);
}

/**
 * Feeds VS Code settings, secret storage and proxy configuration into the
 * mesh transport layer. The function is awaited before every connection
 * attempt, so SecretStorage and Windows system-proxy discovery cannot race a
 * session start. A generation guard prevents a slower stale refresh from
 * overwriting a newer settings change.
 */
interface MeshNetworkRefreshOptions {
  allowLegacyProxyMigration?: boolean;
}

function effectiveProxyConfigurationTarget(
  configuration: vscode.WorkspaceConfiguration,
): vscode.ConfigurationTarget {
  const inspected = configuration.inspect<string>('proxyUrl');
  if (inspected?.workspaceFolderValue !== undefined) return vscode.ConfigurationTarget.WorkspaceFolder;
  if (inspected?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
  return vscode.ConfigurationTarget.Global;
}

async function applyMeshNetworkConfiguration(
  context: vscode.ExtensionContext,
  options: MeshNetworkRefreshOptions = {},
): Promise<void> {
  const generation = ++meshNetworkConfigurationGeneration;
  const configuration = vscode.workspace.getConfiguration('pairNotebook');
  const httpConfiguration = vscode.workspace.getConfiguration('http');
  let explicitProxy = configuration.get<string>('proxyUrl', '').trim();
  const embeddedCredential = inspectExplicitProxyPassword(explicitProxy);
  if (embeddedCredential?.passwordPresent) {
    const target = effectiveProxyConfigurationTarget(configuration);
    if (options.allowLegacyProxyMigration) {
      const migration = await migrateLegacyProxyPassword(
        context.secrets,
        explicitProxy,
        (passwordFreeUrl) => configuration.update('proxyUrl', passwordFreeUrl, target),
      );
      explicitProxy = migration.proxyUrl.trim();
      if (migration.migrated) {
        void vscode.window.showInformationMessage(
          'Pair Notebook migrated the proxy password from settings to VS Code SecretStorage.',
        );
      } else if (migration.discarded) {
        void vscode.window.showErrorMessage(
          'Pair Notebook removed an invalid or oversized proxy password from settings. '
          + 'Configure a supported proxy endpoint, then run Pair Notebook: Set Proxy Password.',
        );
      }
    } else {
      await configuration.update('proxyUrl', embeddedCredential.passwordFreeUrl, target);
      explicitProxy = embeddedCredential.passwordFreeUrl.trim();
      void vscode.window.showErrorMessage('Pair Notebook: ' + EXPLICIT_PROXY_PASSWORD_ERROR);
    }
  }
  const [turnPassword, proxyPassword, systemProxy] = await Promise.all([
    Promise.resolve(context.secrets.get('pairNotebook.turnPassword')).catch((error: unknown) => {
      output.appendLine(`[error] Could not read TURN credentials: ${formatError(error)}`);
      return undefined;
    }),
    readBoundProxyPassword(context.secrets, explicitProxy).catch((error: unknown) => {
      output.appendLine(`[error] Could not read proxy credentials: ${formatError(error)}`);
      return undefined;
    }),
    readWindowsSystemProxy(),
  ]);
  if (generation !== meshNetworkConfigurationGeneration) return;
  observedSystemProxyFingerprint = systemProxyFingerprint(systemProxy);
  configureMeshNetwork({
    turnUrls: configuration.get<string[]>('turnUrls', []),
    turnUsername: configuration.get<string>('turnUsername', '').trim() || undefined,
    turnPassword: turnPassword || undefined,
    proxy: {
      explicitProxy: explicitProxy || undefined,
      explicitProxyPassword: proxyPassword,
      vscodeProxy: httpConfiguration.get<string>('proxy') || undefined,
      vscodeProxySupport: httpConfiguration.get<string>('proxySupport'),
      vscodeNoProxy: httpConfiguration.get<string[]>('noProxy', []),
      systemProxy: systemProxy?.proxyUrl,
      systemNoProxy: systemProxy?.noProxy,
    },
  });
}

function queueAutomaticNetworkRecovery(context: vscode.ExtensionContext, reason: string): void {
  const affectedRuntime = runtime;
  if (!affectedRuntime) return;
  if (automaticNetworkRecovery) {
    automaticNetworkRecoveryPending = true;
    return;
  }
  automaticNetworkRecovery = (async () => {
    output.appendLine(`[info] ${reason}; refreshing proxy settings, signalling, and remembered peer routes.`);
    await applyMeshNetworkConfiguration(context);
    if (runtime !== affectedRuntime || affectedRuntime.snapshot().closed) return;
    const refreshed = await affectedRuntime.reconnect();
    output.appendLine(`[info] Automatic network recovery completed with signalling status ${refreshed.status}.`);
  })().catch((error) => {
    output.appendLine(`[error] Automatic network recovery failed: ${formatError(error)}`);
  }).finally(() => {
    automaticNetworkRecovery = undefined;
    if (automaticNetworkRecoveryPending) {
      automaticNetworkRecoveryPending = false;
      queueAutomaticNetworkRecovery(context, 'Network route changed again during recovery');
    }
  });
}

async function checkWindowsSystemProxyChange(context: vscode.ExtensionContext): Promise<void> {
  if (systemProxyPollInFlight) return;
  systemProxyPollInFlight = true;
  try {
    const current = await readWindowsSystemProxy();
    const nextFingerprint = systemProxyFingerprint(current);
    if (observedSystemProxyFingerprint === undefined) {
      observedSystemProxyFingerprint = nextFingerprint;
      return;
    }
    if (nextFingerprint === observedSystemProxyFingerprint) return;
    observedSystemProxyFingerprint = nextFingerprint;
    queueAutomaticNetworkRecovery(context, 'Windows system proxy changed');
  } catch (error) {
    output.appendLine(`[debug] Could not poll Windows system proxy: ${formatError(error)}`);
  } finally {
    systemProxyPollInFlight = false;
  }
}

function systemProxyFingerprint(value: Awaited<ReturnType<typeof readWindowsSystemProxy>>): string {
  return JSON.stringify({
    proxyUrl: value?.proxyUrl ?? '',
    noProxy: value?.noProxy ?? '',
    autoConfigUrl: value?.autoConfigUrl ?? '',
  });
}

async function showDiagnostics(advanced = false): Promise<void> {
  const activeRuntime = runtime;
  const lifecycleEvents = activeRuntime?.lifecycleDiagnostics() ?? lastLifecycleDiagnostics;
  if (!activeRuntime) {
    if (!lifecycleEvents.length) throw new Error('No active or recently closed Pair Notebook diagnostics are available.');
    const lifecycleText = formatLifecycleDiagnostics(lifecycleEvents);
    const diagnostics = ['PAIR NOTEBOOK LIFECYCLE DIAGNOSTICS', '', lifecycleText].join('\n');
    output.appendLine(diagnostics);
    output.show(true);
    const choice = await vscode.window.showInformationMessage('Pair Notebook diagnostics opened. Session tokens are excluded.', 'Copy Diagnostics');
    if (choice === 'Copy Diagnostics') await vscode.env.clipboard.writeText(diagnostics);
    return;
  }
  const snapshot = activeRuntime.snapshot();
  // networkDiagnostics is sanitized: no tokens, TURN or proxy credentials.
  const network = (() => {
    try { return activeRuntime.networkDiagnostics(); } catch { return undefined; }
  })() as {
    relays?: string[];
    turnStatus?: 'not-configured' | 'invalid' | 'configured';
    turnEndpoints?: Array<{ url: string; transport: string }>;
    turnProbes?: Array<{ url: string; transport: string; ok: boolean; latencyMs?: number }>;
    proxy?: string;
    relayFallback?: { enabled?: boolean; connectedRelays?: number };
    udpAvailability?: { state?: string; confidence?: string };
    signalling?: SignallingFamilyDiagnostic[];
  } | undefined;
  // Passive diagnostics run automatically with ordinary user permissions and
  // never modify system state; every inference carries an explicit confidence.
  const passive = await buildNetworkDiagnostics({
    turnProbes: (network?.turnProbes ?? []).map((probe) => ({
      endpoint: { url: probe.url, host: probe.url, port: 0, transport: probe.transport as 'udp' | 'tcp' | 'tls' },
      ok: probe.ok,
      ...(probe.latencyMs !== undefined ? { latencyMs: probe.latencyMs } : {}),
    })),
    ...(network?.turnStatus !== undefined ? { turnStatus: network.turnStatus } : {}),
    ...(network?.relayFallback?.enabled !== undefined
      ? { relayFallbackEnabled: network.relayFallback.enabled } : {}),
    ...(network?.relayFallback?.connectedRelays !== undefined
      ? { connectedRelayCount: network.relayFallback.connectedRelays } : {}),
    ...(network?.signalling ? { signalling: network.signalling } : {}),
    resolveDns: async (host) => (await lookup(host)),
  });

  const lines = [
    'PAIR NOTEBOOK NETWORK DIAGNOSTICS',
    advanced ? 'MODE: advanced (passive, read-only; administrator rights are NOT required and nothing is modified)' : '',
    '',
    ...snapshot.peers.map((peer) => `${peer.displayName.padEnd(20)} ${peer.route.padEnd(8)} ${peer.latency >= 0 ? `${peer.latency} ms` : '—'}  heartbeat ${Math.max(0, Date.now() - peer.lastHeartbeat)} ms`),
    '',
    `Host epoch: ${snapshot.clock.hostEpoch}`,
    `Pending disk: ${snapshot.pendingDisk}`,
    `Kernel: ${snapshot.kernelStatus}`,
    `Transport: Trystero / WebRTC (Nostr discovery)`,
    `Direct P2P peers: ${snapshot.metrics.directPeers}`,
    `Waiting for host folder: ${snapshot.waitingForHostFolder ? 'yes' : 'no'}`,
    `Traffic: ↓ ${snapshot.metrics.bytesReceivedPerSecond} B/s ↑ ${snapshot.metrics.bytesSentPerSecond} B/s`,
  ];
  if (network) {
    lines.push(
      '',
      'Discovery (Nostr relays):',
      ...(network.relays ?? []).map((relay, index) => `  ${index + 1}. ${relay}`),
      'Signalling lifecycle:',
      ...(network.signalling ?? []).flatMap((family) => [
        `  ${family.family.toUpperCase()}: ${family.active ? 'active' : 'inactive'}; stage=${family.stage}`
          + `${family.lastRefresh
            ? `; lastRefresh=${family.lastRefresh.status}`
              + ` at=${new Date(family.lastRefresh.at).toISOString()}`
              + ` requested=${family.lastRefresh.requestedSockets}`
              + ` replaced=${family.lastRefresh.replacedSockets}`
              + ` verified=${family.lastRefresh.verifiedEndpoints}`
            : ''}`
          + `${family.lastError
            ? `; lastError=${family.lastError.phase}/${family.lastError.category}`
              + ` at=${new Date(family.lastError.at).toISOString()}`
            : ''}`,
        `    evidence=${family.evidence.length > 0 ? family.evidence.join(',') : 'none'}`,
        `    selectedRoutes=${family.routes.length > 0
          ? family.routes.map((route) => `${route.purpose}:${route.count}`).join(',')
          : 'none'}`,
        ...family.endpoints.map((endpoint) => `    ${endpoint.endpoint} [${endpoint.id.slice(0, 12)}] — ${endpoint.state}`
          + `; subscribe=${endpoint.subscription}; publish=${endpoint.publication}`
          + `${endpoint.lastError
            ? `; lastError=${endpoint.lastError.phase}/${endpoint.lastError.category}`
              + ` at=${new Date(endpoint.lastError.at).toISOString()}`
            : ''}`),
      ]),
      network.turnStatus === 'not-configured'
        ? 'TURN: not configured (direct ICE + encrypted emergency relay remain enabled)'
        : network.turnStatus === 'invalid'
          ? 'TURN: configured URLs are invalid; no TURN service is active'
          : 'TURN fallback order:',
      ...(network.turnStatus === 'configured' ? (network.turnEndpoints ?? []).map((endpoint, index) => {
        const probe = (network.turnProbes ?? []).find((item) => item.url === endpoint.url);
        const state = !probe ? 'not probed yet' : probe.ok ? `reachable (${probe.latencyMs} ms)` : 'unreachable';
        return `  ${index + 1}. [${endpoint.transport.toUpperCase()}] ${endpoint.url} — ${state}`;
      }) : []),
      `Proxy for signalling: ${network.proxy ?? 'Direct'}`,
      `UDP availability: ${network.udpAvailability?.state ?? 'unknown'} (${network.udpAvailability?.confidence ?? 'low'} confidence)`,
      '',
      'Passive diagnostics:',
      ...passive.observations.map((item) =>
        `  [${item.confidence.toUpperCase()}] ${item.observation}\n      impact: ${item.impact}${item.possibleCauses?.length ? `\n      possible causes: ${item.possibleCauses.join(', ')}` : ''}`),
      ...(passive.observations.length === 0 ? ['  No network limitations detected.'] : []),
    );
  }
  lines.push(
    '',
    `Lifecycle evidence ring (${lifecycleEvents.length} events; oldest -> newest):`,
    ...(lifecycleEvents.length
      ? formatLifecycleDiagnostics(lifecycleEvents).split('\n').map((line) => `  ${line}`)
      : ['  no lifecycle events']),
  );
  const diagnostics = lines.join('\n');
  output.appendLine(diagnostics);
  output.show(true);
  const choice = await vscode.window.showInformationMessage('Pair Notebook diagnostics opened. Session tokens are excluded.', 'Copy Diagnostics');
  if (choice === 'Copy Diagnostics') await vscode.env.clipboard.writeText(diagnostics);
}

/**
 * "Try to improve": safe make-before-break optimization. The working
 * connection is never disconnected; a candidate route is built, verified and
 * only promoted after it proves itself. Failure keeps the current route.
 */
async function tryImproveConnection(): Promise<void> {
  const active = runtime;
  if (!active) return;
  if (!active.snapshot().connections?.length) {
    void vscode.window.showInformationMessage('Pair Notebook: нет подключённых участников для оптимизации.');
    return;
  }
  const result = active.tryImproveConnection();
  if (result.alreadyOptimal) {
    void vscode.window.showInformationMessage(
      'Pair Notebook: соединение уже оптимально (прямой P2P). Улучшение не требуется.',
    );
    return;
  }
  // The final result arrives via the connectionUpdated event stream, which the
  // sidebar renders live. Do not block or spam dialogs here: the sidebar is the
  // source of truth for progress ("Checking direct P2P…", success/failure).
  void vscode.window.showInformationMessage(
    `Pair Notebook: проверяем лучший маршрут для ${result.attempted} участник(а/ов). Текущее соединение остаётся активным.`,
  );
}

async function showComputeResources(): Promise<void> {
  const snapshot = requireRuntime().snapshot();
  const text = snapshot.awareness.map((state) => {
    const gpu = state.hardware?.gpus.map((item) => `${item.model} (${(item.vramMb / 1024).toFixed(1)} GB)`).join(', ') || 'No NVIDIA GPU detected';
    return `${state.peer.displayName}\nCPU: ${state.hardware?.cpuModel ?? 'pending'}\nGPU: ${gpu}\nPython: ${state.hardware?.python.version ?? 'pending'}\nPyTorch CUDA: ${state.hardware?.python.torchCudaAvailable ? 'available' : 'unavailable'}\n`;
  }).join('\n');
  output.appendLine(text);
  output.show(true);
}

async function selectPythonEnvironment(): Promise<void> {
  if (runtime && !runtime.coordinator.isCurrentHost()) {
    throw new Error('Only the current Session Host can select the shared Python environment.');
  }
  const configuration = vscode.workspace.getConfiguration('pairNotebook');
  const current = configuration.get<string>('pythonPath', 'python');
  const root = runtime?.descriptor.workingFolder ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const environments = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Window,
    title: 'Discovering Python environments',
  }, () => discoverPythonEnvironments(root, current));
  const choices = environments.map((environment) => ({
    label: `${environment.executable === current ? '$(check) ' : ''}${environment.version} • ${path.basename(environment.environment) || environment.environment}`,
    description: environment.jupyterReady ? 'Jupyter ready' : 'Needs jupyter_client + ipykernel',
    detail: `${environment.executable} • ${environment.source}`,
    environment,
  }));
  choices.push({
    label: '$(edit) Enter another executable…',
    description: 'Custom path or command',
    detail: '',
    environment: { executable: '', version: '', environment: '', jupyterReady: false, torchVersion: '', cudaAvailable: false, source: 'Manual' },
  });
  const picked = await vscode.window.showQuickPick(choices, { title: 'Select Python Environment' });
  if (!picked) return;
  const selected = picked.environment.executable || await vscode.window.showInputBox({
    title: 'Python executable', value: current, ignoreFocusOut: true,
  });
  if (!selected) return;
  await configuration.update('pythonPath', selected, vscode.ConfigurationTarget.Global);
  if (picked.environment.executable && !picked.environment.jupyterReady) {
    const install = `"${selected}" -m pip install jupyter_client ipykernel`;
    const answer = await vscode.window.showWarningMessage(`This environment is not Jupyter-ready. Run: ${install}`, 'Copy Command');
    if (answer === 'Copy Command') await vscode.env.clipboard.writeText(install);
  }
  if (runtime) {
    const notebook = vscode.window.activeNotebookEditor?.notebook;
    const key = notebook ? runtime.notebookKey(notebook.uri) : undefined;
    if (key) {
      const target = runtime.computeForNotebook(key);
      if (target.executorId === runtime.descriptor.localPeer.peerId) {
        runtime.changeCompute(target.executorId, key, target.device, selected);
      }
    }
    await runtime.refreshHardware();
  }
}

async function openRecentProject(context: vscode.ExtensionContext): Promise<void> {
  const stored = normalizeRecentProjects(context.globalState.get<unknown>('pairNotebook.recent', []));
  const recent = await accessibleRecentProjects(stored);
  if (recent.length !== stored.length) await context.globalState.update('pairNotebook.recent', recent);
  if (!recent.length) {
    void vscode.window.showInformationMessage('No accessible recent Pair Notebook projects were found.');
    return;
  }
  const picked = await vscode.window.showQuickPick(recent.map((item) => ({
    label: item.name,
    description: new Date(item.at).toLocaleString(),
    detail: item.workingFolder,
    item,
  })), { title: 'Recent Pair Notebook sessions/projects' });
  if (!picked) return;
  const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const selectedPath = path.resolve(picked.item.workingFolder);
  const currentPath = currentFolder ? path.resolve(currentFolder) : undefined;
  const sameFolder = currentPath !== undefined && (process.platform === 'win32'
    ? currentPath.toLowerCase() === selectedPath.toLowerCase()
    : currentPath === selectedPath);
  if (picked.item.reconnect) {
    let markerDescriptor: SessionDescriptor;
    try {
      const markerBytes = await readBoundedRegularFile(path.join(selectedPath, MARKER), MAX_SESSION_MARKER_BYTES);
      markerDescriptor = normalizeSessionDescriptor(JSON.parse(markerBytes.toString('utf8')), selectedPath);
      assertRecentReconnectMatchesDescriptor(picked.item.reconnect, markerDescriptor);
    } catch (error) {
      throw new Error(`Recent Session cannot reconnect safely: ${formatError(error)}`);
    }
  }
  if (sameFolder) {
    if (runtime) {
      void vscode.window.showInformationMessage('This Pair Notebook project is already open.');
      return;
    }
    await applyMeshNetworkConfiguration(context);
    await restoreWorkspaceSession(context);
    return;
  }
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(selectedPath), false);
}

function startStatusUpdates(): void {
  if (statusTimer) clearInterval(statusTimer);
  const update = () => {
    if (!runtime) return status.hide();
    const snapshot = runtime.snapshot();
    const host = snapshot.awareness.find((state) => state.peer.peerId === snapshot.clock.hostId)?.peer.displayName ?? '—';
    const compute = snapshot.awareness.find((state) => state.peer.peerId === snapshot.computeExecutorId)?.peer.displayName ?? '—';
    const onlineParticipants = snapshot.peers.filter((peer) => peer.online).length;
    const progressText = statusBarTextForRuntimeState(snapshot.runtimeState);
    status.text = snapshot.runtimeState === 'waiting-for-host-folder'
      ? '$(debug-pause) Pair: waiting for host folder'
      : progressText ?? (
        snapshot.runtimeState === 'host-unavailable' || snapshot.runtimeState === 'executor-unavailable'
          ? `$(warning) Pair: ${snapshot.runtimeState}`
          : snapshot.kernelStatus === 'Busy'
            ? `$(sync~spin) Pair: ${compute} • Running`
            : snapshot.clock.hostId === snapshot.descriptor.localPeer.peerId
              ? `$(radio-tower) Pair: Host • ${onlineParticipants}`
              : `$(broadcast) Pair: ${onlineParticipants} • H:${host} • C:${compute}`
      );
    status.tooltip = `${snapshot.runtimeState}: ${snapshot.runtimeDetail}`;
    status.show();
  };
  update();
  statusTimer = setInterval(update, 1000);
}

function register(context: vscode.ExtensionContext, command: string, callback: () => unknown | Promise<unknown>): void {
  context.subscriptions.push(vscode.commands.registerCommand(command, async () => {
    try {
      await callback();
    } catch (error) {
      output.appendLine(`[error] ${command}: ${formatError(error)}`);
      void vscode.window.showErrorMessage(`Pair Notebook: ${formatError(error)}`);
    }
  }));
}

function runUiBackground(label: string, action: () => unknown | Promise<unknown>): void {
  try {
    void Promise.resolve(action()).catch((error) => {
      output.appendLine(`[error] ${label}: ${formatError(error)}`);
      void vscode.window.showErrorMessage(`Pair Notebook: ${formatError(error)}`);
    });
  } catch (error) {
    output.appendLine(`[error] ${label}: ${formatError(error)}`);
    void vscode.window.showErrorMessage(`Pair Notebook: ${formatError(error)}`);
  }
}

interface StoredSessionSecret {
  version: 1;
  token: string;
  identityPrivateKey?: string;
}

async function saveDescriptor(
  context: vscode.ExtensionContext,
  descriptor: SessionDescriptor,
  token: string,
  identityPrivateKey: string,
): Promise<void> {
  if (descriptor.localPeer.identityKey !== publicKeyFromPrivate(identityPrivateKey)) {
    throw new Error('The participant identity does not match its private key.');
  }
  await mkdir(descriptor.workingFolder, { recursive: true });
  const key = secretKey(descriptor.sessionId, descriptor.localPeer.peerId);
  const previousSecret = await context.secrets.get(key);
  const secret = encodeSessionSecret(token, identityPrivateKey);
  await context.secrets.store(key, secret);
  try {
    await atomicWriteFile(path.join(descriptor.workingFolder, MARKER), `${JSON.stringify(descriptor, null, 2)}\n`);
  } catch (error) {
    const rollback = previousSecret === undefined
      ? context.secrets.delete(key)
      : context.secrets.store(key, previousSecret);
    await Promise.resolve(rollback).catch((cleanupError: unknown) => {
      output.appendLine(`[error] Could not roll back session token: ${formatError(cleanupError)}`);
    });
    throw error;
  }
}

async function getRuntimeToken(descriptor: SessionDescriptor): Promise<string> {
  const context = requireActivationContext();
  const secret = await descriptorSecret(context, descriptor);
  if (!secret) throw new Error('Session token is unavailable.');
  return secret.token;
}

let activationContext: vscode.ExtensionContext | undefined;

async function descriptorSecret(
  context: vscode.ExtensionContext,
  descriptor: Pick<SessionDescriptor, 'sessionId' | 'localPeer'>,
): Promise<StoredSessionSecret | undefined> {
  const key = secretKey(descriptor.sessionId, descriptor.localPeer.peerId);
  const current = await context.secrets.get(key);
  if (current) return decodeSessionSecret(current);
  const legacy = await context.secrets.get(legacySecretKey(descriptor.sessionId));
  if (legacy) await context.secrets.store(key, legacy);
  return legacy ? decodeSessionSecret(legacy) : undefined;
}

async function ensureDescriptorIdentity(
  context: vscode.ExtensionContext,
  descriptor: SessionDescriptor,
  secret: StoredSessionSecret,
): Promise<string> {
  if (secret.identityPrivateKey) {
    const publicKey = publicKeyFromPrivate(secret.identityPrivateKey);
    if (descriptor.localPeer.identityKey && descriptor.localPeer.identityKey !== publicKey) {
      throw new Error('The stored identity key does not match this session marker. Rejoin using a fresh invite.');
    }
    if (!descriptor.localPeer.identityKey) {
      descriptor.localPeer.identityKey = publicKey;
      await saveDescriptor(context, descriptor, secret.token, secret.identityPrivateKey);
    }
    return secret.identityPrivateKey;
  }
  if (descriptor.localPeer.identityKey) {
    throw new Error('The private participant identity is unavailable. Rejoin using a fresh invite.');
  }
  // A legacy bearer token cannot authenticate which participant owns an old
  // peer id. Trust-on-first-use here would let any invite holder impersonate
  // an offline host during the upgrade, so require a new authenticated invite.
  throw new Error(
    'This session predates participant identity authentication. The host must start a new session and share a fresh invite.',
  );
}

function encodeSessionSecret(token: string, identityPrivateKey: string): string {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error('Session token has an unsupported format.');
  const privateKeyError = validateIdentityPrivateKey(identityPrivateKey);
  if (privateKeyError) throw new Error(`Session identity is invalid: ${privateKeyError}.`);
  return JSON.stringify({ version: 1, token, identityPrivateKey } satisfies StoredSessionSecret);
}

function decodeSessionSecret(value: string): StoredSessionSecret | undefined {
  if (/^[A-Za-z0-9_-]{32,128}$/.test(value)) return { version: 1, token: value };
  try {
    const parsed = JSON.parse(value) as Partial<StoredSessionSecret>;
    if (parsed.version !== 1 || typeof parsed.token !== 'string'
      || !/^[A-Za-z0-9_-]{32,128}$/.test(parsed.token)
      || (parsed.identityPrivateKey !== undefined && validateIdentityPrivateKey(parsed.identityPrivateKey))) {
      return undefined;
    }
    return {
      version: 1,
      token: parsed.token,
      ...(parsed.identityPrivateKey ? { identityPrivateKey: parsed.identityPrivateKey } : {}),
    };
  } catch {
    return undefined;
  }
}

async function forgetWorkspaceSession(
  context: vscode.ExtensionContext,
  descriptor: SessionDescriptor,
  removeLegacy = false,
): Promise<void> {
  await rm(path.join(descriptor.workingFolder, MARKER), { force: true });
  await context.secrets.delete(secretKey(descriptor.sessionId, descriptor.localPeer.peerId));
  if (removeLegacy) await context.secrets.delete(legacySecretKey(descriptor.sessionId));
}

interface RememberProjectOptions {
  pinnedHostId?: string | undefined;
  requireReconnectable?: boolean | undefined;
}

async function rememberProject(
  context: vscode.ExtensionContext,
  descriptor: SessionDescriptor,
  options: RememberProjectOptions = {},
): Promise<void> {
  const recent = normalizeRecentProjects(context.globalState.get<unknown>('pairNotebook.recent', []));
  const reconnect = reconnectIdentityFromDescriptor(descriptor, options.pinnedHostId ?? descriptor.hostPeerId);
  if (options.requireReconnectable && !reconnect) {
    throw new Error('The guest marker does not contain a valid authenticated pinned host identity.');
  }
  const next = rememberRecentProject(recent, {
    name: descriptor.projectName,
    workingFolder: descriptor.workingFolder,
    at: Date.now(),
    ...(reconnect ? { reconnect } : {}),
  });
  await context.globalState.update('pairNotebook.recent', next);
}

async function forgetEndedSession(
  context: vscode.ExtensionContext,
  descriptor: SessionDescriptor,
): Promise<void> {
  await forgetWorkspaceSession(context, descriptor, true);
  const recent = normalizeRecentProjects(context.globalState.get<unknown>('pairNotebook.recent', []));
  await context.globalState.update('pairNotebook.recent', forgetRecentProject(recent, descriptor.workingFolder));
}

function displayName(): string {
  const configured = vscode.workspace.getConfiguration('pairNotebook').get<string>('displayName', '').trim();
  if (configured) return configured;
  try {
    return os.userInfo().username;
  } catch {
    return 'User';
  }
}

async function promptDisplayName(initial: string, prompt: string): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: 'Ваше имя в Pair Notebook',
    value: initial,
    prompt,
    ignoreFocusOut: true,
    validateInput: validateDisplayName,
  });
  return value ? cleanDisplayName(value) : undefined;
}

function normalizeSessionDescriptor(value: unknown, workspaceFolder: string): SessionDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('marker must contain an object');
  const raw = value as Partial<SessionDescriptor>;
  const identifier = /^[A-Za-z0-9_-]{1,128}$/;
  if (!identifier.test(raw.sessionId ?? '') || !identifier.test(raw.projectId ?? '')) {
    throw new Error('session or project identifier is invalid');
  }
  if (raw.mode !== 'host-only' && raw.mode !== 'resilient') throw new Error('session mode is invalid');
  if (raw.role !== 'host' && raw.role !== 'peer') throw new Error('session role is invalid');
  if (!raw.localPeer || !identifier.test(raw.localPeer.peerId ?? '')) throw new Error('local peer identity is invalid');
  const displayNameError = validateDisplayName(raw.localPeer.displayName);
  if (displayNameError) throw new Error(`local display name is invalid: ${displayNameError}`);
  if (!Number.isSafeInteger(raw.localPeer.joinOrder) || raw.localPeer.joinOrder < 0) {
    throw new Error('local join order is invalid');
  }
  if (!identifier.test(raw.hostPeerId ?? '')) throw new Error('host identity is invalid');
  if (!Number.isSafeInteger(raw.sessionEpoch) || (raw.sessionEpoch ?? 0) <= 0) throw new Error('session epoch is invalid');
  if (!Number.isSafeInteger(raw.hostEpoch) || (raw.hostEpoch ?? -1) < 0) throw new Error('host epoch is invalid');
  const projectName = typeof raw.projectName === 'string' ? cleanProjectName(raw.projectName) : '';
  if (validateProjectName(projectName)) throw new Error('project name is invalid');
  const localPeer: PeerIdentity = {
    peerId: raw.localPeer.peerId,
    displayName: cleanDisplayName(raw.localPeer.displayName),
    joinOrder: raw.localPeer.joinOrder,
    ...(!validateIdentityPublicKey(raw.localPeer.identityKey)
      ? { identityKey: raw.localPeer.identityKey }
      : {}),
  };
  if ((raw.role === 'host') !== (raw.hostPeerId === localPeer.peerId)) {
    throw new Error('session role and host identity are inconsistent');
  }
  const knownPeers: PeerIdentity[] = [];
  const knownPeerIds = new Set<string>();
  const knownPeerNames = new Set<string>([normalizeDisplayName(localPeer.displayName)]);
  if (Array.isArray(raw.knownPeers)) {
    for (const peer of raw.knownPeers.slice(0, MAX_RESTORED_PEERS * 4)) {
      if (!peer || !identifier.test(peer.peerId ?? '') || peer.peerId === localPeer.peerId
        || validateDisplayName(peer.displayName) || !Number.isSafeInteger(peer.joinOrder) || peer.joinOrder < 0) continue;
      const normalizedName = normalizeDisplayName(peer.displayName);
      if (knownPeerIds.has(peer.peerId) || knownPeerNames.has(normalizedName)) continue;
      knownPeerIds.add(peer.peerId);
      knownPeerNames.add(normalizedName);
      knownPeers.push({
        peerId: peer.peerId,
        displayName: cleanDisplayName(peer.displayName),
        joinOrder: peer.joinOrder,
        ...(!validateIdentityPublicKey(peer.identityKey) ? { identityKey: peer.identityKey } : {}),
      });
      if (knownPeers.length >= MAX_RESTORED_PEERS) break;
    }
  }
  return {
    sessionId: raw.sessionId!,
    projectId: raw.projectId!,
    projectName,
    mode: 'resilient',
    role: raw.role,
    localPeer,
    hostPeerId: raw.hostPeerId!,
    backingFolder: raw.role === 'host' && typeof raw.backingFolder === 'string' && path.isAbsolute(raw.backingFolder)
      && raw.backingFolder.trim()
      && raw.backingFolder.length <= 4096 && !/[\0\r\n]/.test(raw.backingFolder)
      ? path.resolve(raw.backingFolder)
      : '',
    workingFolder: path.resolve(workspaceFolder),
    createdAt: Number.isSafeInteger(raw.createdAt) && Number(raw.createdAt) >= 0 ? Number(raw.createdAt) : Date.now(),
    sessionEpoch: raw.sessionEpoch!,
    hostEpoch: raw.hostEpoch!,
    computeExecutorId: identifier.test(raw.computeExecutorId ?? '') ? raw.computeExecutorId! : raw.hostPeerId!,
    notebookCompute: raw.notebookCompute,
    notebookPythonPaths: raw.notebookPythonPaths,
    pythonPath: typeof raw.pythonPath === 'string' && raw.pythonPath.trim() ? raw.pythonPath : 'python',
    freshStart: raw.freshStart === true,
    knownPeers,
    fileStates: raw.fileStates,
    fileRevisionCounter: raw.fileRevisionCounter,
    binaryVersions: raw.binaryVersions,
  };
}

async function readBoundedRegularFile(target: string, maximumBytes: number): Promise<Buffer> {
  const linkInfo = await lstat(target);
  if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) throw new Error('session marker must be a regular file');
  const handle = await open(target, 'r');
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const capacity = Math.min(64 * 1024, maximumBytes + 1 - total);
      if (capacity <= 0) throw new Error(`session marker exceeds the ${maximumBytes}-byte limit`);
      const chunk = Buffer.allocUnsafe(capacity);
      const { bytesRead } = await handle.read(chunk, 0, capacity, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maximumBytes) throw new Error(`session marker exceeds the ${maximumBytes}-byte limit`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function sessionWorkingFolder(sessionId: string, peerId: string, context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'sessions', sessionId, peerId, 'workspace');
}

function secretKey(sessionId: string, peerId: string): string {
  return `pairNotebook.sessionToken.${sessionId}.${peerId}`;
}

function legacySecretKey(sessionId: string): string {
  return `pairNotebook.sessionToken.${sessionId}`;
}

function requireRuntime(): SessionRuntime {
  if (!runtime) throw new Error('No active Pair Notebook session.');
  return runtime;
}

function requireActivationContext(): vscode.ExtensionContext {
  if (!activationContext) throw new Error('Pair Notebook extension context is unavailable.');
  return activationContext;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
