import { lstat, mkdir, open, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { atomicWriteFile } from './core/atomicFile';
import { GpuInfo } from './core/hardware';
import {
  generateIdentityCredentials,
  publicKeyFromPrivate,
  validateIdentityPrivateKey,
  validateIdentityPublicKey,
} from './core/identity';
import { discoverPythonEnvironments } from './core/pythonEnvironments';
import { copyProject } from './core/projectFiles';
import { filesystemPathComparisonKey } from './core/projectPath';
import {
  accessibleRecentProjects,
  normalizeRecentProjects,
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
import { SessionRuntime } from './runtime/session';
import { DashboardProvider } from './vscode/dashboard';
import { PresenceRenderer, pickCursorColor } from './vscode/presence';
import { EditorSynchronizer } from './vscode/sync';
import { PairNotebookController } from './vscode/jupyterController';

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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  activationContext = context;
  output = vscode.window.createOutputChannel('Pair Notebook');
  applyMeshNetworkConfiguration(context);
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
  );

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
  register(context, 'pairNotebook.setTurnPassword', async () => {
    const password = await vscode.window.showInputBox({
      prompt: 'TURN password for the configured turnUrls (stored in VS Code secret storage, never in settings or logs)',
      password: true,
    });
    if (password === undefined) return;
    await context.secrets.store('pairNotebook.turnPassword', password);
    applyMeshNetworkConfiguration(context);
    void vscode.window.showInformationMessage('Pair Notebook: TURN пароль сохранён в защищённом хранилище.');
  });
  register(context, 'pairNotebook.selectBackingFolder', () => selectBackingFolder());
  register(context, 'pairNotebook.flush', async () => {
    await requireRuntime().saveAsHost();
    void vscode.window.showInformationMessage('Pair Notebook: проект сохранён хостом.');
  });
  register(context, 'pairNotebook.selectAutosaveFolder', () => selectAutosaveFolder());
  register(context, 'pairNotebook.createAutosave', () => createAutosave());
  register(context, 'pairNotebook.reconnect', async () => requireRuntime().reconnect());
  register(context, 'pairNotebook.changeCompute', () => changeCompute());
  register(context, 'pairNotebook.refreshHardware', async () => {
    await requireRuntime().refreshHardware();
    void vscode.window.showInformationMessage('Pair Notebook hardware capabilities refreshed.');
  });
  register(context, 'pairNotebook.showComputeResources', () => showComputeResources());
  register(context, 'pairNotebook.selectPythonEnvironment', () => selectPythonEnvironment());
  register(context, 'pairNotebook.allowRemoteCompute', () => toggleRemoteCompute());
  register(context, 'pairNotebook.runActiveCell', async () => requireRuntime().executeActiveCell());
  register(context, 'pairNotebook.restartKernel', async () => notebookController.restartActive());
  register(context, 'pairNotebook.toggleShareMyCursor', () => toggleBooleanSetting('shareMyCursor', 'Мой курсор'));
  register(context, 'pairNotebook.toggleRemoteCursors', () => toggleBooleanSetting('showRemoteCursors', 'Чужие курсоры'));
  register(context, 'pairNotebook.toggleRemoteCursorNames', () => toggleBooleanSetting('showRemoteCursorNames', 'Имена участников'));
  register(context, 'pairNotebook.changeMyCursorColor', () => changeMyCursorColor());
  register(context, 'pairNotebook.manageParticipantCursors', () => requirePresence().manageParticipant());
  register(context, 'pairNotebook.openRecentProject', () => openRecentProject(context));

  await restoreWorkspaceSession(context);
}

export function deactivate(): Thenable<void> | undefined {
  if (statusTimer) clearInterval(statusTimer);
  synchronizer?.dispose();
  presence?.dispose();
  notebookController?.dispose();
  return runtime?.leave();
}

