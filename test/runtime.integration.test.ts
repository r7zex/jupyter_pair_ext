import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { WebSocketServer } from 'ws';
import { CollaborativeProject } from '../src/core/crdt';
import { formatInvite, parseInvite } from '../src/core/types';
import { generateIdentityCredentials } from '../src/core/identity';
import { downloadProjectSnapshot } from '../src/runtime/bootstrap';
import { configureMeshNetwork, MeshTransport } from '../src/runtime/mesh';
import { NostrFrameRelay } from '../src/runtime/nostrRelay';
import { decodeFrame, encodeFrame } from '../src/core/wire';
import {
  createInMemoryTrysteroFactory,
  healInMemoryTrystero,
  partitionInMemoryTrystero,
  resetInMemoryTrystero,
  setInMemoryTrysteroSendObserver,
} from './support/in_memory_trystero';

const fakeVscode = createVscodeBoundary();
const moduleWithLoader = Module as typeof Module & {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = moduleWithLoader._load;
moduleWithLoader._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
// Runtime code below is production code.  Only the unavailable VS Code host
// boundary is substituted; Yjs, Trystero framing, filesystem, child process,
// and the
// synchronization protocol remain real.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SessionClosedError, SessionRuntime } = require('../src/runtime/session') as {
  SessionClosedError: new (...args: any[]) => Error & { reason: string };
  SessionRuntime: new (...args: any[]) => any;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PairNotebookController, decodeJupyterBase64 } = require('../src/vscode/jupyterController') as {
  PairNotebookController: new (...args: any[]) => any;
  decodeJupyterBase64: (value: unknown) => Buffer | undefined;
};
moduleWithLoader._load = originalLoad;

const runtimeRoomFactory = createInMemoryTrysteroFactory();

beforeEach(() => {
  resetInMemoryTrystero();
  configureMeshNetwork({ disableRelayFallback: true, disableTurnProbe: true });
  MeshTransport.setRoomFactoryForTesting(runtimeRoomFactory);
  fakeVscode.__commands.length = 0;
});

afterEach(() => {
  MeshTransport.setRoomFactoryForTesting(undefined);
  configureMeshNetwork({});
  resetInMemoryTrystero();
});

