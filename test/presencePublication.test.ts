import assert from 'node:assert/strict';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { encodeRelativeOffset } from '../src/core/cursorPosition';

function disposable() { return { dispose: () => undefined }; }

class Uri {
  public constructor(public readonly fsPath: string, public readonly scheme = 'file') {}
  public toString(): string { return `${this.scheme}://${this.fsPath}`; }
  public static file(value: string): Uri { return new Uri(value); }
  public static joinPath(base: Uri, ...parts: string[]): Uri { return new Uri(path.join(base.fsPath, ...parts), base.scheme); }
}
class RelativePattern { public constructor(public readonly base: string, public readonly pattern: string) {} }
class VscodeEventEmitter<T = void> {
  private readonly listeners = new Set<(value: T) => void>();
  public readonly event = (listener: (value: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  public fire(value: T): void { for (const listener of this.listeners) listener(value); }
  public dispose(): void { this.listeners.clear(); }
}

const fakeVscode: any = {
  __config: {} as Record<string, unknown>,
  Uri,
  RelativePattern,
  EventEmitter: VscodeEventEmitter,
  workspace: {
    notebookDocuments: [] as any[],
    textDocuments: [] as any[],
    getConfiguration: () => ({
      get: (key: string, fallback: unknown) => key in fakeVscode.__config ? fakeVscode.__config[key] : fallback,
      update: async (key: string, value: unknown) => { fakeVscode.__config[key] = value; },
    }),
    createFileSystemWatcher: () => ({ onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable, dispose: () => undefined }),
    onDidCreateFiles: disposable,
    onDidRenameFiles: disposable,
    onDidChangeConfiguration: disposable,
    onDidOpenNotebookDocument: disposable,
    onDidChangeTextDocument: disposable,
  },
  window: {
    activeNotebookEditor: undefined as any,
    activeTextEditor: undefined as any,
    visibleTextEditors: [] as any[],
    onDidChangeActiveTextEditor: disposable,
    onDidChangeTextEditorSelection: disposable,
    onDidChangeActiveNotebookEditor: disposable,
    onDidChangeNotebookEditorSelection: disposable,
    onDidChangeVisibleTextEditors: disposable,
    onDidChangeTextEditorVisibleRanges: disposable,
    showErrorMessage: async () => undefined,
  },
  commands: { executeCommand: async () => undefined },
  notebooks: { registerNotebookCellStatusBarItemProvider: () => disposable() },
  NotebookCellKind: { Markup: 1, Code: 2 },
  NotebookCellStatusBarAlignment: { Left: 1 },
  NotebookCellStatusBarItem: class {},
  OverviewRulerLane: { Right: 4 },
  DecorationRangeBehavior: { OpenOpen: 0 },
  Range: class { public constructor(public readonly start: unknown, public readonly end: unknown) {} },
};

const moduleWithLoader = Module as typeof Module & { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleWithLoader._load;
const moduleCacheBefore = new Set(Object.keys(require.cache));
let SessionRuntime: new (...args: any[]) => any;
let DashboardProvider: new (...args: any[]) => any;
try {
  moduleWithLoader._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'vscode') return fakeVscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ({ SessionRuntime } = require('../src/runtime/session') as { SessionRuntime: new (...args: any[]) => any });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ({ DashboardProvider } = require('../src/vscode/dashboard') as { DashboardProvider: new (...args: any[]) => any });
} finally {
  moduleWithLoader._load = originalLoad;
  // This test intentionally loads production modules against its private VS Code
  // stub. Remove only the project modules introduced by that load so a later
  // test file in the same Mocha process receives its own VS Code environment.
  for (const id of Object.keys(require.cache)) {
    if (!moduleCacheBefore.has(id) && id.includes(`${path.sep}src${path.sep}`)) delete require.cache[id];
  }
}

function descriptor(options: { role: 'host' | 'peer'; peerId: string; hostPeerId: string; workingFolder: string }): any {
  return {
    sessionId: `presence-${options.peerId}`,
    projectId: 'project',
    projectName: 'Presence project',
    mode: 'resilient',
    role: options.role,
    localPeer: { peerId: options.peerId, displayName: options.peerId, joinOrder: options.role === 'host' ? 0 : 1 },
    hostPeerId: options.hostPeerId,
    backingFolder: options.role === 'host' ? `${options.workingFolder}-backing` : '',
    workingFolder: options.workingFolder,
    createdAt: Date.now(),
    sessionEpoch: 10,
    hostEpoch: 0,
    computeExecutorId: options.hostPeerId,
    pythonPath: process.execPath,
    freshStart: options.role === 'host',
    knownPeers: [],
  };
}
function context(root: string): any {
  return {
    extensionUri: Uri.file(root),
    subscriptions: [],
    globalState: { get: (_key: string, fallback: unknown) => fallback },
  };
}
function logger(): any { return { appendLine: () => undefined }; }
function trackedEditor(root: string, file: string, line: number, character = 0, anchorLine = line): any {
  return {
    document: { uri: Uri.file(path.join(root, file)) },
    selection: { active: { line, character }, anchor: { line: anchorLine, character: 0 } },
  };
}
function localAwarenessUpdates(runtime: any): { reset: () => void; count: () => number } {
  let updates = 0;
  runtime.awareness.on('update', ({ added, updated, removed }: any, origin: unknown) => {
    if (origin !== 'remote' && [...added, ...updated, ...removed].includes(runtime.awareness.clientID)) updates += 1;
  });
  return { reset: () => { updates = 0; }, count: () => updates };
}
function semanticState(runtime: any): any { return runtime.awareness.getLocalState(); }
function destroy(runtime: any): void {
  runtime.project.destroy();
  runtime.awareness.destroy();
}

beforeEach(() => {
  fakeVscode.__config = { shareMyCursor: true, myCursorColor: '#4FC3F7' };
  fakeVscode.window.activeTextEditor = undefined;
  fakeVscode.window.activeNotebookEditor = undefined;
  fakeVscode.window.visibleTextEditors = [];
  fakeVscode.workspace.notebookDocuments = [];
  fakeVscode.workspace.textDocuments = [];
});

describe('semantic presence publication', () => {
  it('publishes line semantics only and suppresses same-line column/range noise plus duplicate blur', () => {
    const root = path.join(os.tmpdir(), 'pair-presence-semantic');
    const runtime = new SessionRuntime(descriptor({ role: 'host', peerId: 'host', hostPeerId: 'host', workingFolder: root }),
      'presence-token-that-is-long-enough', context(root), logger());
    const updates = localAwarenessUpdates(runtime);
    try {
      fakeVscode.window.activeTextEditor = trackedEditor(root, 'a.py', 4, 1);
      (runtime as any).updatePresence();
      let state = semanticState(runtime);
      assert.equal(state.activeFile, 'a.py');
      assert.equal(state.activeLine, 4);
      assert.equal(state.shareCursor, true);
      assert.equal(state.cursorColor, '#4FC3F7');
      assert.equal('cursor' in state, false, 'new packets do not publish legacy exact cursor offsets');
      assert.equal('anchor' in state, false);
      assert.equal('activeColumn' in state, false);
      assert.equal('selection' in state, false);
      assert.equal('selectionRange' in state, false);

      updates.reset();
      fakeVscode.window.activeTextEditor.selection.active.character = 17;
      (runtime as any).updatePresence();
      assert.equal(updates.count(), 0, 'column movement on the same line is not a semantic packet');

      fakeVscode.window.activeTextEditor.selection.anchor.line = 3;
      fakeVscode.window.activeTextEditor.selection.active.character = 22;
      (runtime as any).updatePresence();
      assert.equal(updates.count(), 0, 'selection-range movement with the same active line is not a semantic packet');

      fakeVscode.window.activeTextEditor.selection.active.line = 5;
      (runtime as any).updatePresence();
      assert.equal(updates.count(), 1, 'line change publishes exactly once');
      assert.equal(semanticState(runtime).activeLine, 5);

      updates.reset();
      fakeVscode.window.activeTextEditor = trackedEditor(root, 'b.py', 5, 9);
      (runtime as any).updatePresence();
      assert.equal(updates.count(), 1, 'file change publishes exactly once');
      assert.equal(semanticState(runtime).activeFile, 'b.py');

      updates.reset();
      fakeVscode.window.activeTextEditor = undefined;
      (runtime as any).updatePresence();
      state = semanticState(runtime);
      assert.equal(updates.count(), 1, 'blur publishes exactly one clear update');
      assert.equal(state.activeFile, undefined);
      assert.equal(state.activeLine, undefined);
      assert.equal(state.activeNotebookCellId, undefined);
      updates.reset();
      (runtime as any).updatePresence();
      assert.equal(updates.count(), 0, 'repeated blur does not resend the same clear state');

    } finally { destroy(runtime); }
  });

  it('publishes a stable notebook cell id and one packet for a real cell change', () => {
    const root = path.join(os.tmpdir(), 'pair-presence-cell');
    const runtime = new SessionRuntime(descriptor({ role: 'host', peerId: 'host', hostPeerId: 'host', workingFolder: root }),
      'presence-cell-token-that-is-long-enough', context(root), logger());
    const updates = localAwarenessUpdates(runtime);
    try {
      const notebookUri = Uri.file(path.join(root, 'work.ipynb'));
      const cell = (id: string, index: number, line: number) => ({
        id, index, metadata: { pairNotebookCellId: id },
        document: { uri: new Uri(path.join(root, `${id}.cell`), 'vscode-notebook-cell') },
        notebook: undefined as any,
        __line: line,
      });
      const first = cell('stable-a', 0, 2);
      const second = cell('stable-b', 1, 6);
      const notebook: any = {
        uri: notebookUri,
        cells: [first, second],
        cellCount: 2,
        getCells() { return this.cells; },
        cellAt(index: number) { return this.cells[index]; },
      };
      first.notebook = notebook;
      second.notebook = notebook;
      runtime.notebookCellId = (candidate: any) => candidate.id;
      fakeVscode.workspace.notebookDocuments = [notebook];
      fakeVscode.window.activeNotebookEditor = { notebook, selection: { start: 0 } };
      fakeVscode.window.activeTextEditor = {
        document: first.document,
        selection: { active: { line: 2, character: 10 }, anchor: { line: 2, character: 0 } },
      };
      (runtime as any).updatePresence();
      let state = semanticState(runtime);
      assert.equal(state.activeFile, 'work.ipynb');
      assert.equal(state.activeNotebookCellId, 'stable-a');
      assert.equal(state.activeLine, 2);
      assert.equal('activeNotebookCell' in state, false, 'new semantic packets use the stable cell id, not a numeric cell index');

      updates.reset();
      fakeVscode.window.activeNotebookEditor.selection.start = 1;
      fakeVscode.window.activeTextEditor = {
        document: second.document,
        selection: { active: { line: 6, character: 3 }, anchor: { line: 6, character: 0 } },
      };
      (runtime as any).updatePresence();
      state = semanticState(runtime);
      assert.equal(updates.count(), 1);
      assert.equal(state.activeNotebookCellId, 'stable-b');
      assert.equal(state.activeLine, 6);
    } finally { destroy(runtime); }
  });

  it('preserves incoming line-only presence while legacy cursor remains receive-only compatibility', () => {
    const root = path.join(os.tmpdir(), 'pair-presence-incoming');
    const runtime = new SessionRuntime(descriptor({ role: 'peer', peerId: 'guest', hostPeerId: 'host', workingFolder: root }),
      'presence-incoming-token-that-is-long-enough', context(root), logger());
    try {
      const hostIdentity = { peerId: 'host', displayName: 'Host', joinOrder: 0 };
      (runtime as any).transport.peerRuntime = () => [hostIdentity];
      const source = new Awareness(new Y.Doc());
      source.setLocalState({
        peer: hostIdentity,
        activeFile: 'work.py',
        activeLine: 7,
        shareCursor: true,
        cursorColor: '#2196F3',
        cursor: { anchor: 12, active: 17 },
      });
      const payload = encodeAwarenessUpdate(source, [source.clientID]);
      (runtime as any).acceptAwarenessUpdate(payload, 'host');
      const remote = [...runtime.awareness.getStates().values()].find((value: any) => value?.peer?.peerId === 'host') as any;
      assert.equal(remote.activeLine, 7, 'line-only remote presence survives sanitization');
      assert.deepEqual(remote.cursor, { anchor: 12, active: 17 },
        'legacy exact cursor is accepted only on incoming compatibility');
      source.destroy();
    } finally { destroy(runtime); }
  });

  it('keeps a remote line lock on the same logical line after inserted lines', () => {
    const root = path.join(os.tmpdir(), 'pair-line-lock-anchor');
    const runtime = new SessionRuntime(descriptor({ role: 'host', peerId: 'host', hostPeerId: 'host', workingFolder: root }),
      'line-lock-token-that-is-long-enough', context(root), logger());
    const source = new Awareness(new Y.Doc());
    try {
      runtime.project.ensureText('work.py', 'one\ntarget\nlast');
      const anchor = encodeRelativeOffset(runtime.project.text('work.py'), 4);
      assert.ok(anchor);
      const guest = { peerId: 'guest', displayName: 'Guest', joinOrder: 1 };
      (runtime as any).transport.peerRuntime = () => [guest];
      source.setLocalState({
        peer: guest,
        activeFile: 'work.py',
        activeLine: 1,
        activeLineAnchor: anchor,
        shareCursor: true,
      });
      (runtime as any).acceptAwarenessUpdate(encodeAwarenessUpdate(source, [source.clientID]), 'guest');
      assert.match(runtime.lineLockMessage('work.py', undefined, [{ rangeOffset: 4, rangeLength: 0 }], 'one\ntarget\nlast') ?? '', /Guest/);

      runtime.project.applyTextChanges('work.py', [{ offset: 0, deleteCount: 0, insertText: 'new\n' }]);
      const shifted = runtime.project.text('work.py').toString();
      assert.equal(runtime.lineLockMessage('work.py', undefined, [{ rangeOffset: 8, rangeLength: 0 }], shifted), 'Line is currently selected by Guest.');
      assert.equal(runtime.lineLockMessage('work.py', undefined, [{ rangeOffset: 0, rangeLength: 0 }], shifted), undefined);
    } finally {
      source.destroy();
      destroy(runtime);
    }
  });
});

describe('resource and compute presence publication split', () => {
  it('resource ticks are rate-limited and do not republish semantic awareness', async function () {
    this.timeout(15_000);
    const root = path.join(os.tmpdir(), 'pair-resource-split');
    const runtime = new SessionRuntime(descriptor({ role: 'host', peerId: 'host', hostPeerId: 'host', workingFolder: root }),
      'resource-token-that-is-long-enough', context(root), logger());
    const updates = localAwarenessUpdates(runtime);
    const frames: string[] = [];
    (runtime as any).transport.broadcast = (type: string) => { frames.push(type); return 'message'; };
    try {
      fakeVscode.window.activeTextEditor = trackedEditor(root, 'work.py', 9, 4);
      (runtime as any).updatePresence();
      updates.reset();
      await (runtime as any).resourceTick();
      await (runtime as any).resourceTick();
      assert.equal(updates.count(), 0, 'resource sampling produces zero semantic awareness publications');
      assert.equal(frames.filter((type) => type === 'resourcePresence').length, 1,
        'resource publication has its own five-second rate limit');
      assert.equal(semanticState(runtime).activeLine, 9, 'resource publication cannot mutate activeLine');

      frames.length = 0;
      (runtime as any).hardware = {
        cpuModel: 'CPU', logicalThreads: 8, totalRamMb: 16000, availableRamMb: 8000,
        gpus: [], python: { executable: process.execPath, version: process.version, torchInstalled: false, torchVersion: '', torchCudaAvailable: false, torchCudaVersion: '', cudaDeviceNames: [] },
        discoveredAt: Date.now(),
      };
      (runtime as any).environments = [];
      (runtime as any).publishHardwarePresence();
      (runtime as any).setKernelStatus('work.ipynb', 'Busy');
      assert.equal(updates.count(), 0, 'hardware/kernel publication does not republish line presence');
      assert.deepEqual(frames, ['hardwarePresence', 'kernelPresence']);
    } finally { destroy(runtime); }
  });

  it('merges remote resource frames into snapshots so the dashboard still updates without a presence event', async () => {
    const root = path.join(os.tmpdir(), 'pair-resource-dashboard');
    const runtime = new SessionRuntime(descriptor({ role: 'peer', peerId: 'guest', hostPeerId: 'host', workingFolder: root }),
      'resource-dashboard-token-that-is-long-enough', context(root), logger());
    const host = {
      peerId: 'host', displayName: 'Host', joinOrder: 0, latency: 10, latencyEma: 10,
      lastHeartbeat: Date.now(), missedHeartbeats: 0, route: 'Direct', online: true, connectionState: 'connected',
    };
    (runtime as any).transport.peerRuntime = () => [host];
    (runtime as any).transport.activeRouteUpgrades = () => [];
    (runtime as any).transport.getRemoteRouteStatus = () => undefined;
    (runtime as any).transport.activeSignallingFamilies = () => [];
    runtime.awareness.getStates().set(4242, {
      peer: { peerId: 'host', displayName: 'Host', joinOrder: 0 },
      activeFile: 'work.py', activeLine: 3, shareCursor: true, cursorColor: '#4FC3F7', kernelStatus: 'Offline',
    });
    let presenceEvents = 0;
    runtime.on('presence', () => { presenceEvents += 1; });
    try {
      await (runtime as any).onMessage({
        type: 'resourcePresence',
        meta: { resources: { cpuPercent: 37, ramUsedMb: 4000, ramTotalMb: 16000, gpus: [], sampledAt: Date.now() } },
        payload: new Uint8Array(),
      }, 'host');
      assert.equal(presenceEvents, 0, 'resource-only frames never trigger cursor renderer presence events');
      const hostState = runtime.snapshot().awareness.find((state: any) => state.peer.peerId === 'host');
      assert.equal(hostState?.resources?.cpuPercent, 37, 'snapshot overlays separately published resources');

      const posted: any[] = [];
      const view: any = {
        show: () => undefined,
        webview: {
          cspSource: 'vscode-webview://pair-notebook',
          options: {},
          onDidReceiveMessage: () => disposable(),
          postMessage: async (message: unknown) => { posted.push(message); return true; },
        },
      };
      Object.defineProperty(view.webview, 'html', { set: () => undefined });
      const provider = new DashboardProvider(context(root));
      provider.resolveWebviewView(view);
      provider.setRuntime(runtime);
      const stateMessages = posted.filter((message) => message?.type === 'state');
      const latest = stateMessages.at(-1)?.patch;
      assert.ok(latest?.participants?.some((participant: any) => participant.id === 'host' && /CPU 37%/.test(participant.load)),
        'dashboard continues to render separately published resource telemetry');
      provider.dispose();
    } finally { destroy(runtime); }
  });
});