async function startSession(context: vscode.ExtensionContext): Promise<void> {
  if (runtime) throw new Error('A Pair Notebook session is already active in this window.');
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
  if (runtime) throw new Error('A Pair Notebook session is already active in this window.');
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
          message: state.currentFile,
          increment: state.totalFiles ? completedDelta * 100 / state.totalFiles : undefined,
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
    // Every 0.3 session supports deterministic host failover. Legacy invites
    // may still carry the former host-only flag, but joining upgrades it.
    mode: 'resilient',
    role: 'peer',
    localPeer,
    hostPeerId: invite.hostPeerId,
    backingFolder: '',
    workingFolder,
    createdAt: Date.now(),
    sessionEpoch: invite.sessionEpoch,
    hostEpoch: 0,
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
    await runtime.start();
    synchronizer = new EditorSynchronizer(
      runtime.project,
      descriptor.workingFolder,
      output,
      runtime.notebookCellIds,
      // The canonical backing copy is serialized directly from CRDT state.
      // Background persistence must not trigger format-on-save after every edit.
      () => false,
    );
    runtime.setWorkingCopyWriter(
      (relativePath, bytes) => synchronizer?.persistWorkingCopy(relativePath, bytes) ?? Promise.resolve(false),
      () => synchronizer?.prepareWorkingCopy() ?? Promise.resolve(),
    );
    presence = new PresenceRenderer(runtime, context);
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
    runtime.on('computeUnavailable', (peer: PeerIdentity) => {
      runUiBackground('Compute-unavailable notification', async () => {
        const choice = await vscode.window.showWarningMessage(
          `Compute unavailable: ${peer.displayName}. Editing remains active; select a replacement before running cells.`,
          'Change Compute',
        );
        if (choice === 'Change Compute') await vscode.commands.executeCommand('pairNotebook.changeCompute');
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
    runtime.on('sessionEnded', (peer: PeerIdentity, reason: 'explicit-end' | 'host-lost' = 'explicit-end') => {
      void forgetWorkspaceSession(context, descriptor, true).then(() => {
        if (reason === 'explicit-end') {
          void vscode.window.showInformationMessage(`Pair Notebook: ${peer.displayName} завершил сессию для всех.`);
        }
      }).catch((error) => {
        output.appendLine(`[error] Could not forget ended session: ${formatError(error)}`);
      });
    });
    runtime.on('closed', () => {
      if (statusTimer) clearInterval(statusTimer);
      statusTimer = undefined;
      synchronizer?.dispose();
      synchronizer = undefined;
      presence?.dispose();
      presence = undefined;
      notebookController.setSynchronizer(undefined);
      notebookController.setRuntime(undefined);
      runtime = undefined;
      dashboard.setRuntime(undefined);
      status.hide();
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
    await runtime?.leave().catch(() => undefined);
    if (error instanceof SessionTerminatedError) {
      await forgetWorkspaceSession(context, descriptor, true).catch((cleanupError) => {
        output.appendLine(`[error] Could not forget terminated session: ${formatError(cleanupError)}`);
      });
      void vscode.window.showInformationMessage(
        `Pair Notebook: сессия уже завершена (${error.termination.endedByDisplayName}). Рабочая копия сохранена.`,
      );
      runtime = undefined;
      return;
    }
    void vscode.window.showErrorMessage(`Pair Notebook could not start: ${formatError(error)}`);
    runtime = undefined;
  }
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
  await forgetWorkspaceSession(requireActivationContext(), active.descriptor);
}

async function endSession(): Promise<void> {
  const active = requireRuntime();
  if (!active.coordinator.isCurrentHost()) throw new Error('Только текущий хост может завершить сессию для всех.');
  const answer = await vscode.window.showWarningMessage(
    'Завершить Pair Notebook для всех участников? Общая копия будет сохранена, а повторное подключение по старому приглашению станет невозможным.',
    { modal: true },
    'Завершить для всех',
  );
  if (answer !== 'Завершить для всех') return;
  await active.endSession();
  await forgetWorkspaceSession(requireActivationContext(), active.descriptor, true);
  void vscode.window.showInformationMessage('Pair Notebook: сессия завершена для всех участников.');
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
  const target = await vscode.window.showQuickPick(choices, { title: 'Transfer Host', placeHolder: 'Choose the new Session Host' });
  if (!target) return;
  const confirm = await vscode.window.showWarningMessage(
    `Transfer host to ${target.label}? The session will pause until they choose a folder on their computer.`,
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
  const chosen = await vscode.window.showOpenDialog({
    title: 'Выберите папку, где хост будет сохранять проект',
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Использовать как папку хоста',
  });
  if (!chosen?.[0]) return;
  if (!await confirmBackingFolderReplacement(chosen[0].fsPath, active.descriptor.backingFolder)) return;
  await active.setBackingFolder(chosen[0].fsPath);
  void vscode.window.showInformationMessage(`Pair Notebook: проект хоста сохраняется в ${chosen[0].fsPath}.`);
}

async function promptForNewHostFolder(active: SessionRuntime): Promise<void> {
  if (hostFolderPromptOpen || runtime !== active) return;
  const snapshot = active.snapshot();
  if (!snapshot.isHost || !snapshot.waitingForHostFolder) return;
  hostFolderPromptOpen = true;
  try {
    const action = await vscode.window.showWarningMessage(
      'Вы стали новым хостом. Сессия поставлена на паузу: выберите папку на этом компьютере, куда будет записано полное текущее состояние проекта.',
      { modal: true },
      'Выбрать папку',
    );
    if (action !== 'Выбрать папку' || runtime !== active) return;
    const chosen = await vscode.window.showOpenDialog({
      title: 'Новая папка хоста Pair Notebook',
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Сохранить проект и продолжить',
    });
    if (!chosen?.[0] || runtime !== active) return;
    if (!await confirmBackingFolderReplacement(chosen[0].fsPath, active.descriptor.backingFolder)) return;
    await active.setBackingFolder(chosen[0].fsPath);
    void vscode.window.showInformationMessage(
      `Pair Notebook: полное состояние сохранено в ${chosen[0].fsPath}; сессия продолжена.`,
    );
  } finally {
    hostFolderPromptOpen = false;
  }
}

async function confirmBackingFolderReplacement(folder: string, currentFolder: string): Promise<boolean> {
  const resolved = path.resolve(folder);
  if (currentFolder && sameFilesystemPath(resolved, path.resolve(currentFolder))) return true;
  let entries: string[];
  try {
    entries = await readdir(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (!entries.length) return true;
  const choice = await vscode.window.showWarningMessage(
    'Выбранная папка не пуста. Pair Notebook запишет в неё полное состояние сессии, заменит конфликтующие файлы и удалит лишние отслеживаемые файлы. Выберите отдельную пустую папку, если эти данные нужно сохранить.',
    { modal: true },
    'Заменить содержимое папки',
  );
  return choice === 'Заменить содержимое папки';
}

function sameFilesystemPath(left: string, right: string): boolean {
  return filesystemPathComparisonKey(left) === filesystemPathComparisonKey(right);
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
  const presence = new Map(snapshot.awareness.map((state) => [state.peer.peerId, state]));
  const current = active.computeForNotebook(notebookKey);
  const localPeerId = snapshot.descriptor.localPeer.peerId;
  const options = snapshot.peers.flatMap((peer) => {
      const local = peer.peerId === localPeerId;
      const state = local ? active.localComputePresence() : presence.get(peer.peerId);
      if (!peer.online || !state || (!local && !state.allowRemoteCompute)) return [];
      const candidates: Array<{ device: `gpu:${number}` | 'cpu'; gpu?: GpuInfo }> = [];
      const discoveredEnvironments = state.environments ?? [];
      const cpuEnvironmentReady = !discoveredEnvironments.length || discoveredEnvironments.some((environment) => environment.jupyterReady);
      const gpuEnvironmentReady = discoveredEnvironments.length
        ? discoveredEnvironments.some((environment) => environment.jupyterReady && environment.cudaAvailable)
        : state.hardware?.python.torchCudaAvailable === true;
      if ((local || state.allowCpu) && workload.value !== 'gpu' && cpuEnvironmentReady) candidates.push({ device: 'cpu' });
      if ((local || state.allowGpu) && workload.value !== 'cpu' && gpuEnvironmentReady) {
        for (const gpu of state.hardware?.gpus ?? []) candidates.push({ device: `gpu:${gpu.index}`, gpu });
      }
      return candidates.map(({ device, gpu }) => {
        const score = (gpu ? 100_000 : 0)
        + (gpu?.vramMb ?? 0)
        + (state?.hardware?.logicalThreads ?? 0) * 10
        - (state?.resources?.cpuPercent ?? 0) * 5
        - (state?.resources?.gpus.find((item) => item.index === gpu?.index)?.utilizationPercent ?? 0) * 10
        - Math.max(0, peer.latency);
        return {
          label: `${peer.peerId === current.executorId && device === current.device ? '$(check) ' : ''}${state.peer.displayName} • ${device === 'cpu' ? 'CPU' : `GPU ${gpu?.index}`}`,
          description: gpu ? `${gpu.model} • ${(gpu.vramMb / 1024).toFixed(1)} GB` : state.hardware?.cpuModel ?? 'Hardware pending',
          detail: `${state.hardware?.logicalThreads ?? '?'} threads • ${peer.latency >= 0 ? `${peer.latency} ms` : 'measuring latency'} • Python ${state.hardware?.python.version ?? '?'}`,
          peerId: peer.peerId,
          device,
          pythonPath: peer.peerId === current.executorId && device === current.device
            ? current.pythonPath ?? state.hardware?.python.executable
            : state.hardware?.python.executable,
          score,
        };
      });
    })
    .sort((a, b) => b.score - a.score);
  if (!options.length) throw new Error(`No online ${workload.value === 'any' ? 'compute' : workload.value.toUpperCase()} target is available.`);
  if (options[0]) options[0].label = `$(star-full) Recommended • ${options[0].label.replace(/^\$\(check\) /, '')}`;
  const selected = await vscode.window.showQuickPick(options, { title: 'Select Compute', placeHolder: 'Choose CPU or GPU executor' });
  if (!selected) return;
  const selectedState = selected.peerId === localPeerId ? active.localComputePresence() : presence.get(selected.peerId);
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
 * mesh transport layer. Called at activation and whenever the TURN password
 * changes; running transports keep their captured configuration.
 */
function applyMeshNetworkConfiguration(context: vscode.ExtensionContext): void {
  const configuration = vscode.workspace.getConfiguration('pairNotebook');
  void context.secrets.get('pairNotebook.turnPassword').then((turnPassword) => {
    configureMeshNetwork({
      turnUrls: configuration.get<string[]>('turnUrls', []),
      turnUsername: configuration.get<string>('turnUsername', '').trim() || undefined,
      turnPassword: turnPassword || undefined,
      proxy: {
        vscodeProxy: vscode.workspace.getConfiguration('http').get<string>('proxy') || undefined,
        vscodeProxySupport: vscode.workspace.getConfiguration('http').get<string>('proxySupport'),
      },
    });
  });
}

async function showDiagnostics(): Promise<void> {
  const snapshot = requireRuntime().snapshot();
  // networkDiagnostics is sanitized: no tokens, TURN or proxy credentials.
  const network = (() => {
    try { return runtime?.networkDiagnostics(); } catch { return undefined; }
  })() as {
    relays?: string[];
    turnEndpoints?: Array<{ url: string; transport: string }>;
    turnProbes?: Array<{ url: string; transport: string; ok: boolean; latencyMs?: number }>;
    proxy?: string;
  } | undefined;
  const lines = [
    'PAIR NOTEBOOK NETWORK DIAGNOSTICS',
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
      'TURN fallback order:',
      ...(network.turnEndpoints ?? []).map((endpoint, index) => {
        const probe = (network.turnProbes ?? []).find((item) => item.url === endpoint.url);
        const state = !probe ? 'not probed yet' : probe.ok ? `reachable (${probe.latencyMs} ms)` : 'unreachable';
        return `  ${index + 1}. [${endpoint.transport.toUpperCase()}] ${endpoint.url} — ${state}`;
      }),
      `Proxy for signalling: ${network.proxy ?? 'Direct'}`,
    );
  }
  const diagnostics = lines.join('\n');
  output.appendLine(diagnostics);
  output.show(true);
  const choice = await vscode.window.showInformationMessage('Pair Notebook diagnostics opened. Session tokens are excluded.', 'Copy Diagnostics');
  if (choice === 'Copy Diagnostics') await vscode.env.clipboard.writeText(diagnostics);
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

async function toggleRemoteCompute(): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('pairNotebook');
  const current = configuration.get<boolean>('allowRemoteCompute', false);
  const enabled = !current;
  if (enabled) {
    const confirmation = await vscode.window.showWarningMessage(
      'Разрешить удалённые вычисления? Любой участник текущей закрытой сессии сможет запускать Python-код на этом компьютере. Включайте это только для людей, которым доверяете.',
      { modal: true },
      'Разрешить удалённые вычисления',
    );
    if (confirmation !== 'Разрешить удалённые вычисления') return;
  }
  await configuration.update('allowRemoteCompute', enabled, vscode.ConfigurationTarget.Global);
  if (enabled) await configuration.update('allowCpu', true, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(`Remote compute ${!current ? 'enabled' : 'disabled'} on this computer.`);
}

async function toggleBooleanSetting(key: string, label: string): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('pairNotebook');
  const current = configuration.get<boolean>(key, true);
  await configuration.update(key, !current, vscode.ConfigurationTarget.Global);
  presence?.refresh();
  void vscode.window.showInformationMessage(`${label}: ${!current ? 'включено' : 'выключено'}.`);
}

async function changeMyCursorColor(): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('pairNotebook');
  const current = configuration.get<string>('myCursorColor', '#4FC3F7');
  const selected = await pickCursorColor('Цвет моего общего курсора', current);
  if (!selected) return;
  await configuration.update('myCursorColor', selected, vscode.ConfigurationTarget.Global);
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
  })), { title: 'Recent Pair Notebook projects' });
  if (picked) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(picked.item.workingFolder), false);
}

function startStatusUpdates(): void {
  if (statusTimer) clearInterval(statusTimer);
  const update = () => {
    if (!runtime) return status.hide();
    const snapshot = runtime.snapshot();
    const host = snapshot.awareness.find((state) => state.peer.peerId === snapshot.clock.hostId)?.peer.displayName ?? '—';
    const compute = snapshot.awareness.find((state) => state.peer.peerId === snapshot.computeExecutorId)?.peer.displayName ?? '—';
    const onlineParticipants = snapshot.peers.filter((peer) => peer.online).length;
    status.text = snapshot.runtimeState === 'waiting-for-host-folder'
      ? '$(debug-pause) Pair: waiting for host folder'
      : snapshot.runtimeState === 'reconnecting' || snapshot.runtimeState === 'syncing'
      ? `$(sync~spin) Pair: ${snapshot.runtimeState}`
      : snapshot.runtimeState === 'host-unavailable' || snapshot.runtimeState === 'executor-unavailable'
        ? `$(warning) Pair: ${snapshot.runtimeState}`
        : snapshot.kernelStatus === 'Busy'
      ? `$(sync~spin) Pair: ${compute} • Running`
      : snapshot.clock.hostId === snapshot.descriptor.localPeer.peerId
        ? `$(radio-tower) Pair: Host • ${onlineParticipants}`
        : `$(broadcast) Pair: ${onlineParticipants} • H:${host} • C:${compute}`;
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

async function rememberProject(context: vscode.ExtensionContext, descriptor: SessionDescriptor): Promise<void> {
  const recent = normalizeRecentProjects(context.globalState.get<unknown>('pairNotebook.recent', []));
  const next = rememberRecentProject(recent, {
    name: descriptor.projectName,
    workingFolder: descriptor.workingFolder,
    at: Date.now(),
  });
  await context.globalState.update('pairNotebook.recent', next);
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

function requirePresence(): PresenceRenderer {
  if (!presence) throw new Error('No active Pair Notebook session.');
  return presence;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