describe('production SessionRuntime integration', () => {
  it('decodes only complete canonical Base64 notebook outputs', () => {
    const encoded = Buffer.from('complete image').toString('base64');
    assert.equal(decodeJupyterBase64([encoded.slice(0, 4), encoded.slice(4)])?.toString('utf8'), 'complete image');
    assert.equal(decodeJupyterBase64('not-valid-base64'), undefined);
    assert.equal(decodeJupyterBase64(`${encoded}AAAA`), undefined);
  });

  it('downloads a complete host snapshot without asking the joining peer for a backing folder', async function () {
    this.timeout(30_000);
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-bootstrap-success-'));
    const extensionRoot = path.join(root, 'extension');
    const hostFolder = path.join(root, 'host');
    const joiningFolder = path.join(root, 'joining-working-copy');
    await Promise.all([
      mkdir(extensionRoot, { recursive: true }),
      mkdir(hostFolder, { recursive: true }),
      mkdir(path.join(hostFolder, 'empty-directory'), { recursive: true }),
    ]);
    await writeFile(path.join(hostFolder, 'notes.txt'), 'from host', 'utf8');
    await writeFile(path.join(hostFolder, 'asset.bin'), Buffer.from([0, 1, 2, 255]));
    const sessionId = `bootstrap-${Date.now()}`;
    const token = 'bootstrap-success-token-that-is-long-enough';
    const host = new SessionRuntime(descriptor({
      sessionId,
      role: 'host',
      peerId: 'host',
      hostPeerId: 'host',
      workingFolder: hostFolder,
      pythonPath: process.execPath,
    }), token, context(extensionRoot), logger());
    try {
      await host.start();
      // An open VS Code editor can own the working-copy write while its file on
      // disk is still stale. Bootstrap must therefore snapshot authoritative
      // CRDT bytes, not rescan the physical working directory.
      host.setWorkingCopyWriter(async () => true);
      host.project.replaceText('notes.txt', 'latest collaborative state');
      await host.flush();
      assert.equal(await readFile(path.join(hostFolder, 'notes.txt'), 'utf8'), 'from host');
      assert.equal(await readFile(path.join(`${hostFolder}-backing`, 'notes.txt'), 'utf8'), 'latest collaborative state');
      await downloadProjectSnapshot({
        sessionId,
        projectId: host.descriptor.projectId,
        projectName: host.descriptor.projectName,
        mode: 'resilient',
        token,
        sessionEpoch: host.descriptor.sessionEpoch,
        hostPeerId: 'host',
        hostDisplayName: 'host',
      }, {
        peerId: 'joining-peer',
        displayName: 'Joining Peer',
        joinOrder: 1,
      }, joiningFolder, undefined, runtimeRoomFactory);
      assert.equal(await readFile(path.join(joiningFolder, 'notes.txt'), 'utf8'), 'latest collaborative state');
      assert.deepEqual(await readFile(path.join(joiningFolder, 'asset.bin')), Buffer.from([0, 1, 2, 255]));
      assert.equal(await directoryExists(path.join(joiningFolder, 'empty-directory')), true);
      assert.equal(host.snapshot().peers.some((peer: any) => peer.peerId === 'joining-peer'), false, 'bootstrap connections are not session participants');
    } finally {
      host.descriptor.mode = 'host-only';
      await host.leave();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resumes a snapshot from completed files after authenticated route replacement', async function () {
    this.timeout(30_000);
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-bootstrap-recovery-'));
    const extensionRoot = path.join(root, 'extension');
    const hostFolder = path.join(root, 'host');
    const joiningFolder = path.join(root, 'joining-working-copy');
    await Promise.all([
      mkdir(extensionRoot, { recursive: true }),
      mkdir(hostFolder, { recursive: true }),
    ]);
    const firstContents = 'completed before route replacement';
    const secondContents = Buffer.alloc(192 * 1024, 73);
    await Promise.all([
      writeFile(path.join(hostFolder, 'a-first.txt'), firstContents, 'utf8'),
      writeFile(path.join(hostFolder, 'b-second.bin'), secondContents),
    ]);
    const sessionId = `bootstrap-recovery-${Date.now()}`;
    const token = 'bootstrap-recovery-token-that-is-long-enough';
    const host = new SessionRuntime(descriptor({
      sessionId,
      role: 'host',
      peerId: 'host',
      hostPeerId: 'host',
      workingFolder: hostFolder,
      pythonPath: process.execPath,
    }), token, context(extensionRoot), logger());
    const snapshotRequests: Array<{ completed: Record<string, string>; snapshotId: string }> = [];
    const sendSnapshot = host.sendSnapshot.bind(host);
    host.sendSnapshot = async (
      peerId: string,
      completed: Record<string, string>,
      snapshotId: string,
    ) => {
      snapshotRequests.push({ completed: { ...completed }, snapshotId });
      return sendSnapshot(peerId, completed, snapshotId);
    };
    let routeReplaced = false;
    let healTimer: NodeJS.Timeout | undefined;
    try {
      setInMemoryTrysteroSendObserver((_namespace, payload) => {
        if (routeReplaced || !(payload instanceof ArrayBuffer)) return;
        try {
          if (decodeFrame(Buffer.from(payload)).type !== 'snapshotFileEnd') return;
        } catch {
          return;
        }
        routeReplaced = true;
        partitionInMemoryTrystero();
        healTimer = setTimeout(() => healInMemoryTrystero(), 100);
      });
      await host.start();
      await downloadProjectSnapshot({
        sessionId,
        projectId: host.descriptor.projectId,
        projectName: host.descriptor.projectName,
        mode: 'resilient',
        token,
        sessionEpoch: host.descriptor.sessionEpoch,
        hostPeerId: 'host',
        hostDisplayName: 'host',
      }, {
        peerId: 'joining-peer',
        displayName: 'Joining Peer',
        joinOrder: 1,
      }, joiningFolder, undefined, runtimeRoomFactory);

      assert.equal(routeReplaced, true);
      assert.equal(snapshotRequests.length, 2);
      assert.notEqual(snapshotRequests[0]?.snapshotId, snapshotRequests[1]?.snapshotId);
      assert.equal(
        snapshotRequests[1]?.completed['a-first.txt'],
        createHash('sha256').update(firstContents).digest('hex'),
      );
      assert.equal(await readFile(path.join(joiningFolder, 'a-first.txt'), 'utf8'), firstContents);
      assert.deepEqual(await readFile(path.join(joiningFolder, 'b-second.bin')), secondContents);
    } finally {
      if (healTimer) clearTimeout(healTimer);
      setInMemoryTrysteroSendObserver(undefined);
      healInMemoryTrystero();
      host.descriptor.mode = 'host-only';
      await host.leave();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('downloads a complete snapshot over the emergency relay when WebRTC discovery is unavailable', async function () {
    this.timeout(30_000);
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-bootstrap-relay-only-'));
    const extensionRoot = path.join(root, 'extension');
    const hostFolder = path.join(root, 'host');
    const joiningFolder = path.join(root, 'joining-working-copy');
    await Promise.all([
      mkdir(extensionRoot, { recursive: true }),
      mkdir(hostFolder, { recursive: true }),
    ]);
    await writeFile(path.join(hostFolder, 'relay-only.txt'), 'delivered without WebRTC', 'utf8');
    const hub = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => hub.on('listening', resolve));
    const hubPort = (hub.address() as { port: number }).port;
    hub.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw)) as unknown[];
        if (message[0] !== 'EVENT') return;
        for (const client of hub.clients) {
          if (client.readyState === 1) client.send(JSON.stringify(['EVENT', 'sub', message[1]]));
        }
      });
    });
    const deadRoom = {
      makeAction: () => ({ onMessage: () => undefined, send: async () => undefined }),
      onPeerJoin: () => undefined,
      onPeerLeave: () => undefined,
      ping: async () => -1,
      leave: async () => undefined,
    };
    const deadRoomFactory = () => deadRoom as never;
    configureMeshNetwork({
      disableRelayFallback: false,
      relayFactory: ({ token, sessionId, localPeerId }) => new NostrFrameRelay({
        token,
        sessionId,
        localPeerId,
        relays: [`ws://127.0.0.1:${hubPort}`],
      }),
    });
    MeshTransport.setRoomFactoryForTesting(deadRoomFactory);
    const sessionId = `bootstrap-relay-only-${Date.now()}`;
    const token = 'bootstrap-relay-only-token-that-is-long-enough';
    const host = new SessionRuntime(descriptor({
      sessionId,
      role: 'host',
      peerId: 'host',
      hostPeerId: 'host',
      workingFolder: hostFolder,
      pythonPath: process.execPath,
    }), token, context(extensionRoot), logger());
    try {
      await host.start();
      await downloadProjectSnapshot({
        sessionId,
        projectId: host.descriptor.projectId,
        projectName: host.descriptor.projectName,
        mode: 'resilient',
        token,
        sessionEpoch: host.descriptor.sessionEpoch,
        hostPeerId: 'host',
        hostDisplayName: 'host',
      }, {
        peerId: 'joining-peer',
        displayName: 'Joining Peer',
        joinOrder: 1,
      }, joiningFolder, undefined, deadRoomFactory);

      assert.equal(await readFile(path.join(joiningFolder, 'relay-only.txt'), 'utf8'), 'delivered without WebRTC');
    } finally {
      host.descriptor.mode = 'host-only';
      await host.leave();
      await new Promise<void>((resolve) => hub.close(() => resolve()));
      configureMeshNetwork({});
      MeshTransport.setRoomFactoryForTesting(runtimeRoomFactory);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('converges through Trystero/Yjs and executes guest code only on the host', async function () {
    this.timeout(30_000);
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-runtime-'));
    const hostFolder = path.join(root, 'host');
    const peerFolder = path.join(root, 'peer');
    const extensionRoot = path.join(root, 'extension');
    await Promise.all([
      mkdir(hostFolder, { recursive: true }),
      mkdir(peerFolder, { recursive: true }),
      mkdir(path.join(extensionRoot, 'media'), { recursive: true }),
    ]);
    await writeFile(path.join(hostFolder, 'notes.txt'), 'host text', 'utf8');
    await writeFile(path.join(hostFolder, 'model.bin'), 'NEW_MODEL', 'utf8');
    await writeFile(path.join(peerFolder, 'model.bin'), 'OLD_MODEL', 'utf8');
    await writeFile(path.join(hostFolder, 'work.ipynb'), JSON.stringify({
      cells: [
        { cell_type: 'code', id: 'a', metadata: {}, source: ['a = 1'], execution_count: null, outputs: [] },
        { cell_type: 'code', id: 'b', metadata: {}, source: ['b = 1'], execution_count: null, outputs: [] },
      ],
      metadata: { language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 5,
    }), 'utf8');
    const fakeBridge = path.join(extensionRoot, 'media', 'jupyter_kernel_bridge.py');
    await writeFile(fakeBridge, fakeBridgeSource(), 'utf8');
    if (process.platform !== 'win32') await chmod(fakeBridge, 0o755);

    const token = 'runtime-integration-token-that-is-long-enough';
    const sessionId = `runtime-${Date.now()}`;
    const hostDescriptor = descriptor({
      sessionId, role: 'host', peerId: 'host', hostPeerId: 'host', workingFolder: hostFolder,
      pythonPath: process.execPath,
    });
    const host = new SessionRuntime(hostDescriptor, token, context(extensionRoot), logger());
    let peer: any;
    try {
      await host.start();
      const peerDescriptor = descriptor({
        sessionId, role: 'peer', peerId: 'peer-z', hostPeerId: 'host', workingFolder: peerFolder,
        pythonPath: process.execPath,
        knownPeers: [{ ...host.descriptor.localPeer }],
      });
      peer = new SessionRuntime(peerDescriptor, token, context(extensionRoot), logger());
      await peer.start();
      await waitFor(() => peer.project.has('work.ipynb') && host.snapshot().awareness.some((state: any) => state.peer.peerId === 'peer-z'), 5000, 'initial runtime state');
      await waitFor(() => peer.descriptor.localPeer.joinOrder === 1, 2000, 'host-assigned participant order');
      assert.equal(host.snapshot().peers.find((item: any) => item.peerId === 'peer-z')?.joinOrder, 1);
      assert.deepEqual(
        peer.project.notebookSnapshot('work.ipynb').cells.map((cell: any) => cell.id),
        ['a', 'b'],
      );

      const activeDocument = {
        uri: new fakeVscode.Uri(path.join(peerFolder, 'cell-b'), 'vscode-notebook-cell'),
        offsetAt: (value: number) => value,
      };
      const activeCell: any = { metadata: { pairNotebookCellId: 'b' }, document: activeDocument };
      const activeNotebook = {
        uri: fakeVscode.Uri.file(path.join(peerFolder, 'work.ipynb')),
        cellAt: () => activeCell,
      };
      activeCell.notebook = activeNotebook;
      fakeVscode.window.activeNotebookEditor = { notebook: activeNotebook, selection: { start: 1 } };
      fakeVscode.window.activeTextEditor = {
        document: activeDocument,
        selection: { anchor: 2, active: 3 },
      };
      peer.updatePresence();
      await waitFor(() => host.snapshot().awareness.some((state: any) =>
        state.peer.peerId === 'peer-z' && state.activeNotebookCellId === 'b'), 3000, 'stable cursor cell identity');
      fakeVscode.window.activeNotebookEditor.selection.start = 0;
      peer.updatePresence();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const movedCellPresence = host.snapshot().awareness.find((state: any) => state.peer.peerId === 'peer-z');
      assert.equal(movedCellPresence?.activeNotebookCellId, 'b');
      assert.equal(movedCellPresence?.activeNotebookCell, undefined,
        'stable cell identity survives a numeric cell move without publishing the legacy cell index');
      fakeVscode.window.activeNotebookEditor = undefined;
      fakeVscode.window.activeTextEditor = undefined;

      const createdPath = path.join(hostFolder, 'created.txt');
      await writeFile(createdPath, 'created', 'utf8');
      await host.onLocalFile(fakeVscode.Uri.file(createdPath), 'create');
      await waitFor(() => peer.project.has('created.txt') && peer.project.text('created.txt').toString() === 'created', 3000, 'file creation');
      await writeFile(createdPath, 'changed immediately', 'utf8');
      await host.onLocalFile(fakeVscode.Uri.file(createdPath), 'change');
      await waitFor(() => peer.project.text('created.txt').toString() === 'changed immediately', 3000, 'rapid file modification');
      const movedPath = path.join(hostFolder, 'moved.txt');
      await rename(createdPath, movedPath);
      await host.onLocalRename(fakeVscode.Uri.file(createdPath), fakeVscode.Uri.file(movedPath));
      await waitFor(() => peer.project.has('moved.txt') && !peer.project.has('created.txt'), 3000, 'file rename');
      await waitFor(async () => await fileExists(path.join(peerFolder, 'moved.txt')), 3000, 'renamed file persistence');
      const emptyDirectory = path.join(hostFolder, 'empty-dir');
      await mkdir(emptyDirectory);
      await host.onCreatedFromExplorer(fakeVscode.Uri.file(emptyDirectory));
      await waitFor(() => directoryExists(path.join(peerFolder, 'empty-dir')), 3000, 'empty directory synchronization');

      const zeroBytePath = path.join(hostFolder, 'empty.txt');
      await writeFile(zeroBytePath, '');
      await host.onLocalFile(fakeVscode.Uri.file(zeroBytePath), 'create');
      await waitFor(async () => peer.project.has('empty.txt')
        && await fileExists(path.join(peerFolder, 'empty.txt'))
        && (await readFile(path.join(peerFolder, 'empty.txt'))).byteLength === 0, 3000, 'zero-byte text synchronization');

      const rawDirectory = path.join(hostFolder, 'raw-mkdir');
      await mkdir(rawDirectory);
      await host.onLocalFile(fakeVscode.Uri.file(rawDirectory), 'create');
      await waitFor(() => directoryExists(path.join(peerFolder, 'raw-mkdir')), 3000, 'raw mkdir synchronization');

      const outsideDirectory = path.join(root, 'outside-project');
      const linkedDirectory = path.join(hostFolder, 'linked-outside');
      await mkdir(outsideDirectory);
      await writeFile(path.join(outsideDirectory, 'secret.txt'), 'must not be shared', 'utf8');
      await symlink(outsideDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
      await host.onLocalFile(fakeVscode.Uri.file(path.join(linkedDirectory, 'secret.txt')), 'create');
      assert.equal(host.project.has('linked-outside/secret.txt'), false, 'watcher cannot follow a symlink outside the project');
      assert.equal(peer.project.has('linked-outside/secret.txt'), false, 'external file is never published to peers');

      await rm(movedPath);
      await host.onLocalDelete(fakeVscode.Uri.file(movedPath));
      await waitFor(() => !peer.project.has('moved.txt'), 3000, 'file deletion');

      assert.throws(
        () => host.changeCompute('peer-z', 'work.ipynb', 'cpu'),
        /always owned by the current Session Host/,
      );
      assert.throws(
        () => peer.changeCompute('peer-z', 'work.ipynb', 'cpu'),
        /Only the current Session Host/,
      );
      host.changeCompute('host', 'work.ipynb', 'cpu');
      const hostCompute = host.computeForNotebook('work.ipynb');
      await waitFor(() => peer.computeForNotebook('work.ipynb').epoch === hostCompute.epoch, 3000, 'host compute selection propagation');

      // A guest changes a dependency while the host editor owns its unsaved
      // working copy. Background persistence must not save it; execution must.
      peer.project.replaceText('notes.txt', 'guest dependency');
      await waitFor(() => host.project.text('notes.txt').toString() === 'guest dependency', 3000, 'dependency convergence');
      host.setWorkingCopyWriter(async (key: string) => key === 'notes.txt', async () => {
        await writeFile(path.join(hostFolder, 'notes.txt'), host.project.text('notes.txt').toString());
      });
      await host.flush();
      assert.equal(await readFile(path.join(hostFolder, 'notes.txt'), 'utf8'), 'host text');
      const events: any[] = [];
      const first = await peer.executeCell('work.ipynb', 'a', 'read model', (event: any) => events.push(event));
      assert.equal(first.success, true);
      assert.equal(await readFile(path.join(hostFolder, 'notes.txt'), 'utf8'), 'guest dependency');
      assert.equal(host.completedExecutionBarriers.size, 0, 'accepted lightweight requests consume barrier authorization');
      assert.ok(events.some((event) => event.messageType === 'execute_result'
        && event.content?.data?.['text/plain'] === 'NEW_MODEL'));
      assert.ok(events.some((event) => event.content?.data?.['application/x-pair-test-dependency'] === 'guest dependency'),
        'the kernel subprocess reads the synchronized dependency before reporting its result');

      // The standard controller publishes streaming/final outputs into the
      // notebook CRDT. A third participant therefore renders the result without
      // executing the code a second time on their own machine.
      const sharedController = new PairNotebookController(logger());
      const sharedNotebook: any = {
        uri: fakeVscode.Uri.file(path.join(hostFolder, 'work.ipynb')),
        cells: [] as any[],
        get cellCount() { return this.cells.length; },
        getCells() { return this.cells; },
        cellAt(index: number) { return this.cells[index]; },
      };
      const sharedCell = fakeCell('a', sharedNotebook);
      host.notebookCellIds.seed(sharedCell, 'a', 'a');
      sharedController.setRuntime(host);
      const sharedProductionController = fakeVscode.__controllers.at(-1);
      await sharedProductionController.executeHandler([sharedCell], sharedNotebook);
      await waitFor(() => peer.project.notebookSnapshot('work.ipynb').cells[0].outputs.length > 0, 2000, 'shared execution output');
      assert.equal(
        Buffer.from(peer.project.notebookSnapshot('work.ipynb').cells[0].outputs[0].items[0].dataBase64, 'base64').toString('utf8'),
        'NEW_MODEL',
      );
      sharedController.dispose();

    } finally {
      fakeVscode.window.activeNotebookEditor = undefined;
      fakeVscode.window.activeTextEditor = undefined;
      host.descriptor.mode = 'host-only';
      if (peer) peer.descriptor.mode = 'host-only';
      await Promise.allSettled([host.leave(), peer?.leave?.()]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('closes resilient guests after unrecoverable host loss without changing authority', async function () {
    this.timeout(40_000);
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-failover-'));
    const extensionRoot = path.join(root, 'extension');
    const folders = [path.join(root, 'host'), path.join(root, 'peer-b'), path.join(root, 'peer-c')];
    await Promise.all([...folders.map((folder) => mkdir(folder, { recursive: true })), mkdir(path.join(extensionRoot, 'media'), { recursive: true })]);
    await writeFile(path.join(folders[0]!, 'work.ipynb'), JSON.stringify({
      cells: [{ cell_type: 'code', id: 'a', metadata: {}, source: ['value = 1'], execution_count: null, outputs: [] }],
      metadata: { language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 5,
    }), 'utf8');
    await writeFile(path.join(extensionRoot, 'media', 'jupyter_kernel_bridge.py'), fakeBridgeSource(), 'utf8');
    const token = 'failover-integration-token-that-is-long-enough';
    const sessionId = `failover-${Date.now()}`;
    const host = new SessionRuntime(descriptor({
      sessionId, role: 'host', peerId: 'host', hostPeerId: 'host', workingFolder: folders[0]!,
      pythonPath: process.execPath,
    }), token, context(extensionRoot), logger());
    let peerB: any;
    let peerC: any;
    const closeReasons = new Map<string, string>();
    const terminalReasons = new Map<string, string>();
    try {
      await host.start();
      peerB = new SessionRuntime(descriptor({
        sessionId, role: 'peer', peerId: 'peer-b', hostPeerId: 'host', workingFolder: folders[1]!,
        pythonPath: process.execPath, knownPeers: [{ ...host.descriptor.localPeer }],
      }), token, context(extensionRoot), logger());
      peerB.once('closed', (reason: string) => closeReasons.set('peer-b', reason));
      peerB.once('terminal', (event: any) => terminalReasons.set('peer-b', event.reason));
      await peerB.start();
      peerC = new SessionRuntime(descriptor({
        sessionId, role: 'peer', peerId: 'peer-c', hostPeerId: 'host', workingFolder: folders[2]!,
        pythonPath: process.execPath, knownPeers: [{ ...host.descriptor.localPeer }],
      }), token, context(extensionRoot), logger());
      peerC.once('closed', (reason: string) => closeReasons.set('peer-c', reason));
      peerC.once('terminal', (event: any) => terminalReasons.set('peer-c', event.reason));
      await peerC.start();
      useFastLogicalRecovery(peerB, peerC);
      await waitFor(() => peerB.snapshot().peers.some((peer: any) => peer.peerId === 'peer-c' && peer.online), 5000, 'peer mesh');
      await waitFor(() => peerB.descriptor.localPeer.joinOrder === 1
        && peerC.descriptor.localPeer.joinOrder === 2, 2000, 'monotonic host-assigned participant order');
      const peerBClosed = onceEvent(peerB, 'closed', 15_000);
      const peerCClosed = onceEvent(peerC, 'closed', 15_000);
      partitionInMemoryTrystero();
      await Promise.all([peerBClosed, peerCClosed]);
      for (const peer of [peerB, peerC]) {
        assert.equal(peer.snapshot().clock.hostId, 'host');
        assert.equal(peer.snapshot().clock.hostEpoch, 0);
        assert.equal(peer.snapshot().descriptor.role, 'peer');
        assert.equal(peer.snapshot().waitingForHostFolder, false);
      }
      assert.equal(closeReasons.get('peer-b'), 'host-unreachable');
      assert.equal(closeReasons.get('peer-c'), 'host-unreachable');
      assert.equal(terminalReasons.get('peer-b'), 'host-unreachable');
      assert.equal(terminalReasons.get('peer-c'), 'host-unreachable');
    } finally {
      healInMemoryTrystero();
      for (const runtime of [host, peerB, peerC].filter(Boolean)) runtime.descriptor.mode = 'host-only';
      await Promise.allSettled([host.leave(), peerB?.leave?.(), peerC?.leave?.()]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never creates independent hosts in isolated guest partitions', async function () {
    this.timeout(35_000);
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-equal-epoch-'));
    const extensionRoot = path.join(root, 'extension');
    const folders = {
      host: path.join(root, 'host'),
      alpha: path.join(root, 'alpha'),
      beta: path.join(root, 'beta'),
    };
    await Promise.all([mkdir(extensionRoot, { recursive: true }), ...Object.values(folders).map((folder) => mkdir(folder, { recursive: true }))]);
    const sessionId = `equal-epoch-${Date.now()}`;
    const token = 'equal-epoch-reconciliation-token-long-enough';
    const host = new SessionRuntime(descriptor({
      sessionId, role: 'host', peerId: 'host', hostPeerId: 'host', workingFolder: folders.host,
      pythonPath: process.execPath,
    }), token, context(extensionRoot), logger());
    let alpha: any;
    let beta: any;
    try {
      await host.start();
      alpha = new SessionRuntime(descriptor({
        sessionId, role: 'peer', peerId: 'alpha', hostPeerId: 'host', workingFolder: folders.alpha,
        pythonPath: process.execPath, knownPeers: [{ ...host.descriptor.localPeer }],
      }), token, context(extensionRoot), logger());
      beta = new SessionRuntime(descriptor({
        sessionId, role: 'peer', peerId: 'beta', hostPeerId: 'host', workingFolder: folders.beta,
        pythonPath: process.execPath, knownPeers: [{ ...host.descriptor.localPeer }],
      }), token, context(extensionRoot), logger());
      beta.descriptor.localPeer.joinOrder = 2;
      await alpha.start();
      await beta.start();
      await waitFor(() => alpha.snapshot().peers.some((peer: any) => peer.peerId === 'beta' && peer.online), 5000, 'full mesh before partition');
      useFastLogicalRecovery(alpha, beta);

      const alphaClosed = onceEvent(alpha, 'closed', 15_000);
      const betaClosed = onceEvent(beta, 'closed', 15_000);
      partitionInMemoryTrystero();
      await Promise.all([alphaClosed, betaClosed]);
      for (const peer of [alpha, beta]) {
        assert.equal(peer.coordinator.clock.hostId, 'host');
        assert.equal(peer.coordinator.clock.hostEpoch, 0);
        assert.equal(peer.snapshot().descriptor.role, 'peer');
      }
    } finally {
      healInMemoryTrystero();
      if (!host.snapshot().closed) {
        host.descriptor.mode = 'host-only';
        await host.leave().catch(() => undefined);
      }
      if (alpha) alpha.descriptor.mode = 'host-only';
      if (beta) beta.descriptor.mode = 'host-only';
      await Promise.allSettled([alpha?.leave(), beta?.leave()]);
      await rm(root, { recursive: true, force: true });
    }
  });
});


describe('runtime repair invariants', () => {
  it('rejects realtime case and Unicode path conflicts but permits a case-only tree rename', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-runtime-path-case-'));
    const extensionRoot = path.join(root, 'extension');
    await Promise.all([mkdir(root, { recursive: true }), mkdir(extensionRoot, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: `path-case-${Date.now()}`, role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: root, pythonPath: process.execPath,
    }), 'runtime-path-case-token-that-is-long-enough', context(extensionRoot), logger());
    try {
      const live = { version: 1, author: 'host', kind: 'text', deleted: false };
      (runtime as any).fileRevisionCounter = 1;
      (runtime as any).fileStates.set('Folder/original.txt', live);
      runtime.project.ensureText('Folder/original.txt', 'safe');
      assert.throws(
        () => (runtime as any).ensureLiveFileState('folder/other.txt', 'text'),
        /conflicts by portable spelling/i,
      );

      const unicodeNfc = 'Caf\u00e9.txt';
      const unicodeNfd = 'Cafe\u0301.txt';
      (runtime as any).fileStates.set(unicodeNfc, live);
      runtime.project.ensureText(unicodeNfc, 'portable');
      assert.throws(
        () => (runtime as any).ensureLiveFileState(unicodeNfd, 'text'),
        /conflicts by portable spelling/i,
      );

      const fromState = { version: 2, author: 'host', kind: 'directory', deleted: true };
      const toState = { version: 3, author: 'host', kind: 'directory', deleted: false };
      assert.doesNotThrow(() => (runtime as any).renameFileStates('Folder', 'folder', fromState, toState));
      assert.equal((runtime as any).fileStates.get('Folder/original.txt').deleted, true);
      assert.equal((runtime as any).fileStates.get('folder/original.txt').deleted, false);
    } finally {
      await runtime.leave();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('restores compute epochs, pins targets to the host, and rejects participant announcements', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-compute-clock-'));
    const extensionRoot = path.join(root, 'extension');
    await mkdir(extensionRoot, { recursive: true });
    const makeRuntime = async (name: string): Promise<any> => {
      const folder = path.join(root, name);
      await mkdir(folder, { recursive: true });
      const saved = descriptor({
        sessionId: `compute-${name}`, role: 'host', peerId: name, hostPeerId: name,
        workingFolder: folder, pythonPath: process.execPath,
      });
      saved.notebookCompute = {
        'work.ipynb': { executorId: 'peer-a', device: 'cpu', epoch: 9, author: 'peer-a' },
      };
      return new SessionRuntime(saved, 'compute-clock-token-that-is-long-enough', context(extensionRoot), logger());
    };
    const first = await makeRuntime('first');
    const second = await makeRuntime('second');
    try {
      assert.equal((first as any).computeEpoch, 9, 'constructor restores the maximum persisted epoch');
      assert.equal((second as any).computeEpoch, 9, 'every restarted peer restores the same persisted epoch floor');
      first.project.ensureNotebook('work.ipynb');
      const peerB = {
        type: 'computeChanged', payload: new Uint8Array(),
        meta: {
          notebookKey: 'work.ipynb', computeEpoch: 10,
          target: { executorId: 'peer-b', device: 'cpu', epoch: 10, author: 'peer-b' },
        },
      };
      const peerZ = {
        type: 'computeChanged', payload: new Uint8Array(),
        meta: {
          notebookKey: 'work.ipynb', computeEpoch: 10,
          target: { executorId: 'peer-z', device: 'cpu', epoch: 10, author: 'peer-z' },
        },
      };
      await (first as any).onMessage(peerB, 'peer-b');
      await (first as any).onMessage(peerZ, 'peer-z');
      await (second as any).onMessage(peerZ, 'peer-z');
      await (second as any).onMessage(peerB, 'peer-b');
      assert.equal(first.computeForNotebook('work.ipynb').epoch, second.computeForNotebook('work.ipynb').epoch);
      assert.equal(first.computeForNotebook('work.ipynb').executorId, 'first');
      assert.equal(second.computeForNotebook('work.ipynb').executorId, 'second');
      assert.equal((first as any).computeEpoch, 9);
      assert.equal((second as any).computeEpoch, 9);

      (first as any).updatePresence();
      first.changeCompute('first', 'work.ipynb', 'cpu');
      assert.equal(first.computeForNotebook('work.ipynb').epoch, 10);
      assert.equal(first.computeForNotebook('work.ipynb').author, 'first');

      await (first as any).onMessage({
        type: 'computeChanged', payload: new Uint8Array(),
        meta: {
          notebookKey: 'work.ipynb', computeEpoch: 999_999,
          target: { executorId: 'peer-b', device: 'cpu', epoch: 999_999, author: 'peer-b' },
        },
      }, 'peer-b');
      assert.equal((first as any).computeEpoch, 10, 'a participant cannot poison the compute epoch with an arbitrary jump');
    } finally {
      first.descriptor.mode = 'host-only';
      second.descriptor.mode = 'host-only';
      await Promise.allSettled([first.leave(), second.leave()]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('tracks kernel status independently for each notebook and publishes the per-notebook map', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-kernel-status-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'kernel-status', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'kernel-status-token-that-is-long-enough', context(extensionRoot), logger());
    try {
      (runtime as any).setKernelStatus('A.ipynb', 'Busy');
      (runtime as any).setKernelStatus('B.ipynb', 'Idle');
      const local = (runtime as any).awareness.getLocalState();
      assert.equal(local.kernelStatuses, undefined, 'semantic awareness excludes kernel telemetry');
      assert.deepEqual(runtime.localComputePresence()?.kernelStatuses, { 'A.ipynb': 'Busy', 'B.ipynb': 'Idle' });

      fakeVscode.window.activeNotebookEditor = { notebook: { uri: fakeVscode.Uri.file(path.join(folder, 'A.ipynb')) } };
      assert.equal(runtime.snapshot().kernelStatus, 'Busy');
      fakeVscode.window.activeNotebookEditor = { notebook: { uri: fakeVscode.Uri.file(path.join(folder, 'B.ipynb')) } };
      assert.equal(runtime.snapshot().kernelStatus, 'Idle');
    } finally {
      fakeVscode.window.activeNotebookEditor = undefined;
      runtime.descriptor.mode = 'host-only';
      await runtime.leave();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('processes live project updates while a bulk inbound operation is waiting on disk', async () => {
    const runtime: any = Object.create(SessionRuntime.prototype);
    runtime.messageQueue = Promise.resolve();
    runtime.backgroundMessageQueue = Promise.resolve();
    runtime.pendingIncomingMessages = 0;
    runtime.pendingIncomingBytes = 0;
    runtime.pendingSnapshotRequests = 0;
    runtime.log = logger();
    const observed: string[] = [];
    let releaseBulk!: () => void;
    const bulkBlocked = new Promise<void>((resolve) => { releaseBulk = resolve; });
    runtime.onMessage = async (frame: { type: string }) => {
      observed.push(frame.type);
      if (frame.type === 'binaryChunk') await bulkBlocked;
    };

    runtime.enqueueIncomingMessage({ type: 'binaryChunk', meta: {}, payload: new Uint8Array() }, 'peer');
    runtime.enqueueIncomingMessage({ type: 'projectUpdate', meta: {}, payload: new Uint8Array() }, 'peer');
    await waitFor(() => observed.includes('projectUpdate'), 1000, 'live update bypasses bulk disk wait');
    assert.deepEqual(observed, ['binaryChunk', 'projectUpdate']);
    releaseBulk();
    await runtime.backgroundMessageQueue;
  });

  it('bounds queued full-project snapshot requests independently of lightweight messages', async () => {
    const runtime: any = Object.create(SessionRuntime.prototype);
    runtime.messageQueue = Promise.resolve();
    runtime.backgroundMessageQueue = Promise.resolve();
    runtime.pendingIncomingMessages = 0;
    runtime.pendingIncomingBytes = 0;
    runtime.pendingSnapshotRequests = 0;
    runtime.log = logger();
    let releaseFirst!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let handled = 0;
    runtime.onMessage = async () => {
      handled += 1;
      if (handled === 1) await blocked;
    };
    const frame = { type: 'snapshotRequest', meta: {}, payload: new Uint8Array() };
    for (let index = 0; index < 20; index += 1) runtime.enqueueIncomingMessage(frame, `peer-${index}`);
    assert.equal(runtime.pendingSnapshotRequests, 4);
    assert.equal(runtime.pendingIncomingMessages, 4);
    releaseFirst();
    await runtime.backgroundMessageQueue;
    assert.equal(handled, 4);
    assert.equal(runtime.pendingSnapshotRequests, 0);
  });

  it('handles kernel controls while a project snapshot is blocked', async () => {
    const runtime: any = Object.create(SessionRuntime.prototype);
    Object.assign(runtime, {
      messageQueue: Promise.resolve(), backgroundMessageQueue: Promise.resolve(),
      kernelCommandQueue: Promise.resolve(), kernelCommandWindows: new Map(),
      pendingIncomingMessages: 0, pendingIncomingBytes: 0, pendingSnapshotRequests: 0,
      log: logger(),
    });
    let releaseBulk!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseBulk = resolve; });
    const handled: string[] = [];
    runtime.onMessage = async (frame: { type: string; meta: { command?: string } }) => {
      if (frame.type === 'snapshotRequest') await blocked;
      handled.push(frame.meta.command ?? frame.type);
    };
    runtime.enqueueIncomingMessage({ type: 'snapshotRequest', meta: {}, payload: new Uint8Array() }, 'joining');
    for (const command of ['interrupt', 'restart']) {
      runtime.enqueueIncomingMessage({ type: 'kernelCommand', meta: { command }, payload: new Uint8Array() }, 'peer');
    }
    await runtime.kernelCommandQueue;
    assert.deepEqual(handled, ['interrupt', 'restart']);
    assert.equal(runtime.pendingIncomingMessages, 1);
    releaseBulk();
    await runtime.backgroundMessageQueue;
    assert.deepEqual(handled, ['interrupt', 'restart', 'snapshotRequest']);
    assert.equal(runtime.pendingIncomingMessages, 0);
    assert.equal(runtime.pendingIncomingBytes, 0);
  });

  it('advertises compute hardware only from the current host', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-private-hardware-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'private-hardware', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'private-hardware-token-that-is-long-enough', context(extensionRoot), logger());
    try {
      (runtime as any).hardware = {
        cpuModel: 'Private CPU', physicalCores: 4, logicalThreads: 8, totalRamMb: 16000, availableRamMb: 8000,
        gpus: [], discoveredAt: Date.now(),
        python: { executable: 'C:\\Users\\private\\python.exe', version: '3.13', torchInstalled: false,
          torchVersion: '', torchCudaAvailable: false, torchCudaVersion: '', cudaDeviceNames: [] },
      };
      (runtime as any).resources = { cpuPercent: 10, ramUsedMb: 100, ramTotalMb: 200, gpus: [], sampledAt: Date.now() };
      (runtime as any).updatePresence();
      const advertised = runtime.awareness.getLocalState();
      assert.equal(advertised.hardware, undefined, 'semantic awareness excludes hardware telemetry');
      assert.equal(advertised.resources, undefined, 'semantic awareness excludes resource telemetry');
      assert.equal(runtime.localComputePresence()?.hardware?.python.executable, 'C:\\Users\\private\\python.exe');
      assert.equal(runtime.localComputePresence()?.resources?.cpuPercent, 10);

      const nextRuntime = new SessionRuntime(descriptor({
        sessionId: 'private-hardware-next', role: 'peer', peerId: 'participant', hostPeerId: 'host',
        workingFolder: path.join(root, 'next-project'), pythonPath: process.execPath,
      }), 'private-hardware-next-token-that-is-long-enough', context(extensionRoot), logger());
      (nextRuntime as any).hardware = (runtime as any).hardware;
      (nextRuntime as any).resources = (runtime as any).resources;
      (nextRuntime as any).updatePresence();
      assert.equal(nextRuntime.awareness.getLocalState()?.hardware, undefined);
      assert.equal(nextRuntime.localComputePresence()?.hardware, undefined);
      await (nextRuntime as any).disposeAsync();
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects host and autosave folders that alias the working copy through a symlink', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-folder-alias-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    const alias = path.join(root, 'project-alias');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    await symlink(folder, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'folder-alias', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'folder-alias-token-that-is-long-enough', context(extensionRoot), logger());
    try {
      await assert.rejects(runtime.setBackingFolder(alias), /outside the isolated working copy/i);
      await assert.rejects(runtime.setAutosaveFolder(alias), /outside the isolated working copy/i);
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reannounces remembered peers before refreshing signalling after local promotion', async () => {
    const runtime: any = Object.create(SessionRuntime.prototype);
    runtime.descriptor = {
      localPeer: { peerId: 'peer-z' },
      knownPeers: [
        { peerId: 'host', displayName: 'Host', joinOrder: 0 },
        { peerId: 'peer-z', displayName: 'Peer', joinOrder: 1 },
      ],
    };
    runtime.coordinator = { clock: { sessionEpoch: 1, hostEpoch: 2, hostId: 'peer-z' } };
    const events: string[] = [];
    const logLines: string[] = [];
    const emitted: Array<{ event: string; payload: unknown }> = [];
    runtime.log = { appendLine: (line: string) => logLines.push(line) };
    runtime.emit = (event: string, payload: unknown) => {
      emitted.push({ event, payload });
      return true;
    };
    runtime.transport = {
      refreshSignalling: async () => {
        events.push('refresh');
        return {
          requestedAt: 123,
          completedAt: 456,
          status: 'verified',
          nostr: { requestedSockets: 2, replacedSockets: 2, verifiedEndpoints: 1 },
          mqtt: { requestedSockets: 1, replacedSockets: 1, verifiedEndpoints: 1 },
        };
      },
      connect: (peer: { peerId: string }) => events.push(`connect:${peer.peerId}`),
    };

    const result = await runtime.reconnect();

    assert.deepEqual(events, ['connect:host', 'refresh']);
    assert.equal(result.status, 'verified');
    assert.equal(result.nostr.verifiedEndpoints, 1);
    assert.equal(result.mqtt.verifiedEndpoints, 1);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.event, 'connectionUpdated');
    assert.equal((emitted[0]?.payload as { kind?: string }).kind, 'manual-reconnect');
    assert.match(logLines[0] ?? '', /Manual reconnect completed .* with verified/);
    assert.doesNotMatch(JSON.stringify({ emitted, logLines }), /room-token-secret|endpoint-secret/);
  });

  it('requests the full CRDT update when a peer state vector introduces a new document', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-new-document-vector-'));
    const sourceFolder = path.join(root, 'source');
    const receiverFolder = path.join(root, 'receiver');
    const extensionRoot = path.join(root, 'extension');
    await Promise.all([
      mkdir(sourceFolder, { recursive: true }),
      mkdir(receiverFolder, { recursive: true }),
      mkdir(extensionRoot, { recursive: true }),
    ]);
    const source = new SessionRuntime(descriptor({
      sessionId: 'new-document-vector', role: 'peer', peerId: 'peer-z', hostPeerId: 'host',
      workingFolder: sourceFolder, pythonPath: process.execPath,
    }), 'new-document-vector-token-that-is-long-enough', context(extensionRoot), logger());
    const receiver = new SessionRuntime(descriptor({
      sessionId: 'new-document-vector', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: receiverFolder, pythonPath: process.execPath,
    }), 'new-document-vector-token-that-is-long-enough', context(extensionRoot), logger());
    const sent: Array<{ type: string; meta: any; payload: Uint8Array }> = [];
    (receiver as any).transport = {
      sendTo: (_peerId: string, type: string, meta: any, payload: Uint8Array = new Uint8Array()) => {
        sent.push({ type, meta, payload });
      },
      broadcast: () => undefined,
      stop: async () => undefined,
    };
    try {
      source.project.ensureText('peer-created.py', 'print("from peer")');
      const fileState = (source as any).ensureLiveFileState('peer-created.py', 'text');
      await (receiver as any).onMessage({
        type: 'stateVector',
        payload: source.project.encodeStateVector('peer-created.py'),
        meta: { key: 'peer-created.py', kind: 'text', fileState },
      }, 'peer-z');

      const stateRequest = sent.find((item) => item.type === 'stateVector');
      assert.ok(stateRequest, 'the empty receiver must request the source state instead of returning an empty diff');
      await (receiver as any).onMessage({
        type: 'stateDiff',
        payload: source.project.encodeUpdate('peer-created.py', stateRequest!.payload),
        meta: { key: 'peer-created.py', kind: 'text', fileState },
      }, 'peer-z');
      assert.equal(receiver.project.text('peer-created.py').toString(), 'print("from peer")');
    } finally {
      await Promise.all([(source as any).disposeAsync(), (receiver as any).disposeAsync()]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('defers every working-copy write until restored editors are bound', async () => {
    const runtime: any = Object.create(SessionRuntime.prototype);
    runtime.workingCopyWriter = undefined;
    runtime.deferWorkingCopyWrites = true;
    assert.equal(await runtime.writeWorkingCopy('restored.ipynb', Buffer.from('{}')), true);
  });

  it('binds awareness identity and client ownership to the admitted transport peer', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-awareness-auth-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'awareness-auth', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'awareness-auth-token-that-is-long-enough', context(extensionRoot), logger());
    const remoteDocument = new Y.Doc();
    const remoteAwareness = new Awareness(remoteDocument);
    try {
      (runtime as any).transport.peerRuntime = () => [
        { peerId: 'peer-a', displayName: 'Alice', joinOrder: 1, online: true },
        { peerId: 'peer-b', displayName: 'Bob', joinOrder: 2, online: true },
      ];
      remoteAwareness.setLocalState({
        peer: { peerId: 'victim', displayName: 'Forged Admin', joinOrder: 999 },
        activeFile: '../outside.py',
        shareCursor: true,
        cursorColor: '#123456',
        allowRemoteCompute: true,
        allowCpu: true,
      });
      assert.notEqual(remoteAwareness.clientID, runtime.awareness.clientID, 'test awareness clients must be distinct');
      const payload = encodeAwarenessUpdate(remoteAwareness, [remoteAwareness.clientID]);
      (runtime as any).acceptAwarenessUpdate(payload, 'peer-a');
      const accepted = runtime.awareness.getStates().get(remoteAwareness.clientID) as any;
      assert.deepEqual(accepted.peer, { peerId: 'peer-a', displayName: 'Alice', joinOrder: 1, online: true });
      assert.equal(accepted.activeFile, undefined);
      assert.equal(accepted.allowRemoteCompute, undefined, 'obsolete participant compute flags are stripped');
      assert.throws(() => (runtime as any).acceptAwarenessUpdate(payload, 'peer-b'), /already owned/i);
      assert.throws(() => (runtime as any).acceptAwarenessUpdate(Uint8Array.of(1), 'peer-a'), /awareness/i);
    } finally {
      remoteAwareness.destroy();
      remoteDocument.destroy();
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains awareness during recovery, accepts recovered state, and clears terminal ownership idempotently', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-awareness-lifecycle-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'awareness-lifecycle', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'awareness-lifecycle-token-that-is-long-enough', context(extensionRoot), logger());
    const remoteDocument = new Y.Doc();
    const remoteAwareness = new Awareness(remoteDocument);
    const peer = {
      peerId: 'peer-a', displayName: 'Alice', joinOrder: 1,
      online: true, connectionState: 'connected',
    };
    try {
      (runtime as any).transport.peerRuntime = () => [peer];
      (runtime as any).installTransportHandlers();
      (runtime as any).installAwarenessHandlers();

      remoteAwareness.setLocalState({
        peer,
        activeFile: 'main.py',
        activeLine: 2,
        shareCursor: true,
        cursorColor: '#123456',
      });
      const clientId = remoteAwareness.clientID;
      (runtime as any).acceptAwarenessUpdate(encodeAwarenessUpdate(remoteAwareness, [clientId]), peer.peerId);
      assert.equal((runtime.awareness.getStates().get(clientId) as any)?.activeLine, 2);
      assert.equal((runtime as any).awarenessOwnerByClientId.get(clientId), peer.peerId);
      assert.equal((runtime as any).awarenessClientsByPeer.get(peer.peerId)?.has(clientId), true);

      (runtime as any).transport.emit('peerRecovering', peer);
      assert.equal(runtime.awareness.getStates().has(clientId), true, 'recovering must retain remote awareness');
      assert.equal((runtime as any).awarenessOwnerByClientId.get(clientId), peer.peerId);

      peer.online = true;
      peer.connectionState = 'connected';
      remoteAwareness.setLocalState({
        peer,
        activeFile: 'main.py',
        activeLine: 7,
        shareCursor: true,
        cursorColor: '#123456',
      });
      (runtime as any).acceptAwarenessUpdate(encodeAwarenessUpdate(remoteAwareness, [clientId]), peer.peerId);
      assert.equal((runtime.awareness.getStates().get(clientId) as any)?.activeLine, 7, 'recovered authenticated awareness is accepted');

      remoteAwareness.setLocalState(null);
      (runtime as any).acceptAwarenessUpdate(encodeAwarenessUpdate(remoteAwareness, [clientId]), peer.peerId);
      assert.equal(runtime.awareness.getStates().has(clientId), false);
      assert.equal((runtime as any).awarenessOwnerByClientId.has(clientId), false, 'explicit remote removal clears reverse ownership');
      assert.equal((runtime as any).awarenessClientsByPeer.has(peer.peerId), false, 'explicit remote removal clears peer ownership');

      remoteAwareness.setLocalState({
        peer,
        activeFile: 'main.py',
        activeLine: 9,
        shareCursor: true,
        cursorColor: '#123456',
      });
      (runtime as any).acceptAwarenessUpdate(encodeAwarenessUpdate(remoteAwareness, [clientId]), peer.peerId);
      assert.equal((runtime.awareness.getStates().get(clientId) as any)?.activeLine, 9, 'the same authenticated peer may publish again after cleanup');

      // Simulate partially stale peer-to-client bookkeeping: terminal cleanup
      // must still discover the reverse owner and remove the actual Yjs state.
      (runtime as any).awarenessClientsByPeer.delete(peer.peerId);
      assert.equal((runtime as any).awarenessOwnerByClientId.get(clientId), peer.peerId);
      (runtime as any).transport.emit('peerDisconnected', peer);
      assert.equal(runtime.awareness.getStates().has(clientId), false, 'terminal disconnect removes remote awareness');
      assert.equal((runtime as any).awarenessOwnerByClientId.has(clientId), false);
      assert.equal((runtime as any).awarenessClientsByPeer.has(peer.peerId), false);

      (runtime as any).transport.emit('peerDisconnected', peer);
      assert.equal(runtime.awareness.getStates().has(clientId), false, 'terminal cleanup is idempotent');
      assert.equal((runtime as any).awarenessOwnerByClientId.has(clientId), false);
      assert.equal((runtime as any).awarenessClientsByPeer.has(peer.peerId), false);
    } finally {
      remoteAwareness.destroy();
      remoteDocument.destroy();
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an unsolicited execution barrier commit without deleting local work', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-barrier-auth-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'barrier-auth', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'barrier-auth-token-that-is-long-enough', context(extensionRoot), logger());
    const sent: any[] = [];
    try {
      runtime.project.ensureText('keep.txt', 'important local work');
      (runtime as any).transport.sendTo = (peerId: string, type: string, meta: unknown) => sent.push({ peerId, type, meta });
      await (runtime as any).handleExecutionBarrierCommit({
        type: 'executionBarrierCommit', payload: new Uint8Array(),
        meta: {
          requestId: 'unsolicited-commit', notebookKey: 'work.ipynb',
          target: { executorId: 'host', device: 'cpu', epoch: 0, author: 'peer-a' },
          manifest: { documents: {}, binaries: {}, directories: [] },
        },
      }, 'peer-a');
      assert.equal(runtime.project.text('keep.txt').toString(), 'important local work');
      assert.equal(sent.at(-1)?.type, 'executionBarrierAck');
      assert.equal(sent.at(-1)?.meta.success, false);

      (runtime as any).remoteComputeTargetError = () => undefined;
      const repeatableTarget = { executorId: 'host', device: 'cpu', epoch: 0, author: 'peer-a' };
      const repeatableManifest = {
        documents: { 'keep.txt': (runtime as any).projectDocumentHash('keep.txt') },
        binaries: {},
        directories: [],
      };
      await (runtime as any).handleExecutionBarrierCheck({
        type: 'executionBarrierCheck', payload: new Uint8Array(),
        meta: {
          requestId: 'repeatable-commit', notebookKey: 'work.ipynb',
          target: repeatableTarget, manifest: repeatableManifest,
        },
      }, 'peer-a');
      await (runtime as any).handleExecutionBarrierCommit({
        type: 'executionBarrierCommit', payload: new Uint8Array(),
        meta: {
          requestId: 'repeatable-commit', notebookKey: 'work.ipynb',
          target: repeatableTarget, manifest: repeatableManifest,
        },
      }, 'peer-a');
      assert.equal(sent.at(-1)?.meta.success, true);
      sent.length = 0;
      await (runtime as any).handleExecutionBarrierCommit({
        type: 'executionBarrierCommit', payload: new Uint8Array(),
        meta: {
          requestId: 'repeatable-commit', notebookKey: 'work.ipynb',
          target: repeatableTarget, manifest: repeatableManifest,
        },
      }, 'peer-a');
      assert.equal(sent.at(-1)?.type, 'executionBarrierAck');
      assert.equal(sent.at(-1)?.meta.success, true, 'a lost acknowledgement can be requested again safely');

      await (runtime as any).handleExecutionBarrierCheck({
        type: 'executionBarrierCheck', payload: new Uint8Array(),
        meta: {
          requestId: 'ambiguous-manifest', notebookKey: 'work.ipynb',
          target: { executorId: 'host', device: 'cpu', epoch: 0, author: 'peer-a' },
          manifest: {
            documents: {
              'Caf\u00e9.txt': 'a'.repeat(64),
              'Cafe\u0301.txt': 'b'.repeat(64),
            },
            binaries: {},
            directories: [],
          },
        },
      }, 'peer-a');
      assert.equal(sent.at(-1)?.type, 'executionBarrierStatus');
      assert.equal(sent.at(-1)?.meta.success, false);
      assert.match(String(sent.at(-1)?.meta.message), /malformed|unavailable/i);
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });
});


describe('remote NotebookController rendering', () => {
  it('renders outputs, running state and success without recreating the cell', async () => {
    const pairController = new PairNotebookController(logger());
    const notebook = notebookForController('remote-render-success');
    const cell = fakeCell('remote', notebook);
    cell.outputs = [];
    cell.executionSummary = undefined;
    const sameCell = cell;
    const output = new fakeVscode.NotebookCellOutput([
      fakeVscode.NotebookCellOutputItem.text('REMOTE OUTPUT'),
    ], { outputType: 'display_data' });

    try {
      await pairController.renderRemoteCellState(cell, {
        outputs: [output],
        execution: { executionOrder: 7 },
        outputsChanged: true,
        executionChanged: true,
        executionMode: 'live',
      });
      const running = fakeVscode.__executions.at(-1);
      assert.equal(running.cell, sameCell);
      assert.equal(running.started, true);
      assert.equal(running.ended, false);
      assert.equal(running.executionOrder, 7);
      assert.equal(cell.outputs.length, 1);
      assert.equal(cell.executionSummary?.executionOrder, 7);
      assert.equal(cell.executionSummary?.success, undefined);

      await pairController.renderRemoteCellState(cell, {
        outputs: [output],
        execution: { executionOrder: 7, success: true },
        outputsChanged: false,
        executionChanged: true,
        executionMode: 'live',
      });
      assert.equal(running.ended, true);
      assert.equal(running.endSuccess, true);
      assert.equal(cell.executionSummary?.success, true);
      assert.equal(cell, sameCell);
    } finally {
      pairController.dispose();
    }
  });

  it('restores final timing when timestamps are available before start', async () => {
    const pairController = new PairNotebookController(logger());
    const notebook = notebookForController('remote-render-timing');
    const cell = fakeCell('timed', notebook);
    cell.outputs = [];
    cell.executionSummary = undefined;
    try {
      await pairController.renderRemoteCellState(cell, {
        outputs: [],
        execution: {
          executionOrder: 3,
          success: true,
          timing: { startTime: 100, endTime: 250 },
        },
        outputsChanged: false,
        executionChanged: true,
        executionMode: 'snapshot',
      });
      const execution = fakeVscode.__executions.at(-1);
      assert.equal(execution.startTime, 100);
      assert.equal(execution.endTime, 250);
      assert.deepEqual(cell.executionSummary?.timing, { startTime: 100, endTime: 250 });
    } finally {
      pairController.dispose();
    }
  });

  it('maps remote failure and historical order-only state without leaving an active execution', async () => {
    const pairController = new PairNotebookController(logger());
    const notebook = notebookForController('remote-render-failure');
    const failed = fakeCell('failed', notebook);
    failed.outputs = [];
    failed.executionSummary = undefined;
    const historical = fakeCell('historical', notebook);
    historical.outputs = [];
    historical.executionSummary = undefined;
    try {
      await pairController.renderRemoteCellState(failed, {
        outputs: [],
        execution: { executionOrder: 8, success: false },
        outputsChanged: false,
        executionChanged: true,
        executionMode: 'live',
      });
      const failureExecution = fakeVscode.__executions.at(-1);
      assert.equal(failureExecution.endSuccess, false);
      assert.equal(failed.executionSummary?.success, false);

      const output = new fakeVscode.NotebookCellOutput([
        fakeVscode.NotebookCellOutputItem.text('HISTORICAL OUTPUT'),
      ]);
      await pairController.renderRemoteCellState(historical, {
        outputs: [output],
        execution: { executionOrder: 2 },
        outputsChanged: true,
        executionChanged: true,
        executionMode: 'snapshot',
      });
      const historicalExecution = fakeVscode.__executions.at(-1);
      assert.equal(historical.outputs.length, 1);
      assert.equal(historicalExecution.ended, true);
      assert.equal(historicalExecution.endSuccess, undefined);
      assert.equal(historical.executionSummary?.executionOrder, 2);
    } finally {
      pairController.dispose();
    }
  });
});

describe('compute and lifecycle regression coverage', () => {
  it('accepts a host PythonEnvironment by executable and permits a CUDA-ready non-default environment', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-env-selection-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'env-selection', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'env-selection-token-that-is-long-enough', context(extensionRoot), logger());
    try {
      runtime.project.ensureNotebook('work.ipynb');
      (runtime as any).hardware = {
          cpuModel: 'CPU', logicalThreads: 8, totalRamMb: 16000, availableRamMb: 8000, discoveredAt: Date.now(),
          gpus: [{
            index: 0, vendor: 'NVIDIA', model: 'GPU', vramMb: 8192, driver: '1', cudaVersion: '12',
            utilizationPercent: 0, memoryUsedMb: 0,
          }],
          python: {
            executable: '/default/python', version: '3.13', torchInstalled: false, torchVersion: '',
            torchCudaAvailable: false, torchCudaVersion: '', cudaDeviceNames: [],
          },
        };
      (runtime as any).environments = [
          {
            executable: '/default/python', version: '3.13', environment: 'default', jupyterReady: true,
            torchVersion: '', cudaAvailable: false, source: 'PATH',
          },
          {
            executable: '/cuda/python', version: '3.12', environment: 'cuda-env', jupyterReady: true,
            torchVersion: '2.x', cudaAvailable: true, source: 'Conda',
          },
        ];
      (runtime as any).updatePresence();
      assert.doesNotThrow(() => runtime.changeCompute('host', 'work.ipynb', 'cpu', '/cuda/python'));
      assert.equal(runtime.computeForNotebook('work.ipynb').pythonPath, '/cuda/python');
      assert.doesNotThrow(() => runtime.changeCompute('host', 'work.ipynb', 'gpu:0', '/cuda/python'));
      assert.equal(runtime.computeForNotebook('work.ipynb').device, 'gpu:0');
      assert.throws(() => runtime.changeCompute('host', 'work.ipynb', 'cpu', '/missing/python'), /cannot start a Jupyter kernel/);
      assert.throws(() => runtime.changeCompute('host', 'work.ipynb', 'gpu:0', '/default/python'), /does not expose CUDA/);
      (runtime as any).environments = [];
      (runtime as any).updatePresence();
      assert.throws(
        () => runtime.changeCompute('host', 'work.ipynb', 'cpu', '/default/python'),
        /cannot start a Jupyter kernel/,
      );
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps host CPU/GPU selectable without a remote-compute permission flag', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-local-compute-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'local-compute', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'local-compute-token-that-is-long-enough', context(extensionRoot), logger());
    try {
      runtime.project.ensureNotebook('work.ipynb');
      (runtime as any).hardware = {
        cpuModel: 'CPU', logicalThreads: 8, totalMemoryMb: 16000,
        gpus: [{ index: 0, model: 'GPU', vramMb: 8192 }],
        python: {
          executable: '/default/python', version: '3.13', torchInstalled: true, torchVersion: '2.x',
          torchCudaAvailable: true, torchCudaVersion: '12.x', cudaDeviceNames: ['GPU'],
        },
      };
      (runtime as any).environments = [{
        executable: '/cuda/python', version: '3.13', environment: 'cuda-env', jupyterReady: true,
        torchVersion: '2.x', cudaAvailable: true, source: 'PATH',
      }];
      runtime.awareness.setLocalState({
        peer: runtime.descriptor.localPeer, shareCursor: true, cursorColor: '#fff', kernelStatus: 'Offline',
        hardware: { ...(runtime as any).hardware, gpus: [] }, environments: (runtime as any).environments,
      });
      const local = runtime.localComputePresence();
      assert.equal(local?.hardware?.gpus.length, 1);
      assert.doesNotThrow(() => runtime.changeCompute('host', 'work.ipynb', 'cpu', '/cuda/python'));
      assert.doesNotThrow(() => runtime.changeCompute('host', 'work.ipynb', 'gpu:0', '/cuda/python'));
      assert.equal(runtime.computeForNotebook('work.ipynb').device, 'gpu:0');
    } finally {
      assert.equal(runtime.computeForNotebook('work.ipynb').device, 'gpu:0');
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts host compute without opt-in and rejects stale or malformed targets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-exec-reject-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'exec-reject', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'exec-reject-token-that-is-long-enough', context(extensionRoot), logger());
    runtime.project.ensureNotebook('work.ipynb');
    (runtime as any).updatePresence();
    const sent: any[] = [];
    (runtime as any).transport = {
      sendTo: (
        peerId: string,
        type: string,
        meta: any,
        payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
      ) => sent.push({ peerId, type, meta, payload }),
      stop: async () => undefined,
    };
    try {
      await (runtime as any).handleExecutionRequest({
        type: 'executeRequest', payload: Buffer.from('1+1'),
        meta: {
          requestId: 'without-opt-in', notebookKey: 'work.ipynb',
          target: { executorId: 'host', device: 'cpu', epoch: 0, author: 'host' },
          documentManifest: {}, binaryManifest: {}, directoryManifest: [],
        },
      }, 'peer-z');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].type, 'executeResult');
      const rejectedResult = JSON.parse(Buffer.from(sent[0].payload).toString('utf8'));
      assert.equal(rejectedResult.success, false);
      assert.equal(rejectedResult.content.ename, 'FileVersionBarrier');

      sent.length = 0;
      await (runtime as any).handleKernelCommand({
        type: 'kernelCommand', payload: new Uint8Array(),
        meta: { requestId: 'kernel-without-opt-in', notebookKey: 'work.ipynb', command: 'interrupt', target: runtime.computeForNotebook('work.ipynb') },
      }, 'peer-z');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].type, 'kernelCommandResult');
      assert.equal(sent[0].meta.success, false);
      assert.match(sent[0].meta.message, /No running kernel/);

      sent.length = 0;
      await (runtime as any).handleExecutionRequest({
        type: 'executeRequest', payload: Buffer.from('1+1'),
        meta: {
          requestId: 'stale', notebookKey: 'work.ipynb',
          target: { executorId: 'peer-z', device: 'cpu', epoch: 123, author: 'peer-z' },
          documentManifest: {}, binaryManifest: {}, directoryManifest: [],
        },
      }, 'peer-z');
      assert.equal(sent.length, 1);
      assert.equal(JSON.parse(Buffer.from(sent[0].payload).toString('utf8')).content.ename, 'ComputeTargetChanged');

      sent.length = 0;
      await (runtime as any).handleKernelCommand({
        type: 'kernelCommand', payload: new Uint8Array(),
        meta: {
          requestId: 'kernel-forged-executor', notebookKey: 'work.ipynb', command: 'interrupt',
          target: { executorId: 'peer-z', device: 'cpu', epoch: 123, author: 'peer-z' },
        },
      }, 'peer-z');
      assert.equal(sent[0].type, 'kernelCommandResult');
      assert.equal(sent[0].meta.success, false);
      assert.match(sent[0].meta.message, /changed or names a different executor/);

      sent.length = 0;
      await (runtime as any).handleKernelCommand({
        type: 'kernelCommand', payload: new Uint8Array(),
        meta: { requestId: 'kernel-malformed', notebookKey: 'work.ipynb', command: 'interrupt' },
      }, 'peer-z');
      assert.equal(sent[0].type, 'kernelCommandResult');
      assert.equal(sent[0].meta.success, false);
      assert.match(sent[0].meta.message, /malformed/);
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cleans execution and synchronization waiters when transport send fails synchronously', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-send-failure-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'send-failure', role: 'peer', peerId: 'guest', hostPeerId: 'peer-z',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'send-failure-token-that-is-long-enough', context(extensionRoot), logger());
    try {
      runtime.project.ensureNotebook('work.ipynb', {
        metadata: {},
        cells: [{ id: 'cell-a', kind: 2, language: 'python', source: '1+1', metadata: {}, outputs: [] }],
      });
      (runtime as any).synchronizeExecutionFiles = async () => ({ documents: {}, binaries: {}, directories: [] });
      (runtime as any).transport = {
        sendTo: () => { throw new Error('send failed'); },
        stop: async () => undefined,
      };
      await assert.rejects(runtime.executeCell('work.ipynb', 'cell-a', '1+1', () => undefined), /send failed/);
      assert.equal((runtime as any).pendingExecutions.size, 0);

      // Exercise the real barrier helper directly with a failing send.
      delete (runtime as any).synchronizeExecutionFiles;
      await assert.rejects((runtime as any).synchronizeExecutionFiles('peer-z', 'barrier-request'), /send failed/);
      assert.equal((runtime as any).pendingBarrierReplies.size, 0);

      const bytes = Buffer.from('BINARY');
      await writeFile(path.join(folder, 'model.bin'), bytes);
      const version = { hash: createHash('sha256').update(bytes).digest('hex'), version: 1, author: 'host' };
      await assert.rejects((runtime as any).synchronizeBinaryVersion('peer-z', 'model.bin', version), /send failed/);
      assert.equal((runtime as any).pendingBinaryAcks.size, 0);
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retries one idempotent execution request after route loss before acceptance and acknowledges its result', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-exec-route-retry-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'exec-route-retry', role: 'peer', peerId: 'guest', hostPeerId: 'peer-z',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'exec-route-retry-token-that-is-long-enough', context(extensionRoot), logger());
    let attempts = 0;
    let routeWaits = 0;
    const sentTypes: string[] = [];
    const requestIds: string[] = [];
    const requestMetas: any[] = [];
    try {
      runtime.project.ensureNotebook('work.ipynb', {
        metadata: {},
        cells: [{ id: 'cell-a', kind: 2, language: 'python', source: '1+1', metadata: {}, outputs: [] }],
      });
      let syncCalls = 0;
      let prepareCalls = 0;
      let flushCalls = 0;
      let manifestCalls = 0;
      (runtime as any).synchronizeExecutionFiles = async () => {
        syncCalls += 1;
        assert.equal([...runtime.pendingExecutions.values()][0]?.timer, undefined,
          'the acceptance budget starts only after dependency transfer finishes');
        return { documents: {}, binaries: {}, directories: [] };
      };
      (runtime as any).prepareWorkingCopy = async () => { prepareCalls += 1; };
      (runtime as any).flush = async () => { flushCalls += 1; };
      (runtime as any).executionManifest = () => {
        manifestCalls += 1;
        return { documents: {}, binaries: {}, directories: [] };
      };
      (runtime as any).transport = {
        waitForRoute: async () => { routeWaits += 1; },
        sendTo: (_peerId: string, type: string, meta: any, payload: Uint8Array = new Uint8Array()) => {
          sentTypes.push(type);
          if (type !== 'executeRequest') return;
          attempts += 1;
          requestIds.push(meta.requestId);
          requestMetas.push({ ...meta, payloadBytes: payload.byteLength });
          if (attempts === 1) throw new Error('No route to peer peer-z.');
          queueMicrotask(() => {
            void (runtime as any).onMessage({
              type: 'executeAccepted', payload: new Uint8Array(), meta: { requestId: meta.requestId },
            }, 'peer-z');
            void (runtime as any).onMessage({
              type: 'executeResult', payload: new Uint8Array(), meta: {
                requestId: meta.requestId,
                result: { requestId: meta.requestId, success: true, content: { status: 'ok' } },
              },
            }, 'peer-z');
          });
        },
        stop: async () => undefined,
      };
      const result = await runtime.executeCell('work.ipynb', 'cell-a', '1+1', () => undefined);
      assert.equal(result.success, true);
      assert.equal(attempts, 2, 'the same request is retried after the route disappears');
      assert.equal(new Set(requestIds).size, 1, 'route retry reuses the same request ID');
      assert.ok(routeWaits >= 2);
      const request = requestMetas[0];
      assert.equal(request.notebookKey, 'work.ipynb');
      assert.equal(request.cellId, 'cell-a');
      assert.equal(request.executorId, 'peer-z');
      assert.equal(request.computeEpoch, runtime.computeForNotebook('work.ipynb').epoch);
      assert.match(request.cellRevision, /^[A-Za-z0-9_-]{1,128}$/);
      assert.match(request.cellDigest, /^[a-f0-9]{64}$/);
      assert.equal(request.payloadBytes, 0, 'ordinary guest request carries no code payload');
      assert.equal('documentManifest' in request, false);
      assert.equal('binaryManifest' in request, false);
      assert.equal('directoryManifest' in request, false);
      assert.equal('target' in request, false);
      assert.equal(syncCalls, 1, 'guest execution synchronizes dependencies once before route retries');
      assert.equal(prepareCalls, 0, 'ordinary guest execution does not call prepareWorkingCopy');
      assert.equal(flushCalls, 0, 'ordinary guest execution does not call full flush');
      assert.equal(manifestCalls, 0, 'ordinary guest execution does not build a project manifest');
      assert.equal(prepareCalls + flushCalls + manifestCalls, 0,
        'the host owns physical materialization; the requester uses the barrier');
      assert.ok(sentTypes.includes('executeResultAck'), 'the terminal result is acknowledged');
      assert.equal((runtime as any).pendingExecutions.size, 0);
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('delivers stdin replies and kernel commands after route recovery', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-kernel-route-retry-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'kernel-route-retry', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'kernel-route-retry-token-that-is-long-enough', context(extensionRoot), logger());
    let inputAttempts = 0;
    let commandAttempts = 0;
    let routeWaits = 0;
    (runtime as any).transport = {
      waitForRoute: async () => { routeWaits += 1; },
      sendTo: (_peerId: string, type: string, meta: any) => {
        if (type === 'inputReply') {
          inputAttempts += 1;
          if (inputAttempts === 1) throw new Error('No route to peer peer-z.');
          if (inputAttempts >= 3) {
            queueMicrotask(() => {
              void (runtime as any).onMessage({
                type: 'inputReplyAck', payload: new Uint8Array(), meta: {
                  requestId: meta.requestId,
                  eventSequence: meta.eventSequence,
                  success: true,
                },
              }, 'peer-z');
            });
          }
        }
        if (type === 'kernelCommand') {
          commandAttempts += 1;
          if (commandAttempts === 1) throw new Error('No route to peer peer-z.');
          queueMicrotask(() => {
            void (runtime as any).onMessage({
              type: 'kernelCommandResult', payload: new Uint8Array(), meta: {
                requestId: meta.requestId, success: true,
              },
            }, 'peer-z');
          });
        }
      },
      stop: async () => undefined,
    };
    const pendingTimer = setTimeout(() => undefined, 60_000);
    (runtime as any).pendingExecutions.set('stdin-request', {
      resolve: () => undefined,
      reject: () => undefined,
      onEvent: () => undefined,
      executorId: 'peer-z',
      notebookKey: 'work.ipynb',
      timer: pendingTimer,
      accepted: true,
      nextEventSequence: 0,
      bufferedEvents: new Map(),
      bufferedEventBytes: 0,
      inputRequestSequence: 3,
    });
    try {
      await assert.rejects(
        runtime.replyToInput('stdin-request', 'x'.repeat(64 * 1024 + 1)),
        /character limit/,
      );
      await runtime.replyToInput('stdin-request', 'answer');
      clearTimeout(pendingTimer);
      (runtime as any).pendingExecutions.delete('stdin-request');
      await (runtime as any).sendKernelCommand(
        'peer-z',
        'work.ipynb',
        { executorId: 'peer-z', device: 'cpu', epoch: 1, author: 'host' },
        'interrupt',
      );
      assert.equal(inputAttempts, 3, 'a lost input acknowledgement must resend the same prompt reply');
      assert.equal(commandAttempts, 2);
      assert.ok(routeWaits >= 4);
      assert.equal((runtime as any).pendingKernelCommands.size, 0);

      let deliveredInputs = 0;
      const inputAcks: any[] = [];
      (runtime as any).executionOwners.set('owned-input', {
        peerId: 'peer-z',
        notebookKey: 'work.ipynb',
        events: [],
        inputRequestSequences: new Set([4]),
        inputReplyDigests: new Map(),
      });
      (runtime as any).kernels.set('work.ipynb', {
        inputReply: () => { deliveredInputs += 1; },
        stop: () => undefined,
      });
      (runtime as any).transport.sendTo = (_peerId: string, type: string, meta: any) => {
        if (type === 'inputReplyAck') inputAcks.push(meta);
      };
      const replyFrame = (value: string) => ({
        type: 'inputReply', payload: new Uint8Array(), meta: {
          requestId: 'owned-input', eventSequence: 4, value,
        },
      });
      await (runtime as any).onMessage(replyFrame('same answer'), 'peer-z');
      await (runtime as any).onMessage(replyFrame('same answer'), 'peer-z');
      await (runtime as any).onMessage(replyFrame('different answer'), 'peer-z');
      assert.equal(deliveredInputs, 1, 'retries must never write two stdin lines into the kernel');
      assert.deepEqual(inputAcks.map((ack) => ack.success), [true, true, false]);
    } finally {
      clearTimeout(pendingTimer);
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retries an execution barrier commit when its acknowledgement is lost', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-barrier-ack-retry-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'barrier-ack-retry', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'barrier-ack-retry-token-that-is-long-enough', context(extensionRoot), logger());
    let commits = 0;
    try {
      runtime.project.ensureNotebook('work.ipynb');
      const target = { executorId: 'peer-z', device: 'cpu', epoch: 1, author: 'host' };
      (runtime as any).transport = {
        waitForRoute: async () => undefined,
        sendTo: (_peerId: string, type: string, meta: any) => {
          if (type === 'executionBarrierCheck') {
            queueMicrotask(() => (runtime as any).resolveBarrierReply(
              meta.requestId, 'status', 'peer-z',
              { success: true, missingDocuments: [], missingBinaries: [] },
            ));
          } else if (type === 'executionBarrierCommit') {
            commits += 1;
            if (commits >= 2) {
              queueMicrotask(() => (runtime as any).resolveBarrierReply(
                meta.requestId, 'ack', 'peer-z', { success: true },
              ));
            }
          }
        },
        stop: async () => undefined,
      };
      const manifest = await (runtime as any).synchronizeExecutionFiles(
        'peer-z', 'barrier-ack-retry-request', 'work.ipynb', target,
      );
      assert.ok(manifest.documents['work.ipynb']);
      assert.equal(commits, 2);
      assert.equal((runtime as any).pendingBarrierReplies.size, 0);
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('executes lightweight requests from host canonical CRDT text and rejects request-id digest mutation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-lightweight-exec-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'lightweight-exec', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'lightweight-exec-token-that-is-long-enough', context(extensionRoot), logger());
    const sent: Array<{ type: string; meta: any; payload: Uint8Array<ArrayBufferLike> }> = [];
    let finishExecution: ((value: any) => void) | undefined;
    let executionCount = 0;
    let executedCode = '';
    try {
      runtime.project.ensureNotebook('work.ipynb', {
        metadata: {},
        cells: [{
          id: 'cell-a', kind: 2, language: 'python',
          source: 'print("HOST CANONICAL")', metadata: {}, outputs: [],
        }],
      });
      (runtime as any).updatePresence();
      const target = runtime.computeForNotebook('work.ipynb');
      const state = runtime.project.cellTextState('work.ipynb', 'cell-a');
      const digest = createHash('sha256').update(state.source, 'utf8').digest('hex');
      (runtime as any).transport = {
        sendTo: (_peerId: string, type: string, meta: any, payload: Uint8Array<ArrayBufferLike> = new Uint8Array()) => {
          sent.push({ type, meta, payload });
        },
        peerRuntime: () => [],
        stop: async () => undefined,
      };
      (runtime as any).executeLocally = async (
        _notebookKey: string,
        _target: unknown,
        _requestId: string,
        code: string,
      ) => {
        executionCount += 1;
        executedCode = code;
        return new Promise((resolve) => { finishExecution = resolve; });
      };
      const requestId = 'lightweight-request';
      const meta = {
        requestId,
        notebookKey: 'work.ipynb',
        cellId: 'cell-a',
        executorId: 'host',
        computeEpoch: target.epoch,
        cellRevision: state.revision,
        cellDigest: digest,
        fastPath: true,
      };
      const first = (runtime as any).handleExecutionRequest({
        type: 'executeRequest', payload: new Uint8Array(), meta,
      }, 'peer-z');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(executionCount, 1, 'matching revision/digest executes immediately');
      assert.equal(executedCode, 'print("HOST CANONICAL")', 'guest payload is never the canonical execution source');
      assert.ok(sent.some((item) => item.type === 'executeAccepted'), 'accept is sent only after authoritative validation');

      await (runtime as any).handleExecutionRequest({
        type: 'executeRequest', payload: new Uint8Array(), meta,
      }, 'peer-z');
      assert.equal(executionCount, 1, 'same lightweight request retry must not launch a second kernel execution');

      sent.length = 0;
      await (runtime as any).handleExecutionRequest({
        type: 'executeRequest',
        payload: new Uint8Array(),
        meta: { ...meta, cellDigest: '0'.repeat(64) },
      }, 'peer-z');
      await (runtime as any).handleExecutionRequest({
        type: 'executeRequest',
        payload: new Uint8Array(),
        meta: { ...meta, cellId: 'cell-b' },
      }, 'peer-z');
      await (runtime as any).handleExecutionRequest({
        type: 'executeRequest',
        payload: new Uint8Array(),
        meta: { ...meta, computeEpoch: target.epoch + 1 },
      }, 'peer-z');
      assert.equal(executionCount, 1, 'same request ID with changed identity never launches another kernel execution');
      const rejections = sent.filter((item) => item.type === 'executeResult')
        .map((item) => JSON.parse(Buffer.from(item.payload).toString('utf8')).content.ename);
      assert.ok(rejections.includes('ExecutionBusy'));
      assert.ok(rejections.length >= 3, 'digest, cell ID and compute epoch mutations are all rejected');

      assert.ok(finishExecution);
      finishExecution!({ requestId, success: true, content: { status: 'ok' } });
      await first;
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('deduplicates a duplicate lightweight request before acceptance and starts one kernel execution', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-duplicate-before-accept-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'duplicate-before-accept', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'duplicate-before-accept-token-that-is-long-enough', context(extensionRoot), logger());
    const guestProject = new CollaborativeProject();
    const sent: Array<{ type: string; meta: any; payload: Uint8Array<ArrayBufferLike> }> = [];
    let executionCount = 0;
    try {
      guestProject.ensureNotebook('work.ipynb', {
        metadata: {},
        cells: [{ id: 'cell-a', kind: 2, language: 'python', source: 'print("OLD")', metadata: {}, outputs: [] }],
      });
      runtime.project.ensureNotebook('work.ipynb');
      runtime.project.applyRemoteUpdate(
        'work.ipynb', 'notebook', guestProject.encodeUpdate('work.ipynb'), { type: 'structure' },
      );
      (runtime as any).updatePresence();
      const hostVector = runtime.project.encodeStateVector('work.ipynb');
      guestProject.applyCellTextChanges('work.ipynb', 'cell-a', [{
        offset: 7, deleteCount: 3, insertText: 'NEW',
      }]);
      const requested = guestProject.cellTextState('work.ipynb', 'cell-a');
      const targetUpdate = guestProject.encodeUpdate('work.ipynb', hostVector);
      const target = runtime.computeForNotebook('work.ipynb');
      const meta = {
        requestId: 'duplicate-before-accept-request',
        notebookKey: 'work.ipynb',
        cellId: 'cell-a',
        executorId: 'host',
        computeEpoch: target.epoch,
        cellRevision: requested.revision,
        cellDigest: createHash('sha256').update(requested.source, 'utf8').digest('hex'),
        fastPath: true,
      };
      (runtime as any).transport = {
        sendTo: (_peerId: string, type: string, responseMeta: any, payload: Uint8Array<ArrayBufferLike> = new Uint8Array()) => {
          sent.push({ type, meta: responseMeta, payload });
        },
        peerRuntime: () => [],
        stop: async () => undefined,
      };
      (runtime as any).executeLocally = async (
        _key: string, _target: unknown, requestId: string,
      ) => {
        executionCount += 1;
        return { requestId, success: true, content: { status: 'ok' } };
      };

      const first = (runtime as any).handleExecutionRequest({
        type: 'executeRequest', payload: new Uint8Array(), meta,
      }, 'peer-z');
      await new Promise<void>((resolve) => setImmediate(resolve));
      const duplicate = (runtime as any).handleExecutionRequest({
        type: 'executeRequest', payload: new Uint8Array(), meta,
      }, 'peer-z');
      await new Promise<void>((resolve) => setImmediate(resolve));

      assert.equal(executionCount, 0, 'both copies remain reserved while host canonical cell is behind');
      assert.equal(sent.filter((item) => item.type === 'executeAccepted').length, 0,
        'pre-validation duplicate must not fabricate acceptance');
      assert.equal((runtime as any).executionOwners.size, 1, 'one request ID owns one pre-start reservation');

      runtime.project.applyRemoteUpdate(
        'work.ipynb', 'notebook', targetUpdate, { type: 'cellText', cellId: 'cell-a' },
      );
      await Promise.all([first, duplicate]);

      assert.equal(executionCount, 1);
      assert.equal(sent.filter((item) => item.type === 'executeAccepted').length, 1,
        'one authoritative acceptance is enough for identical duplicates');
    } finally {
      guestProject.destroy();
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('waits only for lagging target-cell CRDT convergence and executes without a project barrier', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-target-cell-wait-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'target-cell-wait', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'target-cell-wait-token-that-is-long-enough', context(extensionRoot), logger());
    const guestProject = new CollaborativeProject();
    const sent: Array<{ type: string; meta: any; payload: Uint8Array<ArrayBufferLike> }> = [];
    let executionCount = 0;
    let executedCode = '';
    let syncCalls = 0;
    let prepareCalls = 0;
    let flushCalls = 0;
    let manifestCalls = 0;
    try {
      guestProject.ensureNotebook('work.ipynb', {
        metadata: {},
        cells: [{
          id: 'cell-a', kind: 2, language: 'python', source: 'print("OLD")',
          metadata: {}, outputs: [],
        }],
      });
      runtime.project.ensureNotebook('work.ipynb');
      runtime.project.applyRemoteUpdate(
        'work.ipynb',
        'notebook',
        guestProject.encodeUpdate('work.ipynb'),
        { type: 'structure' },
      );
      (runtime as any).updatePresence();
      const hostVector = runtime.project.encodeStateVector('work.ipynb');
      guestProject.applyCellTextChanges('work.ipynb', 'cell-a', [{
        offset: 7, deleteCount: 3, insertText: 'NEW',
      }]);
      const requested = guestProject.cellTextState('work.ipynb', 'cell-a');
      const requestedDigest = createHash('sha256').update(requested.source, 'utf8').digest('hex');
      const targetUpdate = guestProject.encodeUpdate('work.ipynb', hostVector);
      const target = runtime.computeForNotebook('work.ipynb');

      (runtime as any).synchronizeExecutionFiles = async () => {
        syncCalls += 1;
        return { documents: {}, binaries: {}, directories: [] };
      };
      (runtime as any).prepareWorkingCopy = async () => { prepareCalls += 1; };
      (runtime as any).flush = async () => { flushCalls += 1; };
      (runtime as any).executionManifest = () => {
        manifestCalls += 1;
        return { documents: {}, binaries: {}, directories: [] };
      };
      (runtime as any).transport = {
        sendTo: (_peerId: string, type: string, meta: any, payload: Uint8Array<ArrayBufferLike> = new Uint8Array()) => {
          sent.push({ type, meta, payload });
        },
        peerRuntime: () => [],
        stop: async () => undefined,
      };
      (runtime as any).executeLocally = async (
        _notebookKey: string,
        _target: unknown,
        requestId: string,
        code: string,
      ) => {
        executionCount += 1;
        executedCode = code;
        return { requestId, success: true, content: { status: 'ok' } };
      };

      const pending = (runtime as any).handleExecutionRequest({
        type: 'executeRequest',
        payload: new Uint8Array(),
        meta: {
          requestId: 'target-cell-wait-request',
          notebookKey: 'work.ipynb',
          cellId: 'cell-a',
          executorId: 'host',
          computeEpoch: target.epoch,
          cellRevision: requested.revision,
          cellDigest: requestedDigest,
          fastPath: true,
        },
      }, 'peer-z');

      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(executionCount, 0, 'lagging host must wait instead of executing stale text');
      runtime.project.ensureText('unrelated.py', 'UNRELATED = 1');
      runtime.project.setCellMetadata('work.ipynb', 'cell-a', { unrelated: true });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(executionCount, 0, 'unrelated project and metadata changes must not satisfy the target-cell wait');

      runtime.project.applyRemoteUpdate(
        'work.ipynb',
        'notebook',
        targetUpdate,
        { type: 'cellText', cellId: 'cell-a' },
      );
      await pending;

      assert.equal(executionCount, 1);
      assert.equal(executedCode, requested.source, 'converged host canonical target text is executed');
      assert.ok(sent.some((item) => item.type === 'executeAccepted'));
      assert.equal(syncCalls, 0);
      assert.equal(prepareCalls, 0);
      assert.equal(flushCalls, 0);
      assert.equal(manifestCalls, 0);
    } finally {
      guestProject.destroy();
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('times out a lagging target cell without execution or guest-payload fallback', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-target-cell-timeout-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'target-cell-timeout', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'target-cell-timeout-token-that-is-long-enough', context(extensionRoot), logger());
    const guestProject = new CollaborativeProject();
    const sent: Array<{ type: string; meta: any; payload: Uint8Array<ArrayBufferLike> }> = [];
    let executionCount = 0;
    try {
      guestProject.ensureNotebook('work.ipynb', {
        metadata: {},
        cells: [{
          id: 'cell-a', kind: 2, language: 'python', source: 'print("OLD")',
          metadata: {}, outputs: [],
        }],
      });
      runtime.project.ensureNotebook('work.ipynb');
      runtime.project.applyRemoteUpdate(
        'work.ipynb', 'notebook', guestProject.encodeUpdate('work.ipynb'), { type: 'structure' },
      );
      (runtime as any).updatePresence();
      guestProject.applyCellTextChanges('work.ipynb', 'cell-a', [{
        offset: 7, deleteCount: 3, insertText: 'FUTURE',
      }]);
      const requested = guestProject.cellTextState('work.ipynb', 'cell-a');
      const target = runtime.computeForNotebook('work.ipynb');
      (runtime as any).targetCellConvergenceTimeoutMs = 25;
      (runtime as any).transport = {
        sendTo: (_peerId: string, type: string, meta: any, payload: Uint8Array<ArrayBufferLike> = new Uint8Array()) => {
          sent.push({ type, meta, payload });
        },
        peerRuntime: () => [],
        stop: async () => undefined,
      };
      (runtime as any).executeLocally = async () => {
        executionCount += 1;
        throw new Error('must not execute');
      };

      await (runtime as any).handleExecutionRequest({
        type: 'executeRequest',
        payload: new Uint8Array(),
        meta: {
          requestId: 'target-cell-timeout-request',
          notebookKey: 'work.ipynb',
          cellId: 'cell-a',
          executorId: 'host',
          computeEpoch: target.epoch,
          cellRevision: requested.revision,
          cellDigest: createHash('sha256').update(requested.source, 'utf8').digest('hex'),
          fastPath: true,
        },
      }, 'peer-z');

      assert.equal(executionCount, 0);
      assert.equal(sent.some((item) => item.type === 'executeAccepted'), false);
      const failure = sent.find((item) => item.type === 'executeResult');
      assert.ok(failure);
      const result = JSON.parse(Buffer.from(failure.payload).toString('utf8'));
      assert.equal(result.content.ename, 'CellStateUnavailable');
      assert.equal(runtime.project.cellTextState('work.ipynb', 'cell-a').source, 'print("OLD")');
    } finally {
      guestProject.destroy();
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects stale guest revision without rolling back host-ahead canonical state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-stale-cell-revision-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'stale-cell-revision', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'stale-cell-revision-token-that-is-long-enough', context(extensionRoot), logger());
    const sent: Array<{ type: string; meta: any; payload: Uint8Array<ArrayBufferLike> }> = [];
    let executionCount = 0;
    try {
      runtime.project.ensureNotebook('work.ipynb', {
        metadata: {},
        cells: [{
          id: 'cell-a', kind: 2, language: 'python', source: 'print("OLD")',
          metadata: {}, outputs: [],
        }],
      });
      (runtime as any).updatePresence();
      const stale = runtime.project.cellTextState('work.ipynb', 'cell-a');
      runtime.project.applyCellTextChanges('work.ipynb', 'cell-a', [{
        offset: 7, deleteCount: 3, insertText: 'HOST_NEW',
      }]);
      const hostAhead = runtime.project.cellTextState('work.ipynb', 'cell-a');
      const target = runtime.computeForNotebook('work.ipynb');
      (runtime as any).transport = {
        sendTo: (_peerId: string, type: string, meta: any, payload: Uint8Array<ArrayBufferLike> = new Uint8Array()) => {
          sent.push({ type, meta, payload });
        },
        peerRuntime: () => [],
        stop: async () => undefined,
      };
      (runtime as any).executeLocally = async () => {
        executionCount += 1;
        throw new Error('stale request must not execute');
      };

      await (runtime as any).handleExecutionRequest({
        type: 'executeRequest',
        payload: new Uint8Array(),
        meta: {
          requestId: 'stale-cell-revision-request',
          notebookKey: 'work.ipynb',
          cellId: 'cell-a',
          executorId: 'host',
          computeEpoch: target.epoch,
          cellRevision: stale.revision,
          cellDigest: createHash('sha256').update(stale.source, 'utf8').digest('hex'),
          fastPath: true,
        },
      }, 'peer-z');

      assert.equal(executionCount, 0);
      const failure = sent.find((item) => item.type === 'executeResult');
      assert.ok(failure);
      const result = JSON.parse(Buffer.from(failure.payload).toString('utf8'));
      assert.equal(result.content.ename, 'StaleCellRevision');
      assert.equal(runtime.project.cellTextState('work.ipynb', 'cell-a').revision, hostAhead.revision);
      assert.equal(runtime.project.cellTextState('work.ipynb', 'cell-a').source, hostAhead.source);
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects lightweight compute-epoch mismatch, wrong executor and invalid source before acceptance', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-authority-reject-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'authority-reject', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'authority-reject-token-that-is-long-enough', context(extensionRoot), logger());
    const sent: Array<{ peerId: string; type: string; meta: any; payload: Uint8Array<ArrayBufferLike> }> = [];
    let executionCount = 0;
    try {
      runtime.project.ensureNotebook('work.ipynb', {
        metadata: {},
        cells: [{ id: 'cell-a', kind: 2, language: 'python', source: '1+1', metadata: {}, outputs: [] }],
      });
      (runtime as any).updatePresence();
      const state = runtime.project.cellTextState('work.ipynb', 'cell-a');
      const target = runtime.computeForNotebook('work.ipynb');
      const baseMeta = {
        notebookKey: 'work.ipynb',
        cellId: 'cell-a',
        executorId: 'host',
        computeEpoch: target.epoch,
        cellRevision: state.revision,
        cellDigest: createHash('sha256').update(state.source, 'utf8').digest('hex'),
        fastPath: true,
      };
      (runtime as any).transport = {
        sendTo: (peerId: string, type: string, meta: any, payload: Uint8Array<ArrayBufferLike> = new Uint8Array()) => {
          sent.push({ peerId, type, meta, payload });
        },
        peerRuntime: () => [],
        stop: async () => undefined,
      };
      (runtime as any).executeLocally = async () => {
        executionCount += 1;
        throw new Error('invalid authority request must not execute');
      };

      await (runtime as any).handleExecutionRequest({
        type: 'executeRequest', payload: new Uint8Array(),
        meta: { ...baseMeta, requestId: 'epoch-mismatch', computeEpoch: target.epoch + 1 },
      }, 'peer-z');
      await (runtime as any).handleExecutionRequest({
        type: 'executeRequest', payload: new Uint8Array(),
        meta: { ...baseMeta, requestId: 'wrong-executor', executorId: 'peer-z' },
      }, 'peer-z');
      await (runtime as any).handleExecutionRequest({
        type: 'executeRequest', payload: new Uint8Array(),
        meta: { ...baseMeta, requestId: 'invalid-source' },
      }, 'bad source!');

      assert.equal(executionCount, 0);
      assert.equal(sent.some((item) => item.type === 'executeAccepted'), false);
      const decoded = sent.filter((item) => item.type === 'executeResult')
        .map((item) => JSON.parse(Buffer.from(item.payload).toString('utf8')).content.ename);
      assert.ok(decoded.includes('ComputeTargetChanged'));
      assert.ok(decoded.includes('InvalidExecutionRequest'));
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('executes a repeated remote request exactly once and replays the terminal result until acknowledged', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-exec-idempotent-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'exec-idempotent', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'exec-idempotent-token-that-is-long-enough', context(extensionRoot), logger());
    const sent: Array<{ type: string; meta: any; payload: Uint8Array<ArrayBufferLike> }> = [];
    let eventRouteAvailable = false;
    (runtime as any).transport = {
      sendTo: (
        _peerId: string,
        type: string,
        meta: any,
        payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
      ) => {
        if (type === 'executionEvent' && !eventRouteAvailable) throw new Error('No route to peer peer-z.');
        sent.push({ type, meta, payload });
      },
      peerRuntime: () => [],
      stop: async () => undefined,
    };
    let finishExecution: ((value: any) => void) | undefined;
    let executionCount = 0;
    try {
      runtime.project.ensureNotebook('work.ipynb');
      (runtime as any).updatePresence();
      const target = runtime.computeForNotebook('work.ipynb');
      const manifest = (runtime as any).executionManifest();
      const requestId = 'idempotent-request';
      await (runtime as any).handleExecutionBarrierCheck({
        type: 'executionBarrierCheck', payload: new Uint8Array(),
        meta: { requestId, notebookKey: 'work.ipynb', target, manifest },
      }, 'peer-z');
      await (runtime as any).handleExecutionBarrierCommit({
        type: 'executionBarrierCommit', payload: new Uint8Array(),
        meta: { requestId, notebookKey: 'work.ipynb', target, manifest },
      }, 'peer-z');
      sent.length = 0;
      const largeOutput = 'x'.repeat(1024 * 1024 + 64);
      (runtime as any).executeLocally = async (
        _notebookKey: string,
        _target: unknown,
        activeRequestId: string,
        _code: string,
        onEvent: (event: unknown) => void,
      ) => {
        executionCount += 1;
        onEvent({
          type: 'iopub',
          requestId: activeRequestId,
          messageType: 'stream',
          content: { name: 'stdout', text: largeOutput },
        });
        return new Promise((resolve) => { finishExecution = resolve; });
      };
      const frame = {
        type: 'executeRequest', payload: Buffer.from('1+1'),
        meta: {
          requestId, notebookKey: 'work.ipynb', target,
          documentManifest: manifest.documents,
          binaryManifest: manifest.binaries,
          directoryManifest: manifest.directories,
        },
      };
      const first = (runtime as any).handleExecutionRequest(frame, 'peer-z');
      await new Promise<void>((resolve) => setImmediate(resolve));
      await (runtime as any).handleExecutionRequest(frame, 'peer-z');
      assert.equal(executionCount, 1, 'an active duplicate must not launch a second kernel request');
      assert.equal(sent.filter((item) => item.type === 'executeAccepted').length, 3);
      assert.equal(sent.filter((item) => item.type === 'executionEvent').length, 0);

      eventRouteAvailable = true;
      (runtime as any).replayRemoteExecutionsForPeer('peer-z');
      const activeEvent = sent.find((item) => item.type === 'executionEvent');
      assert.ok(activeEvent, 'the cached active event must replay when the route returns');
      assert.equal(activeEvent.meta.event, undefined, 'large event data must not use the 1 MiB frame header');
      assert.equal(activeEvent.meta.eventSequence, 0);
      assert.ok(activeEvent.payload.byteLength > 1024 * 1024);
      assert.doesNotThrow(() => encodeFrame('executionEvent', activeEvent.meta, activeEvent.payload));

      assert.ok(finishExecution);
      finishExecution!({ requestId, success: true, content: { status: 'ok' } });
      await first;
      assert.equal(sent.filter((item) => item.type === 'executeResult').length, 1);
      const completedResult = sent.find((item) => item.type === 'executeResult');
      assert.ok(completedResult);
      assert.equal(completedResult.meta.result, undefined);
      assert.equal(JSON.parse(Buffer.from(completedResult.payload).toString('utf8')).success, true);
      assert.equal(sent.filter((item) => item.type === 'executionEvent').length, 2,
        'terminal delivery replays output before the result');

      await (runtime as any).handleExecutionRequest(frame, 'peer-z');
      assert.equal(executionCount, 1, 'a completed duplicate must replay the cached result');
      assert.equal(sent.filter((item) => item.type === 'executeResult').length, 2);
      await (runtime as any).onMessage({
        type: 'executeResultAck', payload: new Uint8Array(), meta: { requestId },
      }, 'peer-z');
      assert.equal((runtime as any).completedRemoteExecutions.size, 0);
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps lightweight execution ownership across route loss after acceptance and replays without re-execution', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-lightweight-route-after-accept-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'lightweight-route-after-accept', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'lightweight-route-after-accept-token-long-enough', context(extensionRoot), logger());
    const sent: Array<{ type: string; meta: any; payload: Uint8Array<ArrayBufferLike> }> = [];
    let routeAvailable = false;
    let finishExecution: ((value: any) => void) | undefined;
    let executionCount = 0;
    try {
      runtime.project.ensureNotebook('work.ipynb', {
        metadata: {},
        cells: [{ id: 'cell-a', kind: 2, language: 'python', source: 'print("once")', metadata: {}, outputs: [] }],
      });
      (runtime as any).updatePresence();
      const state = runtime.project.cellTextState('work.ipynb', 'cell-a');
      const target = runtime.computeForNotebook('work.ipynb');
      (runtime as any).transport = {
        sendTo: (_peerId: string, type: string, meta: any, payload: Uint8Array<ArrayBufferLike> = new Uint8Array()) => {
          if (type === 'executionEvent' && !routeAvailable) throw new Error('No route to peer peer-z.');
          sent.push({ type, meta, payload });
        },
        peerRuntime: () => [],
        stop: async () => undefined,
      };
      (runtime as any).executeLocally = async (
        _key: string, _target: unknown, requestId: string, _code: string, onEvent: (event: any) => void,
      ) => {
        executionCount += 1;
        onEvent({
          type: 'iopub', requestId, messageType: 'stream',
          content: { name: 'stdout', text: 'ONE\n' },
        });
        return new Promise((resolve) => { finishExecution = resolve; });
      };
      const meta = {
        requestId: 'route-after-accept-request',
        notebookKey: 'work.ipynb',
        cellId: 'cell-a',
        executorId: 'host',
        computeEpoch: target.epoch,
        cellRevision: state.revision,
        cellDigest: createHash('sha256').update(state.source, 'utf8').digest('hex'),
        fastPath: true,
      };
      const first = (runtime as any).handleExecutionRequest({
        type: 'executeRequest', payload: new Uint8Array(), meta,
      }, 'peer-z');
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(executionCount, 1);
      assert.equal((runtime as any).executionOwners.size, 1);
      assert.ok(sent.some((item) => item.type === 'executeAccepted'));

      await (runtime as any).handleExecutionRequest({
        type: 'executeRequest', payload: new Uint8Array(), meta,
      }, 'peer-z');
      assert.equal(executionCount, 1, 'route retry after acceptance reuses the active owner');

      routeAvailable = true;
      (runtime as any).replayRemoteExecutionsForPeer('peer-z');
      assert.ok(sent.some((item) => item.type === 'executionEvent'), 'cached event replays after route recovery');
      assert.equal(executionCount, 1);

      assert.ok(finishExecution);
      finishExecution!({ requestId: meta.requestId, success: true, content: { status: 'ok' } });
      await first;
      const resultCountBeforeDuplicate = sent.filter((item) => item.type === 'executeResult').length;
      await (runtime as any).handleExecutionRequest({
        type: 'executeRequest', payload: new Uint8Array(), meta,
      }, 'peer-z');
      assert.equal(executionCount, 1, 'completed lightweight duplicate replays without re-execution');
      assert.ok(
        sent.filter((item) => item.type === 'executeResult').length > resultCountBeforeDuplicate,
        'completed lightweight duplicate replays the cached terminal result',
      );
      await (runtime as any).onMessage({
        type: 'executeResultAck', payload: new Uint8Array(), meta: { requestId: meta.requestId },
      }, 'peer-z');
      assert.equal((runtime as any).completedRemoteExecutions.size, 0,
        'result acknowledgement ends completed replay lifecycle');
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('orders and deduplicates replayed execution events before resolving the result', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-exec-event-order-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'exec-event-order', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'exec-event-order-token-that-is-long-enough', context(extensionRoot), logger());
    const requestId = 'event-order-request';
    const seen: string[] = [];
    const sentTypes: string[] = [];
    let resolved: any;
    const resultPromise = new Promise<void>((resolve, reject) => {
      (runtime as any).pendingExecutions.set(requestId, {
        resolve: (result: any) => { resolved = result; resolve(); },
        reject,
        onEvent: (event: any) => seen.push(String(event.content.text)),
        executorId: 'peer-z',
        notebookKey: 'work.ipynb',
        timer: setTimeout(() => reject(new Error('test timed out')), 10_000),
        accepted: false,
        nextEventSequence: 0,
        bufferedEvents: new Map(),
        bufferedEventBytes: 0,
      });
    });
    (runtime as any).transport = {
      sendTo: (_peerId: string, type: string) => sentTypes.push(type),
      stop: async () => undefined,
    };
    const largeBuffer = Buffer.alloc(1024 * 1024, 7).toString('base64');
    const eventFrame = (sequence: number, text: string, buffersBase64?: string[]) => ({
      type: 'executionEvent',
      meta: { requestId, eventSequence: sequence },
      payload: Buffer.from(JSON.stringify({
        type: 'iopub', requestId, messageType: 'stream', content: { name: 'stdout', text },
        ...(buffersBase64 ? { buffersBase64 } : {}),
      }), 'utf8'),
    });
    try {
      await (runtime as any).onMessage(eventFrame(1, 'second', [largeBuffer]), 'peer-z');
      assert.deepEqual(seen, [], 'a gap must be buffered instead of rendering out of order');
      await (runtime as any).onMessage({
        type: 'executeResult', payload: Buffer.from(JSON.stringify({
          requestId, success: true, content: { status: 'ok' },
        }), 'utf8'), meta: {
          requestId,
          eventCount: 2,
        },
      }, 'peer-z');
      assert.equal(resolved, undefined, 'the result must wait for all preceding events');
      await (runtime as any).onMessage(eventFrame(1, 'second', [largeBuffer]), 'peer-z');
      await (runtime as any).onMessage(eventFrame(0, 'first'), 'peer-z');
      await resultPromise;
      await (runtime as any).onMessage(eventFrame(0, 'first'), 'peer-z');
      assert.deepEqual(seen, ['first', 'second']);
      assert.equal((resolved as { success: boolean } | undefined)?.success, true);
      assert.ok(sentTypes.includes('executeResultAck'));
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes one authoritative host CRDT output/execution state that reaches a third participant', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-authoritative-output-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'authoritative-output', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'authoritative-output-token-that-is-long-enough', context(extensionRoot), logger());
    const third = new CollaborativeProject();
    let outputScopeUpdates = 0;
    let executionScopeUpdates = 0;
    let executionCount = 0;
    try {
      runtime.project.ensureNotebook('work.ipynb', {
        metadata: {},
        cells: [{ id: 'cell-a', kind: 2, language: 'python', source: 'print("AUTHORITATIVE")', metadata: {}, outputs: [] }],
      });
      third.ensureNotebook('work.ipynb');
      third.applyRemoteUpdate('work.ipynb', 'notebook', runtime.project.encodeUpdate('work.ipynb'), { type: 'structure' });
      (runtime as any).updatePresence();
      runtime.project.on('update', (event: any) => {
        if (event.key !== 'work.ipynb' || event.kind !== 'notebook') return;
        if (event.scope?.type === 'cellOutputs') outputScopeUpdates += 1;
        if (event.scope?.type === 'cellExecution') executionScopeUpdates += 1;
        third.applyRemoteUpdate(event.key, event.kind, event.update, event.scope);
      });
      const state = runtime.project.cellTextState('work.ipynb', 'cell-a');
      const target = runtime.computeForNotebook('work.ipynb');
      (runtime as any).transport = {
        sendTo: () => undefined,
        peerRuntime: () => [],
        stop: async () => undefined,
      };
      (runtime as any).executeLocally = async (
        _key: string, _target: unknown, requestId: string, code: string, onEvent: (event: any) => void,
      ) => {
        executionCount += 1;
        assert.equal(code, 'print("AUTHORITATIVE")');
        onEvent({
          type: 'iopub', requestId, messageType: 'execute_input',
          content: { execution_count: 9 },
        });
        for (let index = 0; index < 20; index += 1) {
          onEvent({
            type: 'iopub', requestId, messageType: 'stream',
            content: { name: 'stdout', text: `OUTPUT ${index}\n` },
          });
        }
        return { requestId, success: true, content: { status: 'ok', execution_count: 9 } };
      };

      await (runtime as any).handleExecutionRequest({
        type: 'executeRequest', payload: new Uint8Array(),
        meta: {
          requestId: 'authoritative-output-request',
          notebookKey: 'work.ipynb',
          cellId: 'cell-a',
          executorId: 'host',
          computeEpoch: target.epoch,
          cellRevision: state.revision,
          cellDigest: createHash('sha256').update(state.source, 'utf8').digest('hex'),
          fastPath: true,
        },
      }, 'peer-z');

      assert.equal(executionCount, 1);
      const hostCell = runtime.project.notebookCellSnapshot('work.ipynb', 'cell-a');
      const thirdCell = third.notebookCellSnapshot('work.ipynb', 'cell-a');
      assert.ok(hostCell && thirdCell);
      assert.deepEqual(thirdCell.outputs, hostCell.outputs);
      assert.deepEqual(thirdCell.execution, hostCell.execution);
      assert.equal(
        thirdCell.outputs.map((output) => output.items.map((item) =>
          Buffer.from(item.dataBase64, 'base64').toString('utf8')).join('')).join(''),
        Array.from({ length: 20 }, (_, index) => `OUTPUT ${index}\n`).join(''),
      );
      assert.equal(thirdCell.execution?.requestId, 'authoritative-output-request');
      assert.equal(thirdCell.execution?.executionOrder, 9);
      assert.equal(thirdCell.execution?.success, true);
      assert.equal(outputScopeUpdates, 2, 'host publishes only initial and final CRDT output state for a short burst');
      assert.ok(executionScopeUpdates >= 2, 'host publishes running/order/final execution state');

      const beforeReplay = JSON.stringify(thirdCell.outputs);
      (runtime as any).replayRemoteExecutionsForPeer('peer-z');
      assert.equal(JSON.stringify(third.notebookCellSnapshot('work.ipynb', 'cell-a')?.outputs), beforeReplay,
        'recovery replay never mutates authoritative CRDT outputs');
    } finally {
      third.destroy();
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects pending remote executions when the session closes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-dispose-exec-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'dispose-exec', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'dispose-exec-token-that-is-long-enough', context(extensionRoot), logger());
    let rejected: (Error & { reason?: string }) | undefined;
    (runtime as any).pendingExecutions.set('pending', {
      resolve: () => undefined,
      reject: (error: Error & { reason?: string }) => { rejected = error; },
      onEvent: () => undefined,
      executorId: 'peer-z',
      notebookKey: 'work.ipynb',
      timer: setTimeout(() => undefined, 60_000),
      accepted: true,
    });
    try {
      await (runtime as any).disposeAsync();
      assert.ok(rejected instanceof SessionClosedError);
      assert.equal(rejected.reason, 'explicit-leave');
      assert.match(rejected.message, /Pair Notebook session closed: explicit-leave/);
      assert.equal((runtime as any).pendingExecutions.size, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the old host backing root enabled and cleans waiters when transfer commit fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-host-transfer-fail-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'transfer-fail', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'transfer-fail-token-that-is-long-enough', context(extensionRoot), logger());
    const backingChanges: Array<string | undefined> = [];
    (runtime as any).storage = {
      flush: async () => undefined,
      setBackingRoot: (value: string | undefined) => backingChanges.push(value),
      stop: async () => undefined,
    };
    (runtime as any).transport = {
      peerRuntime: () => [{ peerId: 'peer-z', displayName: 'peer-z', online: true, joinOrder: 1, latency: 1, latencyEma: 1, lastHeartbeat: Date.now(), missedHeartbeats: 0, route: 'Direct' }],
      sendTo: (_peerId: string, type: string, meta: any) => {
        if (type === 'hostTransferPrepare') {
          queueMicrotask(() => (runtime as any).resolveHostTransfer(meta.transferId, 'peer-z', meta.nextClock));
        } else if (type === 'hostTransferCommit') {
          throw new Error('commit transport failed');
        }
      },
      stop: async () => undefined,
      broadcast: () => undefined,
    };
    try {
      await assert.rejects(runtime.transferHost('peer-z'), /commit transport failed/);
      assert.deepEqual(backingChanges, [], 'old host backing root stays enabled until commit is acknowledged');
      assert.equal((runtime as any).pendingTransfers.size, 0, 'failed transfer leaves no pending waiter');
      assert.equal(runtime.coordinator.clock.hostId, 'host', 'failed transfer does not change coordinator');
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('completes host transfer across two Trystero runtimes without dual-role divergence', async function () {
    this.timeout(50_000);
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-host-transfer-real-'));
    const extensionRoot = path.join(root, 'extension');
    const hostFolder = path.join(root, 'host');
    const peerFolder = path.join(root, 'peer');
    await Promise.all([
      mkdir(extensionRoot, { recursive: true }),
      mkdir(hostFolder, { recursive: true }),
      mkdir(peerFolder, { recursive: true }),
    ]);
    const token = 'host-transfer-real-token-that-is-long-enough';
    const sessionId = `transfer-real-${Date.now()}`;
    const host = new SessionRuntime(descriptor({
      sessionId, role: 'host', peerId: 'host', hostPeerId: 'host', workingFolder: hostFolder,
      pythonPath: process.execPath,
    }), token, context(extensionRoot), logger());
    let peer: any;
    let third: any;
    try {
      await host.start();
      host.project.ensureText('handoff.txt', 'saved before handoff');
      await host.flush();
      const oldHostBacking = host.descriptor.backingFolder;
      const peerIdentity = generateIdentityCredentials();
      const peerDescriptor = descriptor({
        sessionId, role: 'peer', peerId: 'peer-z', hostPeerId: 'host', workingFolder: peerFolder,
        pythonPath: process.execPath,
        knownPeers: [{ ...host.descriptor.localPeer }],
      });
      peerDescriptor.localPeer.identityKey = peerIdentity.publicKey;
      peer = new SessionRuntime(peerDescriptor, token, context(extensionRoot), logger(), peerIdentity.privateKey);
      await peer.start();
      await waitFor(() => host.snapshot().peers.some((item: any) => item.peerId === 'peer-z' && item.online), 5000, 'transfer peer online');
      await host.transferHost('peer-z');
      await waitFor(() => host.coordinator.clock.hostId === 'peer-z' && peer.coordinator.clock.hostId === 'peer-z', 5000, 'host transfer convergence');
      assert.equal(host.descriptor.role, 'peer');
      assert.equal(peer.descriptor.role, 'host');
      assert.equal(host.snapshot().waitingForHostFolder, true);
      assert.equal(peer.snapshot().waitingForHostFolder, true);
      assert.equal(host.snapshot().runtimeState, 'waiting-for-host-folder');
      assert.equal(peer.snapshot().runtimeState, 'waiting-for-host-folder');
      assert.equal(await readFile(path.join(oldHostBacking, 'handoff.txt'), 'utf8'), 'saved before handoff');
      const inspection = await peer.inspectBackingFolder(oldHostBacking);
      assert.equal(inspection.empty, false);
      assert.equal(inspection.matches, true, 'the Dropbox-style shared copy matches the transferred CRDT state');
      await peer.setBackingFolder(oldHostBacking, 'reuse-existing');
      await waitFor(() => !host.snapshot().waitingForHostFolder && !peer.snapshot().waitingForHostFolder, 3000, 'manual host-transfer resume');
      assert.equal(await readFile(path.join(oldHostBacking, 'handoff.txt'), 'utf8'), 'saved before handoff');
      assert.equal(peer.descriptor.backingFolder, oldHostBacking);
      assert.equal((host as any).pendingTransfers.size, 0);
      assert.equal((peer as any).preparedHostTransfers.size, 0);
      const invite = parseInvite(formatInvite({
        sessionId, projectId: peer.descriptor.projectId, projectName: peer.descriptor.projectName,
        mode: 'resilient', token, sessionEpoch: peer.coordinator.clock.sessionEpoch,
        hostEpoch: peer.coordinator.clock.hostEpoch, hostPeerId: peer.descriptor.localPeer.peerId,
        hostDisplayName: peer.descriptor.localPeer.displayName, hostIdentityKey: peer.descriptor.localPeer.identityKey,
      }));
      const thirdDescriptor = descriptor({ sessionId, role: 'peer', peerId: 'third', hostPeerId: invite.hostPeerId,
        workingFolder: path.join(root, 'third'), pythonPath: process.execPath, knownPeers: [{ ...peer.descriptor.localPeer }] });
      thirdDescriptor.hostEpoch = invite.hostEpoch ?? 0;
      await mkdir(thirdDescriptor.workingFolder, { recursive: true });
      third = new SessionRuntime(thirdDescriptor, token, context(extensionRoot), logger());
      await third.start();
      assert.deepEqual(third.coordinator.clock, peer.coordinator.clock);
      await peer.transferHost('third');
      await waitFor(() => [host, peer, third].every((item) => item.coordinator.clock.hostEpoch === 2
        && item.coordinator.clock.hostId === 'third' && item.snapshot().waitingForHostFolder), 5000, 'second transfer and pause');
      await third.setBackingFolder(oldHostBacking, 'reuse-existing');
      await waitFor(() => [host, peer, third].every((item) => !item.snapshot().waitingForHostFolder), 3000, 'second transfer resume');
      assert.equal(third.descriptor.hostEpoch, 2);
    } finally {
      host.descriptor.mode = 'host-only';
      if (peer) peer.descriptor.mode = 'host-only';
      if (third) third.descriptor.mode = 'host-only';
      await Promise.allSettled([host.leave(), peer?.leave(), third?.leave()]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('expires internal write echoes after observing different external content', () => {
    const runtime = Object.create(SessionRuntime.prototype) as any;
    runtime.internalWorkingWrites = new Map();
    const original = Buffer.from('x = 1');
    const internal = Buffer.from('x = 2');
    runtime.rememberInternalWorkingWrite('switch.py', original);
    runtime.rememberInternalWorkingWrite('switch.py', internal);
    assert.equal(runtime.matchesInternalWorkingWrite('switch.py', original), true);
    assert.equal(runtime.matchesInternalWorkingWrite('switch.py', internal), true);
    assert.equal(runtime.matchesInternalWorkingWrite('switch.py', internal), true, 'duplicate watcher echoes stay suppressed');
    assert.equal(runtime.matchesInternalWorkingWrite('switch.py', Buffer.from([255, 0, 1])), false);
    assert.equal(runtime.matchesInternalWorkingWrite('switch.py', original), false, 'restoring previous bytes is a new user edit');
    assert.equal(runtime.matchesInternalWorkingWrite('switch.py', internal), false);
  });

  it('keeps one materialized representation through binary and collaborative file transitions', async function () {
    this.timeout(35_000);
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-kind-transitions-'));
    const hostFolder = path.join(root, 'host');
    const peerFolder = path.join(root, 'peer');
    await Promise.all([mkdir(hostFolder), mkdir(peerFolder)]);
    const notebook = JSON.stringify({ cells: [{ cell_type: 'code', id: 'a', source: ['x = 1'], metadata: {}, outputs: [], execution_count: null }],
      metadata: {}, nbformat: 4, nbformat_minor: 5 });
    await writeFile(path.join(hostFolder, 'switch.py'), 'x = 1');
    await writeFile(path.join(hostFolder, 'work.ipynb'), notebook);
    const sessionId = `kind-${Date.now()}`;
    const token = 'kind-transition-token-that-is-long-enough';
    const host = new SessionRuntime(descriptor({ sessionId, role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: hostFolder, pythonPath: process.execPath }), token, context(root), logger());
    let peer: any;
    try {
      await host.start();
      peer = new SessionRuntime(descriptor({ sessionId, role: 'peer', peerId: 'peer', hostPeerId: 'host',
        workingFolder: peerFolder, pythonPath: process.execPath, knownPeers: [{ ...host.descriptor.localPeer }] }), token, context(root), logger());
      await peer.start();
      for (const [key, original, kind] of [['switch.py', 'x = 1', 'text'], ['work.ipynb', notebook, 'notebook']]) {
        await writeFile(path.join(hostFolder, key!), Buffer.from([255, 0, 1]));
        await host.onLocalFile(fakeVscode.Uri.file(path.join(hostFolder, key!)), 'change');
        await waitFor(() => peer.binaryVersions.has(key) && !peer.project.has(key), 4000, 'binary representation');
        const materialization = await peer.collectMaterialization();
        assert.equal([...materialization.documents, ...materialization.binaries].filter((file: any) => file.relativePath === key).length, 1);
        await writeFile(path.join(hostFolder, key!), original!);
        await host.onLocalFile(fakeVscode.Uri.file(path.join(hostFolder, key!)), 'change');
        await waitFor(() => peer.project.kindOf(key) === kind && !peer.binaryVersions.has(key), 4000, 'collaborative representation');
      }
      await host.flush();
      const backing = host.descriptor.backingFolder;
      await host.transferHost('peer');
      await waitFor(() => peer.descriptor.role === 'host', 3000, 'transferred host');
      await peer.setBackingFolder(backing, 'reuse-existing');
      assert.equal((await peer.collectMaterialization()).documents.length, 2);
    } finally {
      await Promise.allSettled([host.leave(), peer?.leave()]);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it('preserves a live Jupyter kernel and its variables across a notebook rename', async function () {
    this.timeout(35_000);
    const folder = await mkdtemp(path.join(os.tmpdir(), 'pair-kernel-rename-'));
    const runtime = new SessionRuntime(descriptor({ sessionId: `rename-${Date.now()}`, role: 'host',
      peerId: 'host', hostPeerId: 'host', workingFolder: folder, pythonPath: 'python' }),
    'rename-kernel-token-that-is-long-enough', context(path.resolve(__dirname, '../..')), logger());
    try {
      await writeFile(path.join(folder, 'work.ipynb'), JSON.stringify({ cells: [
        { cell_type: 'code', id: 'a', source: ['x = 42'], metadata: {}, outputs: [], execution_count: null },
      ], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
      await runtime.start();
      await runtime.executeCell('work.ipynb', 'a', 'x = 42', () => undefined);
      const kernel = runtime.kernels.get('work.ipynb');
      const events: any[] = [];
      const active = runtime.executeCell('work.ipynb', 'a', 'import time; time.sleep(0.5); x += 1; print(x)', (event: any) => events.push(event));
      await waitFor(() => runtime.kernelStatuses.get('work.ipynb') === 'Busy', 1000, 'active execution');
      await rename(path.join(folder, 'work.ipynb'), path.join(folder, 'renamed.ipynb'));
      await runtime.onLocalRename(fakeVscode.Uri.file(path.join(folder, 'work.ipynb')), fakeVscode.Uri.file(path.join(folder, 'renamed.ipynb')));
      assert.equal((await active).success, true);
      assert.equal(runtime.kernels.get('renamed.ipynb'), kernel);
      assert.equal(runtime.kernelStatuses.has('work.ipynb'), false);
      const result = await runtime.executeCell('renamed.ipynb', 'a', 'print(x)', (event: any) => events.push(event));
      assert.equal(result.success, true);
      assert.ok(events.some((event) => event.messageType === 'stream' && String(event.content?.text).includes('43')));
      assert.equal(runtime.kernels.size, 1);
      assert.equal(runtime.project.has('work.ipynb'), false);
    } finally {
      await runtime.leave();
      await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      await rm(`${folder}-backing`, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });

  it('lets a paused host transfer again and end without choosing a backing folder', async function () {
    this.timeout(30_000);
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-paused-host-actions-'));
    const extensionRoot = path.join(root, 'extension');
    const hostFolder = path.join(root, 'host');
    const peerFolder = path.join(root, 'peer');
    const sharedFolder = path.join(root, 'shared');
    await Promise.all([
      mkdir(extensionRoot, { recursive: true }),
      mkdir(hostFolder, { recursive: true }),
      mkdir(peerFolder, { recursive: true }),
      mkdir(sharedFolder, { recursive: true }),
    ]);
    const token = 'paused-host-actions-token-that-is-long-enough';
    const sessionId = `paused-actions-${Date.now()}`;
    const host = new SessionRuntime(descriptor({
      sessionId, role: 'host', peerId: 'host', hostPeerId: 'host', workingFolder: hostFolder,
      pythonPath: process.execPath, backingFolder: sharedFolder,
    }), token, context(extensionRoot), logger());
    let peer: any;
    let stale: any;
    try {
      await host.start();
      host.setWorkingCopyWriter(async () => false, async () => undefined);
      peer = new SessionRuntime(descriptor({
        sessionId, role: 'peer', peerId: 'peer-z', hostPeerId: 'host', workingFolder: peerFolder,
        pythonPath: process.execPath,
        knownPeers: [{ ...host.descriptor.localPeer }],
      }), token, context(extensionRoot), logger());
      await peer.start();
      peer.setWorkingCopyWriter(async () => false, async () => undefined);
      await waitFor(() => host.snapshot().peers.some((item: any) => item.peerId === 'peer-z' && item.online), 5000, 'paused-action peer online');

      await host.transferHost('peer-z');
      await waitFor(() => peer.coordinator.clock.hostId === 'peer-z'
        && host.snapshot().waitingForHostFolder && peer.snapshot().waitingForHostFolder,
      5000, 'first paused host transfer');

      await peer.transferHost('host');
      await waitFor(() => host.coordinator.clock.hostId === 'host'
        && host.snapshot().waitingForHostFolder && peer.snapshot().waitingForHostFolder,
      5000, 'transfer while folder selection is paused');
      assert.equal(host.descriptor.backingFolder, '', 'returning host must not silently reuse its old backing folder');

      await host.transferHost('peer-z');
      await waitFor(() => peer.coordinator.clock.hostId === 'peer-z'
        && host.snapshot().waitingForHostFolder && peer.snapshot().waitingForHostFolder,
      5000, 'second paused host transfer');

      peer.project.ensureText('paused-final.txt', 'kept without a new shared folder');
      await waitFor(() => host.project.has('paused-final.txt')
        && host.project.text('paused-final.txt').toString() === 'kept without a new shared folder',
      3000, 'final paused edit replication');
      const peerStorage = (peer as any).storage;
      const flushWorkingCopy = peerStorage.flush.bind(peerStorage);
      peerStorage.flush = async () => { throw new Error('synthetic paused final-save failure'); };
      await assert.rejects(peer.endSession(), /synthetic paused final-save failure/);
      await waitFor(() => host.snapshot().runtimeState === 'waiting-for-host-folder'
        && host.snapshot().waitingForHostFolder,
      3000, 'cancelled paused end restores pause state');
      assert.equal(peer.snapshot().closed, false);
      peerStorage.flush = flushWorkingCopy;

      const endedBy = new Promise<any>((resolve) => host.once('sessionEnded', resolve));
      const hostClosed = onceEvent(host, 'closed');
      const peerClosed = onceEvent(peer, 'closed');
      await peer.endSession();

      const [endingHost] = await Promise.all([endedBy, hostClosed, peerClosed]);
      assert.equal(endingHost.peerId, 'peer-z');
      assert.equal(await readFile(path.join(hostFolder, 'paused-final.txt'), 'utf8'), 'kept without a new shared folder');
      assert.equal(await readFile(path.join(peerFolder, 'paused-final.txt'), 'utf8'), 'kept without a new shared folder');
      const hostMarker = JSON.parse(await readFile(path.join(hostFolder, '.pair-notebook-ended.json'), 'utf8'));
      const peerMarker = JSON.parse(await readFile(path.join(peerFolder, '.pair-notebook-ended.json'), 'utf8'));
      assert.equal(hostMarker.endedByPeerId, 'peer-z');
      assert.equal(peerMarker.endedByPeerId, 'peer-z');
      await assert.rejects(readFile(path.join(sharedFolder, '.pair-notebook-ended.json')), /ENOENT/);

      const staleDescriptor = { ...peer.descriptor, freshStart: false };
      stale = new SessionRuntime(staleDescriptor, token, context(extensionRoot), logger());
      await assert.rejects(stale.start(), /has already ended/);
    } finally {
      await Promise.allSettled([host.leave(), peer?.leave?.(), stale?.leave?.()]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lets the host end a Trystero session for every participant', async function () {
    this.timeout(30_000);
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-session-end-real-'));
    const extensionRoot = path.join(root, 'extension');
    const hostFolder = path.join(root, 'host');
    const peerFolder = path.join(root, 'peer');
    const sharedFolder = path.join(root, 'shared');
    await Promise.all([
      mkdir(extensionRoot, { recursive: true }),
      mkdir(hostFolder, { recursive: true }),
      mkdir(peerFolder, { recursive: true }),
      mkdir(sharedFolder, { recursive: true }),
    ]);
    const token = 'session-end-real-token-that-is-long-enough';
    const sessionId = `session-end-real-${Date.now()}`;
    const host = new SessionRuntime(descriptor({
      sessionId, role: 'host', peerId: 'host', hostPeerId: 'host', workingFolder: hostFolder,
      pythonPath: process.execPath, backingFolder: sharedFolder,
    }), token, context(extensionRoot), logger());
    let peer: any;
    try {
      await host.start();
      peer = new SessionRuntime(descriptor({
        sessionId, role: 'peer', peerId: 'peer-z', hostPeerId: 'host', workingFolder: peerFolder,
        pythonPath: process.execPath,
        knownPeers: [{ ...host.descriptor.localPeer }],
      }), token, context(extensionRoot), logger());
      await peer.start();
      await waitFor(() => host.snapshot().peers.some((item: any) => item.peerId === 'peer-z' && item.online), 5000, 'session-end peer online');

      peer.project.ensureText('last-edit.txt', 'peer final edit');
      const endedBy = new Promise<any>((resolve) => peer.once('sessionEnded', resolve));
      const peerClosed = onceEvent(peer, 'closed');
      const hostClosed = onceEvent(host, 'closed');
      await host.endSession();

      const [endingHost] = await Promise.all([endedBy, peerClosed, hostClosed]);
      assert.equal(endingHost.peerId, 'host');
      assert.equal((host as any).closed, true);
      assert.equal((peer as any).closed, true);
      assert.equal(peer.descriptor.role, 'peer', 'ending a session must not promote a replacement host');
      assert.equal(await readFile(path.join(sharedFolder, 'last-edit.txt'), 'utf8'), 'peer final edit');
      const marker = JSON.parse(await readFile(path.join(sharedFolder, '.pair-notebook-ended.json'), 'utf8'));
      assert.equal(marker.sessionId, sessionId);

      const staleFolder = path.join(root, 'stale-host');
      await mkdir(staleFolder, { recursive: true });
      const staleDescriptor = descriptor({
        sessionId, role: 'host', peerId: 'old-host', hostPeerId: 'old-host', workingFolder: staleFolder,
        pythonPath: process.execPath, backingFolder: sharedFolder,
      });
      staleDescriptor.freshStart = false;
      const staleHost = new SessionRuntime(staleDescriptor, token, context(extensionRoot), logger());
      await assert.rejects(staleHost.start(), /has already ended/);
      await staleHost.leave();
    } finally {
      await Promise.allSettled([host.leave(), peer?.leave()]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not let heartbeat metadata transfer host authority', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-host-heartbeat-clock-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'heartbeat-clock', role: 'peer', peerId: 'peer-third', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
      knownPeers: [
        { peerId: 'host', displayName: 'host', joinOrder: 0 },
        { peerId: 'peer-z', displayName: 'peer-z', joinOrder: 1 },
      ],
    }), 'heartbeat-clock-token-that-is-long-enough', context(extensionRoot), logger());
    (runtime as any).storage = {
      setBackingRoot: () => undefined, flush: async () => undefined, pendingCount: () => 0, stop: async () => undefined,
    };
    try {
      const nextClock = { ...runtime.coordinator.clock, hostEpoch: runtime.coordinator.clock.hostEpoch + 1, hostId: 'peer-z' };
      await (runtime as any).onMessage({
        type: 'hostHeartbeat', payload: new Uint8Array(), meta: { clock: nextClock },
      }, 'peer-z');
      assert.equal(runtime.coordinator.clock.hostId, 'host');
      assert.equal(runtime.coordinator.clock.hostEpoch, 0, 'a new peer cannot self-promote through heartbeat metadata');

      await (runtime as any).onMessage({
        type: 'helloAck', payload: new Uint8Array(), meta: { clock: nextClock, hostStorageReady: true },
      }, 'peer-z');
      assert.equal(runtime.coordinator.clock.hostId, 'host', 'hello metadata cannot transfer authority without proven isolation');

      await (runtime as any).onMessage({
        type: 'hostAnnouncement', payload: new Uint8Array(), meta: { clock: nextClock },
      }, 'host');
      assert.equal(runtime.coordinator.clock.hostId, 'peer-z');
      assert.equal(runtime.descriptor.hostPeerId, 'peer-z');
      assert.equal(runtime.descriptor.hostEpoch, nextClock.hostEpoch);

      const forged = { ...nextClock, hostEpoch: nextClock.hostEpoch + 1, hostId: 'peer-z' };
      await (runtime as any).onMessage({
        type: 'hostHeartbeat', payload: new Uint8Array(), meta: { clock: forged },
      }, 'peer-attacker');
      assert.equal(runtime.coordinator.clock.hostEpoch, nextClock.hostEpoch, 'non-host heartbeat cannot advance the host clock');
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects skipped host clocks and accepts only the current host exact transfer', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-host-clock-reconcile-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'clock-reconcile', role: 'host', peerId: 'old-host', hostPeerId: 'old-host',
      workingFolder: folder, pythonPath: process.execPath,
      knownPeers: [{ peerId: 'new-host', displayName: 'New Host', joinOrder: 1 }],
    }), 'clock-reconcile-token-that-is-long-enough', context(extensionRoot), logger());
    (runtime as any).transport = {
      peerRuntime: () => [{
        peerId: 'new-host', displayName: 'New Host', joinOrder: 1, online: true,
        latency: 1, latencyEma: 1, lastHeartbeat: Date.now(), missedHeartbeats: 0, route: 'Direct',
      }],
      broadcast: () => undefined,
      stop: async () => undefined,
    };
    try {
      await (runtime as any).onMessage({
        type: 'helloAck', payload: new Uint8Array(),
        meta: { clock: { sessionEpoch: 10, hostEpoch: 3, hostId: 'new-host' }, hostStorageReady: true },
      }, 'new-host');
      assert.equal(runtime.coordinator.clock.hostId, 'old-host');
      assert.equal(runtime.coordinator.clock.hostEpoch, 0);

      await (runtime as any).onMessage({
        type: 'hostAnnouncement', payload: new Uint8Array(),
        meta: { clock: { sessionEpoch: 10, hostEpoch: 3, hostId: 'new-host' } },
      }, 'old-host');
      assert.equal(runtime.coordinator.clock.hostId, 'old-host', 'the current host cannot skip transfer epochs');

      await (runtime as any).onMessage({
        type: 'hostAnnouncement', payload: new Uint8Array(),
        meta: { clock: { sessionEpoch: 10, hostEpoch: 1, hostId: 'new-host' } },
      }, 'old-host');
      assert.equal(runtime.coordinator.clock.hostId, 'new-host');
      assert.equal(runtime.coordinator.clock.hostEpoch, 1);
      assert.equal(runtime.descriptor.role, 'peer');
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cleans prepared host-transfer state when the committed host announcement arrives', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-host-transfer-finalize-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'transfer-finalize', role: 'peer', peerId: 'peer-z', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
      knownPeers: [{ peerId: 'host', displayName: 'host', joinOrder: 0 }],
    }), 'transfer-finalize-token-that-is-long-enough', context(extensionRoot), logger());
    (runtime as any).transport = { sendTo: () => undefined, stop: async () => undefined };
    try {
      const nextClock = { ...runtime.coordinator.clock, hostEpoch: runtime.coordinator.clock.hostEpoch + 1, hostId: 'peer-z' };
      await (runtime as any).onMessage({
        type: 'hostTransferPrepare', payload: new Uint8Array(), meta: { transferId: 't1', nextClock },
      }, 'host');
      assert.equal((runtime as any).preparedHostTransfers.size, 1);
      await (runtime as any).onMessage({
        type: 'hostTransferCommit', payload: new Uint8Array(), meta: { transferId: 't1', nextClock },
      }, 'host');
      assert.equal((runtime as any).preparedHostTransfers.size, 1);
      await (runtime as any).onMessage({
        type: 'hostAnnouncement', payload: new Uint8Array(), meta: { clock: nextClock },
      }, 'host');
      assert.equal((runtime as any).preparedHostTransfers.size, 0);
      assert.equal(runtime.coordinator.clock.hostId, 'peer-z');
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores host-transfer acknowledgements from the wrong peer', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-host-transfer-auth-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'transfer-auth', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'transfer-auth-token-that-is-long-enough', context(extensionRoot), logger());
    let resolved = false;
    const clock = { ...runtime.coordinator.clock, hostEpoch: runtime.coordinator.clock.hostEpoch + 1, hostId: 'peer-z' };
    const promise = (runtime as any).waitForHostTransfer('transfer-id', 'peer-z', clock, 200, 'timeout', () => undefined)
      .then(() => { resolved = true; })
      .catch(() => undefined);
    try {
      (runtime as any).resolveHostTransfer('transfer-id', 'peer-attacker', clock);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(resolved, false);
      (runtime as any).resolveHostTransfer('transfer-id', 'peer-z', clock);
      await promise;
      assert.equal(resolved, true);
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('standard VS Code NotebookController production path', () => {
  it('restores the Pair kernel on notebook switches without restarting or executing', async () => {
    const notebookA = notebookForController('A');
    const notebookB = notebookForController('B');
    const outside = notebookForController('outside');
    const originalCommand = fakeVscode.commands.executeCommand;
    const originalSubscribe = fakeVscode.window.onDidChangeActiveNotebookEditor;
    let activate: ((editor: any) => void) | undefined;
    const selections: any[] = [];
    fakeVscode.window.onDidChangeActiveNotebookEditor = (callback: (editor: any) => void) => {
      activate = callback;
      return { dispose: () => { activate = undefined; } };
    };
    fakeVscode.commands.executeCommand = async (command: string, options: any) => {
      assert.equal(command, 'notebook.selectKernel');
      assert.equal(options.id, 'pair-notebook-jupyter');
      selections.push(options.notebookEditor.notebook);
      return true;
    };
    fakeVscode.window.activeNotebookEditor = { notebook: notebookA };
    const controller = new PairNotebookController(logger());
    const runtime = {
      notebookKey: (uri: any) => uri === outside.uri ? undefined : uri.fsPath,
      restartNotebook: () => assert.fail('switching files must not restart a kernel'),
      executeCell: () => assert.fail('switching files must not execute a cell'),
    };
    try {
      controller.setRuntime(runtime);
      await waitFor(() => selections.length === 1, 1000, 'initial kernel selection');
      for (const notebook of [notebookB, notebookA]) {
        fakeVscode.window.activeNotebookEditor = { notebook };
        activate?.(fakeVscode.window.activeNotebookEditor);
      }
      await waitFor(() => selections.length === 3, 1000, 'kernel selection after tab switches');
      assert.deepEqual(selections, [notebookA, notebookB, notebookA]);
      activate?.(undefined);
      activate?.({ notebook: outside });
      controller.setRuntime(undefined);
      activate?.({ notebook: notebookB });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(selections.length, 3, 'unshared files and ended sessions must not claim a kernel');
    } finally {
      controller.dispose();
      fakeVscode.commands.executeCommand = originalCommand;
      fakeVscode.window.onDidChangeActiveNotebookEditor = originalSubscribe;
      fakeVscode.window.activeNotebookEditor = undefined;
    }
  });

  it('selects the Pair controller before Pair Run and refuses a failed kernel selection', async () => {
    const controller = new PairNotebookController(logger());
    const notebook = notebookForController('A');
    fakeCell('a', notebook);
    const project = new CollaborativeProject();
    let pairRuns = 0;
    let nativeRuns = 0;
    let selected = 'native-python';
    let allowSelection = true;
    const originalCommand = fakeVscode.commands.executeCommand;
    controller.setRuntime({ project, descriptor: { localPeer: { peerId: 'guest' } },
      notebookKey: () => 'A', notebookCellId: () => 'a', computeForNotebook: () => ({ executorId: 'host' }),
      executeCell: async () => { pairRuns += 1; assert.equal(selected, 'pair-notebook-jupyter'); return { success: true, content: {} }; },
    });
    fakeVscode.window.activeNotebookEditor = { notebook, selection: { start: 0, end: 1 } };
    fakeVscode.commands.executeCommand = async (command: string, options: any) => {
      if (command === 'notebook.cell.execute') nativeRuns += 1;
      if (command !== 'notebook.selectKernel') return undefined;
      assert.equal(options.extension, 'pair-notebook.pair-notebook');
      assert.equal(options.notebookEditor.notebook, notebook);
      if (allowSelection) selected = options.id;
      return allowSelection;
    };
    try {
      await controller.executeActive();
      assert.equal(pairRuns, 1);
      assert.equal(nativeRuns, 0);
      allowSelection = false;
      await assert.rejects(controller.executeActive(), /could not select/);
      assert.equal(pairRuns, 1);
    } finally {
      fakeVscode.commands.executeCommand = originalCommand;
      fakeVscode.window.activeNotebookEditor = undefined;
      controller.dispose(); project.destroy();
    }
  });

  it('routes Run Cell through per-notebook queues and routes Interrupt to the runtime', async () => {
    const controller = new PairNotebookController(logger());
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let computeExecutorId = 'guest';
    let outputPublishCount = 0;
    let executionPublishCount = 0;
    const runtime: any = {
      descriptor: { localPeer: { peerId: 'guest' } },
      notebookKey: (uri: any) => uri.fsPath,
      notebookCellId: (cell: any) => cell.id,
      computeForNotebook: () => ({ executorId: computeExecutorId, device: 'cpu', epoch: 1, author: 'host' }),
      executeCell: async (key: string, id: string) => {
        calls.push(`${key}:${id}:start`);
        if (key === 'A' && id === '1') await firstGate;
        calls.push(`${key}:${id}:end`);
        return { requestId: id, success: true, content: { status: 'ok' } };
      },
      interruptNotebook: async (key: string) => { calls.push(`${key}:interrupt`); },
      restartNotebook: async (key: string) => { calls.push(`${key}:restart`); },
      reportWaitingForInput: (key: string) => { calls.push(`${key}:waiting-input`); },
      reportInputResolved: (key: string) => { calls.push(`${key}:input-resolved`); },
      replyToInput: (requestId: string, value: string) => { calls.push(`${requestId}:reply:${value}`); },
      cancelInput: async (requestId: string) => { calls.push(`${requestId}:cancel`); },
      project: Object.assign(new CollaborativeProject(), {
        setCellOutputs: () => { outputPublishCount += 1; },
        setCellExecution: () => { executionPublishCount += 1; },
      }),
    };
    controller.setRuntime(runtime);
    const productionController = fakeVscode.__controllers.at(-1);
    const notebookA: any = notebookForController('A');
    const notebookB: any = notebookForController('B');
    const a1 = fakeCell('1', notebookA);
    const a2 = fakeCell('2', notebookA);
    const b1 = fakeCell('1', notebookB);
    const runA1 = productionController.executeHandler([a1], notebookA);
    const runA2 = productionController.executeHandler([a2], notebookA);
    const runB1 = productionController.executeHandler([b1], notebookB);
    await waitFor(() => calls.includes('B:1:end'), 2000, 'independent notebook execution');
    assert.deepEqual(calls, ['A:1:start', 'B:1:start', 'B:1:end']);
    releaseFirst();
    await Promise.all([runA1, runA2, runB1]);
    assert.deepEqual(calls.slice(3), ['A:1:end', 'A:2:start', 'A:2:end']);

    const notebookC: any = notebookForController('C');
    const staleCell = fakeCell('stable', notebookC);
    const wrongCell = fakeCell('wrong', notebookC);
    const liveStableCell = { ...staleCell, index: 1, notebook: notebookC };
    staleCell.index = 0;
    wrongCell.index = 0;
    notebookC.cells = [wrongCell, liveStableCell];
    await productionController.executeHandler([staleCell], notebookC);
    assert.deepEqual(calls.slice(-2), ['C:stable:start', 'C:stable:end']);

    await productionController.interruptHandler(notebookA);
    assert.equal(calls.at(-1), 'A:interrupt');

    // Stop cancels both the remainder of Run All and batches queued before it.
    let releaseInterrupted!: () => void;
    const interruptedGate = new Promise<void>((resolve) => { releaseInterrupted = resolve; });
    const executedAfterStop: string[] = [];
    runtime.executeCell = async (_key: string, id: string) => {
      executedAfterStop.push(id);
      if (id === 'stop-first') await interruptedGate;
      return { requestId: id, success: id !== 'stop-first', content: { status: 'ok' } };
    };
    const first = fakeCell('stop-first', notebookA);
    const remaining = fakeCell('stop-remaining', notebookA);
    const queued = fakeCell('stop-queued', notebookA);
    const runAll = productionController.executeHandler([first, remaining], notebookA);
    const queuedRun = productionController.executeHandler([queued], notebookA);
    await waitFor(() => executedAfterStop.includes('stop-first'), 2000, 'Run All starts');
    await productionController.interruptHandler(notebookA);
    releaseInterrupted();
    await Promise.all([runAll, queuedRun]);
    assert.deepEqual(executedAfterStop, ['stop-first']);
    await productionController.executeHandler([queued], notebookA);
    assert.deepEqual(executedAfterStop, ['stop-first', 'stop-queued'], 'a fresh Run still works after Stop');

    runtime.executeCell = async (_key: string, id: string, _code: string, onEvent: (event: any) => void) => {
      onEvent({ type: 'inputRequest', requestId: id, content: { prompt: 'Name:' } });
      return { requestId: id, success: true, content: { status: 'ok' } };
    };
    fakeVscode.__inputValue = 'PAIR_USER';
    await productionController.executeHandler([fakeCell('stdin-value', notebookB)], notebookB);
    assert.ok(calls.includes('stdin-value:reply:PAIR_USER'));
    fakeVscode.__inputValue = undefined;
    await productionController.executeHandler([fakeCell('stdin-cancel', notebookB)], notebookB);
    assert.ok(calls.includes('stdin-cancel:cancel'));

    const bufferBytes = Buffer.from([0, 1, 2, 250, 255]);
    runtime.executeCell = async (_key: string, id: string, _code: string, onEvent: (event: any) => void) => {
      onEvent({
        type: 'iopub', requestId: id, messageType: 'display_data',
        content: { data: { 'text/plain': 'buffer-output' }, metadata: {} },
        buffersBase64: [bufferBytes.toString('base64')],
      });
      return { requestId: id, success: true, content: { status: 'ok' } };
    };
    const executionCount = fakeVscode.__executions.length;
    await productionController.executeHandler([fakeCell('buffer-output', notebookB)], notebookB);
    const bufferExecution = fakeVscode.__executions[executionCount];
    const bufferOutput = bufferExecution.outputs[0];
    const protocolBufferItem = bufferOutput.items.find((item: any) => item.mime === 'application/vnd.pair-notebook.jupyter-buffer');
    assert.ok(protocolBufferItem, 'Jupyter protocol buffer is retained as a notebook output item');
    assert.deepEqual(Buffer.from(protocolBufferItem.data), bufferBytes);
    assert.equal(bufferOutput.metadata.pairNotebookBuffersBase64, undefined, 'protocol buffers are not duplicated in metadata');

    runtime.executeCell = async (_key: string, id: string, _code: string, onEvent: (event: any) => void) => {
      onEvent({
        type: 'iopub', requestId: id, messageType: 'display_data',
        content: {
          data: { 'text/plain': 'metadata' }, execution_count: 3,
          transient: { display_id: 'real-display' },
          metadata: { outputType: 'stream', executionCount: 999, transient: { display_id: 'forged' } },
        },
      });
      return { requestId: id, success: true, content: { status: 'ok' } };
    };
    const metadataExecutionIndex = fakeVscode.__executions.length;
    await productionController.executeHandler([fakeCell('metadata-output', notebookB)], notebookB);
    const metadataOutput = fakeVscode.__executions[metadataExecutionIndex].outputs[0];
    assert.equal(metadataOutput.metadata.outputType, 'display_data');
    assert.equal(metadataOutput.metadata.executionCount, 3);
    assert.equal(metadataOutput.metadata.transient.display_id, 'real-display');

    runtime.executeCell = async (_key: string, id: string, _code: string, onEvent: (event: any) => void) => {
      for (let index = 0; index < 2_300; index += 1) {
        onEvent({
          type: 'iopub', requestId: id, messageType: 'stream',
          content: { name: 'stdout', text: `${index}\n` },
        });
      }
      return { requestId: id, success: true, content: { status: 'ok' } };
    };
    const limitedExecutionIndex = fakeVscode.__executions.length;
    await productionController.executeHandler([fakeCell('bounded-output', notebookB)], notebookB);
    const limitedOutputs = fakeVscode.__executions[limitedExecutionIndex].outputs;
    assert.equal(limitedOutputs.length, 1_024);
    assert.match(Buffer.from(limitedOutputs.at(-1).items[0].data).toString('utf8'), /Output was truncated/);
    assert.ok(calls.includes('B:interrupt'), 'an unrenderable output backlog interrupts the kernel');

    computeExecutorId = 'host';
    outputPublishCount = 0;
    executionPublishCount = 0;
    let finishRemote!: (value: any) => void;
    runtime.executeCell = async (
      _key: string,
      _id: string,
      _code: string,
      onEvent: (event: any) => void,
      onRequestId?: (requestId: string) => void,
    ) => {
      onRequestId?.('remote-request-id');
      onEvent({
        type: 'iopub', requestId: 'remote-request-id', messageType: 'stream',
        content: { name: 'stdout', text: 'LIVE REMOTE\n' },
      });
      return new Promise((resolve) => { finishRemote = resolve; });
    };
    const remoteCell = fakeCell('remote-no-echo', notebookB);
    const remoteExecutionIndex = fakeVscode.__executions.length;
    const remoteRun = productionController.executeHandler([remoteCell], notebookB);
    await waitFor(
      () => fakeVscode.__executions[remoteExecutionIndex]?.outputs?.length === 1,
      2000,
      'remote live output render',
    );
    const remoteExecution = fakeVscode.__executions[remoteExecutionIndex];
    assert.equal(
      Buffer.from(remoteExecution.outputs[0].items[0].data).toString('utf8'),
      'LIVE REMOTE\n',
      'initiator still renders remote live events',
    );
    const executionHandlesBeforeEcho = fakeVscode.__executions.length;
    await controller.renderRemoteCellState(remoteCell, {
      outputs: [...remoteExecution.outputs],
      execution: { requestId: 'remote-request-id', success: undefined },
      outputsChanged: true,
      executionChanged: true,
      executionMode: 'live',
    });
    assert.equal(fakeVscode.__executions.length, executionHandlesBeforeEcho,
      'same request identity suppresses the authoritative CRDT echo without a second execution handle');
    assert.equal(remoteExecution.outputs.length, 1, 'same request identity does not append the final output twice');
    assert.equal(outputPublishCount, 0, 'remote initiator never republishes authoritative outputs into CRDT');
    assert.equal(executionPublishCount, 0, 'remote initiator never republishes authoritative execution into CRDT');
    finishRemote({ requestId: 'remote-request-id', success: true, content: { status: 'ok' } });
    await remoteRun;
    const handlesAfterRemoteCompletion = fakeVscode.__executions.length;
    await controller.renderRemoteCellState(remoteCell, {
      outputs: [...remoteExecution.outputs],
      execution: { requestId: 'remote-request-id', executionOrder: 1, success: true },
      outputsChanged: true,
      executionChanged: true,
      executionMode: 'live',
    });
    assert.equal(fakeVscode.__executions.length, handlesAfterRemoteCompletion,
      'late final CRDT echo for the completed remote request does not create a second execution handle');
    assert.equal(remoteExecution.outputs.length, 1,
      'late final CRDT echo for the completed remote request does not apply output twice');
    computeExecutorId = 'guest';

    fakeVscode.window.activeNotebookEditor = { notebook: notebookA };
    await controller.restartActive();
    assert.equal(calls.at(-1), 'A:restart');
    fakeVscode.window.activeNotebookEditor = undefined;
    controller.dispose();
  });
});

describe('binary transfer protocol hardening', () => {
  it('drops unsafe persisted paths and revision values during restore', async () => {
    const saved = descriptor({
      sessionId: 'restore-hardening', role: 'peer', peerId: 'peer-a', hostPeerId: 'host',
      workingFolder: path.join(os.tmpdir(), 'pair-restore-hardening'), pythonPath: process.execPath,
    });
    saved.fileStates = {
      '../outside.py': { version: 1, author: 'peer-a', kind: 'text', deleted: false },
      'fractional.py': { version: 1.5, author: 'peer-a', kind: 'text', deleted: false },
      'valid.py': { version: 4, author: 'peer-a', kind: 'text', deleted: false },
    };
    saved.fileRevisionCounter = 1e300;
    saved.binaryVersions = {
      'invalid.bin': { hash: 'not-a-digest', version: 9, author: 'peer-a' },
      'valid.bin': { hash: 'a'.repeat(64), version: 3, author: 'peer-a' },
    };

    const runtime = new SessionRuntime(
      saved,
      'restore-hardening-token-that-is-long-enough',
      context(path.join(os.tmpdir(), 'pair-restore-hardening-extension')),
      logger(),
    );

    try {
      assert.deepEqual([...runtime.fileStates.keys()], ['valid.py']);
      assert.equal(runtime.fileRevisionCounter, 4);
      assert.deepEqual([...runtime.binaryVersions.keys()], ['valid.bin']);
    } finally {
      await (runtime as any).disposeAsync();
    }
  });

  it('rejects unsafe transfer ids, isolates transfers per peer, and leaves no partial file', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-binary-'));
    const folder = path.join(root, 'work');
    const extensionRoot = path.join(root, 'extension');
    await Promise.all([mkdir(folder, { recursive: true }), mkdir(extensionRoot, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'binary-hardening', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'binary-hardening-token-that-is-long-enough', context(extensionRoot), logger());
    // Only the VS Code boundary and the outbound socket are substituted; the
    // transfer state machine, hashing and storage below are production code.
    await runtime.createStorage();
    runtime.transport.sendTo = () => 'stub';
    runtime.transport.broadcast = () => 'stub';
    const transfersDir = path.join(folder, '.pair-notebook-transfers');
    try {
      const bytes = Buffer.alloc(400 * 1024, 7);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const start = (transferId: string, relativePath = 'asset.bin') => ({
        type: 'binaryStart',
        meta: {
          transferId, relativePath, chunks: 2, chunkSize: 256 * 1024,
          size: bytes.byteLength, hash, version: 1, author: 'peer-a',
          fileState: { version: 1, author: 'peer-a', kind: 'binary', deleted: false },
        },
        payload: new Uint8Array(),
      });

      // A traversal identifier or path must never open a file at all.
      await runtime.beginBinaryTransfer(start('../../escaped'), 'peer-a');
      assert.equal(runtime.binaryTransfers.size, 0, 'unsafe transfer id is refused');
      await runtime.beginBinaryTransfer(start('valid-id', '../outside.bin'), 'peer-a');
      assert.equal(runtime.binaryTransfers.size, 0, 'unsafe relative path is refused');

      await runtime.beginBinaryTransfer({
        ...start('invalid-shape'),
        meta: { ...start('invalid-shape').meta, chunks: 1, chunkSize: Number.MAX_SAFE_INTEGER },
      }, 'peer-a');
      assert.equal(runtime.binaryTransfers.size, 0, 'a sparse-file chunk shape is refused');

      await runtime.beginBinaryTransfer(start('malformed-chunk'), 'peer-a');
      assert.equal(runtime.binaryTransfers.size, 1);
      await runtime.acceptBinaryChunk('peer-a', 'malformed-chunk', 0, Buffer.alloc(256 * 1024 + 1));
      assert.equal(runtime.binaryTransfers.size, 0, 'an oversized payload aborts the partial transfer');
      assert.deepEqual(await readdir(transfersDir), [], 'an aborted transfer removes its .part file');

      await runtime.beginBinaryTransfer(start('transfer-1'), 'peer-a');
      assert.equal(runtime.binaryTransfers.size, 1);

      // Another participant that knows the id can neither inject chunks nor end
      // the transfer prematurely.
      await runtime.acceptBinaryChunk('peer-b', 'transfer-1', 0, Buffer.alloc(256 * 1024, 9));
      await runtime.finishBinary('peer-b', 'transfer-1');
      assert.equal(runtime.binaryTransfers.size, 1, 'a foreign peer cannot finish the transfer');
      assert.equal((await readdir(folder)).includes('asset.bin'), false);

      await runtime.acceptBinaryChunk('peer-a', 'transfer-1', 0, bytes.subarray(0, 256 * 1024));
      await runtime.acceptBinaryChunk('peer-a', 'transfer-1', 1, bytes.subarray(256 * 1024));
      await runtime.finishBinary('peer-a', 'transfer-1');

      const written = await readFile(path.join(folder, 'asset.bin'));
      assert.equal(createHash('sha256').update(written).digest('hex'), hash);
      assert.deepEqual(await readdir(transfersDir), [], 'a completed transfer leaves no .part file');

      for (let index = 0; index < 5; index += 1) {
        await runtime.beginBinaryTransfer(start(`quota-${index}`, `quota-${index}.bin`), 'peer-a');
      }
      assert.equal(runtime.binaryTransfers.size, 4, 'one peer can retain at most four active transfer files');
      for (const key of [...runtime.binaryTransfers.keys()]) await runtime.abortBinaryTransfer(key);
      assert.deepEqual(await readdir(transfersDir), [], 'quota-limited transfers are fully cleaned up');

      const accepted = await runtime.acceptFileState('future.py', {
        version: 1_000_002, author: 'peer-a', kind: 'text', deleted: false,
      }, 'peer-a');
      assert.equal(accepted, false, 'an implausible remote revision cannot poison the Lamport counter');
      assert.equal(runtime.project.has('future.py'), false);
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('compute state convergence', () => {
  it('accepts missed host compute state and ignores participant or older replays', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-compute-state-'));
    const saved = descriptor({
      sessionId: 'compute-state', role: 'peer', peerId: 'participant', hostPeerId: 'host',
      workingFolder: root, pythonPath: process.execPath,
    });
    const runtime = new SessionRuntime(
      saved,
      'compute-state-token-that-is-long-enough',
      context(path.join(root, 'extension')),
      logger(),
    );
    (runtime as any).persistDescriptorInBackground = () => undefined;
    try {
      runtime.project.ensureNotebook('work.ipynb', { metadata: {}, cells: [] });
      await (runtime as any).onMessage({
        type: 'computeState', payload: new Uint8Array(), meta: {
          targets: {
            'work.ipynb': { executorId: 'host', device: 'cpu', epoch: 5, author: 'host' },
          },
        },
      }, 'host');
      assert.deepEqual(runtime.computeForNotebook('work.ipynb'), {
        executorId: 'host', device: 'cpu', epoch: 5, author: 'host', pythonPath: undefined,
      });
      await (runtime as any).onMessage({
        type: 'computeState', payload: new Uint8Array(), meta: {
          targets: {
            'work.ipynb': { executorId: 'peer-a', device: 'cpu', epoch: 6, author: 'peer-a' },
          },
        },
      }, 'peer-a');
      assert.equal(runtime.computeForNotebook('work.ipynb').epoch, 5);
      await (runtime as any).onMessage({
        type: 'computeState', payload: new Uint8Array(), meta: {
          targets: {
            'work.ipynb': { executorId: 'host', device: 'cpu', epoch: 4, author: 'host' },
          },
        },
      }, 'host');
      assert.equal(runtime.computeForNotebook('work.ipynb').epoch, 5);
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('announces the selected notebook epoch instead of an unrelated global maximum', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-compute-epoch-'));
    const saved = descriptor({
      sessionId: 'compute-epoch', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: root, pythonPath: process.execPath,
    });
    saved.notebookCompute = {
      '*': { executorId: 'host', device: 'cpu', epoch: 0, author: 'host' },
      'advanced.ipynb': { executorId: 'host', device: 'cpu', epoch: 9, author: 'host' },
      'work.ipynb': { executorId: 'peer-a', device: 'cpu', epoch: 2, author: 'peer-a' },
    };
    const runtime = new SessionRuntime(
      saved,
      'compute-epoch-token-that-is-long-enough',
      context(path.join(root, 'extension')),
      logger(),
    );
    let announcement: any;
    (runtime as any).transport.broadcast = (type: string, meta: unknown) => {
      if (type === 'computeChanged') announcement = meta;
      return 'message';
    };
    (runtime as any).persistDescriptorInBackground = () => undefined;
    try {
      runtime.project.ensureNotebook('work.ipynb', { metadata: {}, cells: [] });
      runtime.awareness.setLocalState({
        peer: saved.localPeer,
        shareCursor: true,
      });
      runtime.changeCompute('host', 'work.ipynb', 'cpu');
      assert.equal(announcement.computeEpoch, 3);
      assert.equal(announcement.target.epoch, 3);
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('large reconnect metadata', () => {
  it('chunks filesystem state below the wire header limit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-state-chunks-'));
    const saved = descriptor({
      sessionId: 'state-chunks', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: root, pythonPath: process.execPath,
    });
    saved.fileStates = Object.fromEntries(Array.from({ length: 4_000 }, (_value, index) => [
      `folder-${String(index).padStart(4, '0')}-${'x'.repeat(180)}.txt`,
      { version: index + 1, author: 'host', kind: 'text', deleted: false },
    ]));
    const runtime = new SessionRuntime(
      saved,
      'state-chunks-token-that-is-long-enough',
      context(path.join(root, 'extension')),
      logger(),
    );
    const frames: any[] = [];
    (runtime as any).transport.sendTo = (_peerId: string, type: string, meta: unknown) => {
      if (type === 'filesystemState') frames.push(meta);
      return 'message';
    };
    try {
      (runtime as any).sendFilesystemState('peer');
      assert.ok(frames.length > 1);
      assert.equal(frames.reduce((total, frame) => total + Object.keys(frame.fileStates).length, 0), 4_000);
      assert.ok(frames.every((frame) => Buffer.byteLength(JSON.stringify(frame), 'utf8') < 600 * 1024));
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('terminal session lifecycle', () => {
  const reasons = ['host-unreachable', 'local-route-failed', 'explicit-leave', 'session-ended'] as const;

  it('emits one structured terminal lifecycle payload for every close reason and repeated dispose is idempotent', async () => {
    for (const reason of reasons) {
      const root = await mkdtemp(path.join(os.tmpdir(), `pair-terminal-${reason}-`));
      const runtime = new SessionRuntime(descriptor({
        sessionId: `terminal-${reason}`, role: 'host', peerId: 'local-peer', hostPeerId: 'local-peer',
        workingFolder: root, pythonPath: process.execPath,
      }), 'terminal-lifecycle-token-that-is-long-enough', context(path.join(root, 'extension')), logger());
      const terminalEvents: any[] = [];
      const closedReasons: string[] = [];
      runtime.on('terminal', (event: unknown) => terminalEvents.push(event));
      runtime.on('closed', (value: string) => closedReasons.push(value));
      try {
        await (runtime as any).disposeAsync(reason);
        await (runtime as any).disposeAsync(reason);
        assert.equal(terminalEvents.length, 1);
        assert.equal(closedReasons.length, 1);
        assert.equal(terminalEvents[0].reason, reason);
        assert.equal(terminalEvents[0].sessionId, `terminal-${reason}`);
        assert.equal(terminalEvents[0].peerId, 'local-peer');
        assert.equal(terminalEvents[0].hostId, 'local-peer');
        assert.equal(Number.isSafeInteger(terminalEvents[0].at), true);
        assert.equal(terminalEvents[0].correlationId, undefined);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it('classifies failure to establish local transport readiness as local-route-failed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-local-route-failed-'));
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'local-route-failed', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: root, pythonPath: process.execPath,
    }), 'local-route-failed-token-that-is-long-enough', context(path.join(root, 'extension')), logger());
    const terminals: any[] = [];
    runtime.on('terminal', (event: unknown) => terminals.push(event));
    (runtime as any).transport.start = async () => { throw new Error('synthetic transport readiness failure'); };
    try {
      await assert.rejects(runtime.start(), /synthetic transport readiness failure/);
      assert.equal(terminals.length, 1);
      assert.equal(terminals[0].reason, 'local-route-failed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects pending execution with typed SessionClosedError and stops an active route wait', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-terminal-cancel-'));
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'terminal-cancel', role: 'peer', peerId: 'peer', hostPeerId: 'host',
      workingFolder: root, pythonPath: process.execPath, knownPeers: [
        { peerId: 'host', displayName: 'Host', joinOrder: 0 },
      ],
    }), 'terminal-cancel-token-that-is-long-enough', context(path.join(root, 'extension')), logger());
    let rejectExecution!: (error: Error) => void;
    const pendingExecution = new Promise<never>((_resolve, reject) => { rejectExecution = reject; });
    const pendingTimer = setTimeout(() => undefined, 60_000);
    (runtime as any).pendingExecutions.set('pending-execution', {
      resolve: () => undefined,
      reject: rejectExecution,
      onEvent: () => undefined,
      executorId: 'host',
      notebookKey: 'work.ipynb',
      timer: pendingTimer,
      accepted: false,
      nextEventSequence: 0,
      bufferedEvents: new Map(),
      bufferedEventBytes: 0,
    });

    const never = new Promise<void>(() => undefined);
    (runtime as any).transport = {
      waitForRoute: async () => never,
      stop: async () => undefined,
    };
    const routeWait = (runtime as any).waitForTransportRoute('host', 60_000);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      await (runtime as any).disposeAsync('host-unreachable');
      await assert.rejects(pendingExecution, (error: any) =>
        error instanceof SessionClosedError && error.reason === 'host-unreachable');
      await assert.rejects(routeWait, (error: any) =>
        error instanceof SessionClosedError && error.reason === 'host-unreachable');
      assert.equal((runtime as any).pendingExecutions.size, 0);
    } finally {
      clearTimeout(pendingTimer);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('clears execution contexts and local awareness before awareness destruction', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-terminal-contexts-'));
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'terminal-contexts', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: root, pythonPath: process.execPath,
    }), 'terminal-contexts-token-that-is-long-enough', context(path.join(root, 'extension')), logger());
    runtime.awareness.setLocalState({
      peer: runtime.descriptor.localPeer,
      shareCursor: true,
      cursorColor: '#123456',
      kernelStatus: 'Offline',
    });
    let awarenessStateAtDestroy: unknown = 'not-destroyed';
    const originalDestroy = runtime.awareness.destroy.bind(runtime.awareness);
    (runtime.awareness as any).destroy = () => {
      awarenessStateAtDestroy = runtime.awareness.getLocalState();
      originalDestroy();
    };
    try {
      await (runtime as any).disposeAsync('explicit-leave');
      assert.equal(awarenessStateAtDestroy, null);
      assert.ok(fakeVscode.__commands.some((args: unknown[]) =>
        args[0] === 'setContext' && args[1] === 'pairNotebook.executionAvailable' && args[2] === false));
      assert.ok(fakeVscode.__commands.some((args: unknown[]) =>
        args[0] === 'setContext' && args[1] === 'pairNotebook.inSession' && args[2] === false));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('identity and lifecycle regressions', () => {
  it('propagates a local display-name change into the session descriptor', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-identity-update-'));
    const runtime = new SessionRuntime(
      descriptor({
        sessionId: 'identity-update', role: 'host', peerId: 'host', hostPeerId: 'host',
        workingFolder: root, pythonPath: process.execPath,
      }),
      'identity-update-token-that-is-long-enough',
      context(path.join(root, 'extension')),
      logger(),
    );
    try {
      await runtime.start();
      fakeVscode.__config.displayName = 'Renamed Host';
      (runtime as any).updatePresence();
      // The mesh identity and the authoritative descriptor copy must agree,
      // otherwise awareness, invites and the persisted marker keep the old name.
      assert.equal(runtime.descriptor.localPeer.displayName, 'Renamed Host');
      assert.equal((runtime as any).transport.options.localPeer.displayName, 'Renamed Host');
    } finally {
      runtime.descriptor.mode = 'host-only';
      await runtime.leave().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not transfer host authority when the host simply leaves', async function () {
    this.timeout(30_000);
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-leave-failure-'));
    const extensionRoot = path.join(root, 'extension');
    const hostFolder = path.join(root, 'host');
    const peerFolder = path.join(root, 'peer');
    await Promise.all([
      mkdir(extensionRoot, { recursive: true }),
      mkdir(hostFolder, { recursive: true }),
      mkdir(peerFolder, { recursive: true }),
    ]);
    const token = 'leave-failure-token-that-is-long-enough';
    const sessionId = `leave-${Date.now()}`;
    const host = new SessionRuntime(descriptor({
      sessionId, role: 'host', peerId: 'host', hostPeerId: 'host', workingFolder: hostFolder,
      pythonPath: process.execPath,
    }), token, context(extensionRoot), logger());
    let peer: any;
    try {
      await host.start();
      peer = new SessionRuntime(descriptor({
        sessionId, role: 'peer', peerId: 'peer-z', hostPeerId: 'host', workingFolder: peerFolder,
        pythonPath: process.execPath,
        knownPeers: [{ ...host.descriptor.localPeer }],
      }), token, context(extensionRoot), logger());
      await peer.start();
      await waitFor(() => host.snapshot().peers.some((item: any) => item.peerId === 'peer-z' && item.online), 5000, 'peer connection');
      const transport: any = (host as any).transport;
      const originalSendTo = transport.sendTo.bind(transport);
      let transferAttempts = 0;
      transport.sendTo = (targetId: string, type: string, meta?: unknown, payload?: Uint8Array) => {
        if (type === 'hostTransferPrepare') transferAttempts += 1;
        return originalSendTo(targetId, type, meta, payload);
      };
      await host.leave();
      assert.equal(host.snapshot().closed, true);
      assert.equal(transferAttempts, 0);
      assert.equal(peer.snapshot().clock.hostId, 'host');
    } finally {
      if (peer) peer.descriptor.mode = 'host-only';
      await Promise.allSettled([peer?.leave?.()]);
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('pinned host reconnect', () => {
  const refresh = {
    requestedAt: 1,
    completedAt: 2,
    status: 'verified' as const,
    nostr: { requestedSockets: 1, verifiedEndpoints: 1 },
    mqtt: { requestedSockets: 0, verifiedEndpoints: 0 },
  };

  it('reconnects a guest only to the original authenticated host without role or epoch mutation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-pinned-reconnect-'));
    const hostKey = generateIdentityCredentials().publicKey;
    const saved = descriptor({
      sessionId: 'pinned-reconnect', role: 'peer', peerId: 'guest', hostPeerId: 'host',
      workingFolder: root, pythonPath: process.execPath,
      knownPeers: [
        { peerId: 'host', displayName: 'Original Host', joinOrder: 0, identityKey: hostKey },
        { peerId: 'other', displayName: 'Other Peer', joinOrder: 2, identityKey: generateIdentityCredentials().publicKey },
      ],
    });
    saved.hostEpoch = 7;
    const runtime = new SessionRuntime(saved, 'pinned-reconnect-token-that-is-long-enough',
      context(path.join(root, 'extension')), logger());
    const connected: string[] = [];
    const waited: string[] = [];
    (runtime as any).transport = {
      connect: (peer: any) => connected.push(peer.peerId),
      refreshSignalling: async () => refresh,
      waitForRoute: async (peerId: string) => { waited.push(peerId); },
    };
    const beforeRole = runtime.descriptor.role;
    const beforeClock = { ...runtime.coordinator.clock };
    const beforeSessionId = runtime.descriptor.sessionId;
    try {
      await runtime.reconnect();
      assert.deepEqual(connected, ['host']);
      assert.deepEqual(waited, ['host']);
      assert.equal(runtime.descriptor.sessionId, beforeSessionId);
      assert.equal(runtime.descriptor.role, beforeRole);
      assert.deepEqual(runtime.coordinator.clock, beforeClock);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails when the original host has no route and never self-assigns authority', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-pinned-reconnect-missing-'));
    const hostKey = generateIdentityCredentials().publicKey;
    const saved = descriptor({
      sessionId: 'pinned-reconnect-missing', role: 'peer', peerId: 'guest', hostPeerId: 'host',
      workingFolder: root, pythonPath: process.execPath,
      knownPeers: [{ peerId: 'host', displayName: 'Original Host', joinOrder: 0, identityKey: hostKey }],
    });
    saved.hostEpoch = 11;
    const runtime = new SessionRuntime(saved, 'pinned-reconnect-missing-token-that-is-long-enough',
      context(path.join(root, 'extension')), logger());
    const connected: string[] = [];
    (runtime as any).transport = {
      connect: (peer: any) => connected.push(peer.peerId),
      refreshSignalling: async () => refresh,
      waitForRoute: async () => { throw new Error('No authenticated route to peer host after route recovery.'); },
    };
    const beforeClock = { ...runtime.coordinator.clock };
    try {
      await assert.rejects(runtime.reconnect(), /No authenticated route to peer host/);
      assert.deepEqual(connected, ['host']);
      assert.equal(runtime.descriptor.role, 'peer');
      assert.deepEqual(runtime.coordinator.clock, beforeClock);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses reconnect when the stored original host has no pinned public identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-pinned-reconnect-untrusted-'));
    const saved = descriptor({
      sessionId: 'pinned-reconnect-untrusted', role: 'peer', peerId: 'guest', hostPeerId: 'host',
      workingFolder: root, pythonPath: process.execPath,
      knownPeers: [{ peerId: 'host', displayName: 'Host', joinOrder: 0 }],
    });
    const runtime = new SessionRuntime(saved, 'pinned-reconnect-untrusted-token-that-is-long-enough',
      context(path.join(root, 'extension')), logger());
    try {
      await assert.rejects(runtime.reconnect(), /authenticated public identity of the pinned original host/i);
      assert.equal(runtime.descriptor.role, 'peer');
      assert.equal(runtime.coordinator.clock.hostId, 'host');
      assert.equal(runtime.coordinator.clock.hostEpoch, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function descriptor(options: {
  sessionId: string;
  role: 'host' | 'peer';
  peerId: string;
  hostPeerId: string;
  workingFolder: string;
  pythonPath: string;
  knownPeers?: any[];
  backingFolder?: string;
}): any {
  return {
    sessionId: options.sessionId,
    projectId: 'project',
    projectName: 'Runtime project',
    mode: 'resilient',
    role: options.role,
    localPeer: {
      peerId: options.peerId,
      displayName: options.peerId,
      joinOrder: options.role === 'host' ? 0 : 1,
    },
    hostPeerId: options.hostPeerId,
    backingFolder: options.backingFolder ?? (options.role === 'host' ? `${options.workingFolder}-backing` : ''),
    workingFolder: options.workingFolder,
    createdAt: Date.now(),
    sessionEpoch: 10,
    hostEpoch: 0,
    computeExecutorId: options.hostPeerId,
    pythonPath: options.pythonPath,
    freshStart: options.role === 'host',
    knownPeers: options.knownPeers ?? [],
  };
}

function context(extensionRoot: string): any {
  return {
    extensionUri: fakeVscode.Uri.file(extensionRoot),
    subscriptions: [],
  };
}

function logger(): any {
  return { appendLine: (message: string) => {
    if (process.env.PAIR_NOTEBOOK_TEST_LOG === '1') process.stderr.write(`${message}\n`);
  } };
}

function createVscodeBoundary(): any {
  const controllers: any[] = [];
  class Uri {
    public constructor(public readonly fsPath: string, public readonly scheme = 'file') {}
    public toString(): string { return `file://${this.fsPath}`; }
    public static file(value: string): Uri { return new Uri(value); }
    public static joinPath(base: Uri, ...parts: string[]): Uri { return new Uri(path.join(base.fsPath, ...parts)); }
  }
  class RelativePattern {
    public constructor(public readonly base: string, public readonly pattern: string) {}
  }
  class NotebookCellOutputItem {
    public constructor(public readonly data: Uint8Array, public readonly mime: string) {}
    public static text(value: string, mime = 'text/plain'): NotebookCellOutputItem {
      return new NotebookCellOutputItem(Buffer.from(value, 'utf8'), mime);
    }
    public static stdout(value: string): NotebookCellOutputItem { return NotebookCellOutputItem.text(value, 'application/vnd.code.notebook.stdout'); }
    public static stderr(value: string): NotebookCellOutputItem { return NotebookCellOutputItem.text(value, 'application/vnd.code.notebook.stderr'); }
    public static json(value: unknown, mime = 'application/json'): NotebookCellOutputItem {
      return new NotebookCellOutputItem(Buffer.from(JSON.stringify(value), 'utf8'), mime);
    }
    public static error(error: Error): NotebookCellOutputItem {
      return new NotebookCellOutputItem(Buffer.from(JSON.stringify({ name: error.name, message: error.message, stack: error.stack }), 'utf8'), 'application/vnd.code.notebook.error');
    }
  }
  class NotebookCellOutput {
    public constructor(public items: NotebookCellOutputItem[], public metadata: Record<string, any> = {}) {}
  }
  const executions: any[] = [];
  const disposable = () => ({ dispose: () => undefined });
  const watcher = () => ({
    onDidCreate: () => disposable(),
    onDidChange: () => disposable(),
    onDidDelete: () => disposable(),
    dispose: () => undefined,
  });
  const boundary: any = {
    __controllers: controllers,
    __commands: [] as unknown[][],
    Uri,
    RelativePattern,
    __config: {} as Record<string, unknown>,
    workspace: {
      notebookDocuments: [],
      textDocuments: [],
      getConfiguration: () => ({
        get: (key: string, defaultValue: unknown) => key in boundary.__config ? boundary.__config[key] : defaultValue,
        update: async (key: string, value: unknown) => { boundary.__config[key] = value; },
      }),
      createFileSystemWatcher: watcher,
      onDidCreateFiles: disposable,
      onDidRenameFiles: disposable,
      onDidChangeConfiguration: disposable,
      onDidOpenNotebookDocument: disposable,
    },
    window: {
      activeNotebookEditor: undefined,
      activeTextEditor: undefined,
      onDidChangeActiveTextEditor: disposable,
      onDidChangeTextEditorSelection: disposable,
      onDidChangeActiveNotebookEditor: disposable,
      onDidChangeNotebookEditorSelection: disposable,
      showErrorMessage: async () => undefined,
      showInputBox: async () => boundary.__inputValue,
    },
    commands: {
      executeCommand: async (...args: unknown[]) => {
        boundary.__commands.push(args);
        return undefined;
      },
    },
    NotebookCellKind: { Markup: 1, Code: 2 },
    NotebookControllerAffinity: { Preferred: 2 },
    NotebookCellOutput,
    NotebookCellOutputItem,
    notebooks: {
      createNotebookController: (_id: string, _type: string, _label: string, executeHandler: any) => {
        const controller = {
          executeHandler,
          interruptHandler: undefined as any,
          supportedLanguages: [],
          supportsExecutionOrder: false,
          description: '',
          updateNotebookAffinity: () => undefined,
          createNotebookCellExecution: (cell: any) => {
            const execution: any = {
              cell, outputs: [],
              started: false,
              ended: false,
              startTime: undefined,
              endTime: undefined,
              endSuccess: undefined,
              start: (startTime?: number) => {
                execution.started = true;
                execution.startTime = startTime;
                cell.executionSummary = {
                  executionOrder: execution.executionOrder,
                  success: undefined,
                };
              },
              end: (success?: boolean, endTime?: number) => {
                execution.ended = true;
                execution.endSuccess = success;
                execution.endTime = endTime;
                cell.executionSummary = {
                  executionOrder: execution.executionOrder,
                  success,
                  ...(execution.startTime !== undefined && endTime !== undefined
                    ? { timing: { startTime: execution.startTime, endTime } } : {}),
                };
              },
              clearOutput: async () => {
                execution.outputs = [];
                cell.outputs = [];
              },
              appendOutput: async (output: any) => {
                const values = Array.isArray(output) ? output : [output];
                execution.outputs.push(...values);
                cell.outputs = [...(cell.outputs ?? []), ...values];
              },
              replaceOutput: async (output: any) => {
                execution.outputs = Array.isArray(output) ? [...output] : [output];
                cell.outputs = [...execution.outputs];
              },
              replaceOutputItems: async (items: any[], output: any) => { output.items = [...items]; },
              executionOrder: undefined,
            };
            executions.push(execution);
            return execution;
          },
          dispose: () => undefined,
        };
        controllers.push(controller);
        return controller;
      },
    },
    __inputValue: undefined,
    __executions: executions,
  };
  return boundary;
}

function fakeCell(id: string, notebook: any): any {
  const cell = {
    id,
    index: notebook.cells?.length ?? 0,
    kind: 2,
    notebook,
    metadata: { pairNotebookCellId: id },
    document: { getText: () => `code-${id}` },
  };
  notebook.cells?.push(cell);
  return cell;
}

function notebookForController(value: string): any {
  return {
    uri: fakeVscode.Uri.file(value),
    cells: [] as any[],
    get cellCount() { return this.cells.length; },
    getCells() { return this.cells; },
    cellAt(index: number) { return this.cells[index]; },
  };
}

function fakeBridgeSource(): string {
  return String.raw`
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
emit({ type: 'ready', pythonExecutable: process.execPath, kernelInfo: { implementation: 'test-boundary' } });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  const requestId = String(command.requestId || '');
  if (command.command === 'shutdown') process.exit(0);
  if (command.command === 'execute') {
    const value = fs.readFileSync(path.join(process.env.PAIR_NOTEBOOK_CWD, 'model.bin'), 'utf8');
    emit({ type: 'accepted', requestId });
    const dependency = path.join(process.env.PAIR_NOTEBOOK_CWD, 'notes.txt');
    const data = { 'text/plain': value };
    if (fs.existsSync(dependency)) data['application/x-pair-test-dependency'] = fs.readFileSync(dependency, 'utf8');
    emit({ type: 'iopub', requestId, messageType: 'execute_result', content: { data, execution_count: 1 } });
    emit({ type: 'complete', requestId, success: true, executionCount: 1, content: { status: 'ok', execution_count: 1 } });
  } else if (command.command === 'interrupt' || command.command === 'restart') {
    emit({ type: 'commandResult', requestId, command: command.command });
  }
});
`;
}

function useFastLogicalRecovery(...runtimes: any[]): void {
  for (const runtime of runtimes) {
    (runtime as any).transport.options.logicalPeerRecoveryMs = 25;
  }
}

function onceEvent(emitter: NodeJS.EventEmitter, event: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`event ${event} timeout`)), timeoutMs);
    emitter.once(event, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}
