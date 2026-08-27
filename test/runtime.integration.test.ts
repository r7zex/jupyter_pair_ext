import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { downloadProjectSnapshot } from '../src/runtime/bootstrap';
import { MeshTransport } from '../src/runtime/mesh';
import { encodeFrame } from '../src/core/wire';
import {
  createInMemoryTrysteroFactory,
  healInMemoryTrystero,
  partitionInMemoryTrystero,
  resetInMemoryTrystero,
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
const { SessionRuntime } = require('../src/runtime/session') as { SessionRuntime: new (...args: any[]) => any };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PairNotebookController, decodeJupyterBase64 } = require('../src/vscode/jupyterController') as {
  PairNotebookController: new (...args: any[]) => any;
  decodeJupyterBase64: (value: unknown) => Buffer | undefined;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { REMOTE_ORIGIN } = require('../src/core/types') as { REMOTE_ORIGIN: symbol };
moduleWithLoader._load = originalLoad;

const runtimeRoomFactory = createInMemoryTrysteroFactory();

beforeEach(() => {
  resetInMemoryTrystero();
  MeshTransport.setRoomFactoryForTesting(runtimeRoomFactory);
});

afterEach(() => {
  MeshTransport.setRoomFactoryForTesting(undefined);
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
    this.timeout(15_000);
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

  it('converges through Trystero/Yjs, recovers offline changes, and enforces the file barrier', async function () {
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
      await waitFor(() => host.snapshot().awareness.some((state: any) =>
        state.peer.peerId === 'peer-z' && state.activeNotebookCell === 0 && state.activeNotebookCellId === 'b'), 3000, 'cursor after cell move');
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

      assert.throws(() => host.changeCompute('peer-z', 'work.ipynb', 'cpu'), /not available for remote compute/);
      fakeVscode.__config.allowRemoteCompute = true;
      fakeVscode.__config.allowCpu = true;
      peer.updatePresence();
      await waitFor(() => host.snapshot().awareness.some((state: any) =>
        state.peer.peerId === 'peer-z' && state.allowRemoteCompute && state.allowCpu), 3000, 'explicit remote compute opt-in');
      assert.throws(() => host.changeCompute('peer-z', 'work.ipynb', 'cpu', process.execPath), /cannot start a Jupyter kernel/);
      host.changeCompute('peer-z', 'work.ipynb', 'cpu');
      await waitFor(() => peer.computeForNotebook('work.ipynb').executorId === 'peer-z', 3000, 'compute selection propagation');

      // Seed stale executor-only state without broadcasting it. The execution
      // barrier must refuse the mismatch without treating absence as permission
      // to delete files from the executor.
      peer.project.ensureText('stale-only.py', 'STALE', REMOTE_ORIGIN);
      await writeFile(path.join(peerFolder, 'stale-only.py'), 'STALE', 'utf8');
      const staleBinary = Buffer.from('STALE_BINARY');
      const staleBinaryHash = createHash('sha256').update(staleBinary).digest('hex');
      (peer as any).binaryVersions.set('stale-only.bin', { hash: staleBinaryHash, version: 99, author: 'peer-z' });
      await writeFile(path.join(peerFolder, 'stale-only.bin'), staleBinary);
      (peer as any).directories.add('stale-dir');
      await mkdir(path.join(peerFolder, 'stale-dir'));

      let binaryAcks = 0;
      host.on('binaryAck', () => { binaryAcks += 1; });
      const events: any[] = [];
      await assert.rejects(
        host.executeCell('work.ipynb', 'a', 'read model', (event: any) => events.push(event)),
        /missing local project entries|normal project synchronization/i,
      );
      assert.equal(peer.project.has('stale-only.py'), true, 'barrier refusal preserves executor document state');
      assert.equal(await fileExists(path.join(peerFolder, 'stale-only.py')), true, 'barrier refusal preserves executor document bytes');
      assert.equal((peer as any).binaryVersions.has('stale-only.bin'), true, 'barrier refusal preserves executor binary state');
      assert.equal(await fileExists(path.join(peerFolder, 'stale-only.bin')), true, 'barrier refusal preserves executor binary bytes');
      assert.equal((peer as any).directories.has('stale-dir'), true, 'barrier refusal preserves executor directory state');
      assert.equal(await directoryExists(path.join(peerFolder, 'stale-dir')), true, 'barrier refusal preserves executor directory bytes');

      await (peer as any).applyLocalDeletion('stale-only.py');
      await (peer as any).applyLocalDeletion('stale-only.bin');
      await (peer as any).applyLocalDeletion('stale-dir');
      const first = await host.executeCell('work.ipynb', 'a', 'read model', (event: any) => events.push(event));
      assert.equal(first.success, true);
      assert.equal(await readFile(path.join(peerFolder, 'model.bin'), 'utf8'), 'NEW_MODEL');
      assert.ok(events.some((event) => event.messageType === 'execute_result'
        && event.content?.data?.['text/plain'] === 'NEW_MODEL'));
      const ackCountAfterFirstExecution = binaryAcks;
      await host.executeCell('work.ipynb', 'a', 'read model again', () => undefined);
      assert.equal(binaryAcks, ackCountAfterFirstExecution, 'an acknowledged unchanged binary must not be resent');

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

      await waitFor(() => fileExists(path.join(peerFolder, 'notes.txt')), 3000, 'peer receives notes before disconnect');
      useFastLogicalRecovery(host, peer);
      const hostDisconnected = onceEvent(host, 'peerDisconnected');
      const peerDisconnected = onceEvent(peer, 'peerDisconnected');
      partitionInMemoryTrystero();
      await Promise.all([hostDisconnected, peerDisconnected]);
      await waitFor(() => !host.snapshot().awareness.some((state: any) => state.peer.peerId === 'peer-z'), 2000, 'presence removal');

      peer.project.applyCellTextChanges('work.ipynb', 'a', [{ offset: 5, deleteCount: 0, insertText: ' # peer offline' }]);
      host.project.applyCellTextChanges('work.ipynb', 'b', [{ offset: 5, deleteCount: 0, insertText: ' # host online' }]);
      const peerCreatedOffline = path.join(peerFolder, 'peer-created-offline.py');
      await writeFile(peerCreatedOffline, 'print("created while disconnected")\n', 'utf8');
      await peer.onLocalFile(fakeVscode.Uri.file(peerCreatedOffline), 'create');

      await rm(path.join(hostFolder, 'notes.txt'));
      await host.onLocalDelete(fakeVscode.Uri.file(path.join(hostFolder, 'notes.txt')));
      await writeFile(path.join(hostFolder, 'model.bin'), 'OFFLINE_NEW_MODEL', 'utf8');
      await host.onLocalFile(fakeVscode.Uri.file(path.join(hostFolder, 'model.bin')), 'change');
      assert.equal(await fileExists(path.join(peerFolder, 'notes.txt')), true, 'offline peer still has the deleted file before reconciliation');
      assert.equal(await readFile(path.join(peerFolder, 'model.bin'), 'utf8'), 'NEW_MODEL', 'offline peer still has the prior binary before reconciliation');

      const reconnected = onceEvent(peer, 'peerConnected');
      healInMemoryTrystero();
      await reconnected;
      await waitFor(() => {
        const a = host.project.notebookSnapshot('work.ipynb');
        const b = peer.project.notebookSnapshot('work.ipynb');
        return JSON.stringify(a) === JSON.stringify(b)
          && a.cells[0].source.includes('peer offline')
          && a.cells[1].source.includes('host online');
      }, 5000, 'bidirectional reconnect convergence');
      await waitFor(() => host.snapshot().awareness.some((state: any) => state.peer.peerId === 'peer-z'), 3000, 'presence restoration');
      await waitFor(() => host.project.has('peer-created-offline.py')
        && host.project.text('peer-created-offline.py').toString() === 'print("created while disconnected")\n',
      5000, 'participant-created file reconciliation');
      await waitFor(async () => !peer.project.has('notes.txt')
        && !await fileExists(path.join(peerFolder, 'notes.txt')), 5000, 'offline delete tombstone reconciliation');
      await waitFor(async () => await readFile(path.join(peerFolder, 'model.bin'), 'utf8') === 'OFFLINE_NEW_MODEL', 5000, 'offline binary revision reconciliation');

      // Concurrent same-version binary edits must converge independently of
      // delivery order.  Both peers start from the same revision and therefore
      // create revision N+1; author/hash provide the deterministic tie-break.
      const hostDisconnectedAgain = onceEvent(host, 'peerDisconnected');
      const peerDisconnectedAgain = onceEvent(peer, 'peerDisconnected');
      partitionInMemoryTrystero();
      await Promise.all([hostDisconnectedAgain, peerDisconnectedAgain]);
      await writeFile(path.join(hostFolder, 'model.bin'), 'HOST_CONCURRENT', 'utf8');
      await host.onLocalFile(fakeVscode.Uri.file(path.join(hostFolder, 'model.bin')), 'change');
      await writeFile(path.join(peerFolder, 'model.bin'), 'PEER_CONCURRENT', 'utf8');
      await peer.onLocalFile(fakeVscode.Uri.file(path.join(peerFolder, 'model.bin')), 'change');
      const hostRevision = (host as any).binaryVersions.get('model.bin');
      const peerRevision = (peer as any).binaryVersions.get('model.bin');
      assert.equal(hostRevision.version, peerRevision.version, 'concurrent edits intentionally collide on numeric revision');
      assert.notEqual(hostRevision.author, peerRevision.author);

      const reconnectedAgain = onceEvent(peer, 'peerConnected');
      healInMemoryTrystero();
      await reconnectedAgain;
      await waitFor(async () => {
        const hostBytes = await readFile(path.join(hostFolder, 'model.bin'), 'utf8');
        const peerBytes = await readFile(path.join(peerFolder, 'model.bin'), 'utf8');
        const hostVersion = (host as any).binaryVersions.get('model.bin');
        const peerVersion = (peer as any).binaryVersions.get('model.bin');
        return hostBytes === 'PEER_CONCURRENT'
          && peerBytes === 'PEER_CONCURRENT'
          && JSON.stringify(hostVersion) === JSON.stringify(peerVersion);
      }, 5000, 'deterministic concurrent binary convergence');
    } finally {
      delete fakeVscode.__config.allowRemoteCompute;
      delete fakeVscode.__config.allowCpu;
      fakeVscode.window.activeNotebookEditor = undefined;
      fakeVscode.window.activeTextEditor = undefined;
      host.descriptor.mode = 'host-only';
      if (peer) peer.descriptor.mode = 'host-only';
      await Promise.allSettled([host.leave(), peer?.leave?.()]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('elects one resilient coordinator and rejects a returning stale host clock', async function () {
    this.timeout(25_000);
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
    try {
      await host.start();
      peerB = new SessionRuntime(descriptor({
        sessionId, role: 'peer', peerId: 'peer-b', hostPeerId: 'host', workingFolder: folders[1]!,
        pythonPath: process.execPath, knownPeers: [{ ...host.descriptor.localPeer }],
      }), token, context(extensionRoot), logger());
      await peerB.start();
      peerC = new SessionRuntime(descriptor({
        sessionId, role: 'peer', peerId: 'peer-c', hostPeerId: 'host', workingFolder: folders[2]!,
        pythonPath: process.execPath, knownPeers: [{ ...host.descriptor.localPeer }],
      }), token, context(extensionRoot), logger());
      await peerC.start();
      useFastLogicalRecovery(peerB, peerC);
      await waitFor(() => peerB.snapshot().peers.some((peer: any) => peer.peerId === 'peer-c' && peer.online), 5000, 'peer mesh');
      await waitFor(() => peerB.descriptor.localPeer.joinOrder === 1
        && peerC.descriptor.localPeer.joinOrder === 2, 2000, 'monotonic host-assigned participant order');
      await host.flush();
      const oldHostBacking = host.descriptor.backingFolder;

      await host.transport.stop();
      await waitFor(() => peerB.snapshot().clock.hostId === 'peer-b' && peerC.snapshot().clock.hostId === 'peer-b', 6000, 'deterministic failover');
      assert.equal(peerB.snapshot().clock.hostEpoch, 1);
      assert.equal(peerC.snapshot().clock.hostEpoch, 1);
      assert.equal(peerB.snapshot().waitingForHostFolder, true);
      assert.equal(peerC.snapshot().waitingForHostFolder, true);
      assert.equal(peerB.snapshot().runtimeState, 'waiting-for-host-folder');
      assert.equal(peerC.snapshot().runtimeState, 'waiting-for-host-folder');
      await assert.rejects(peerB.saveAsHost(), /choose a new host folder/i);
      assert.equal(await fileExists(path.join(oldHostBacking, 'work.ipynb')), true, 'the old host retains its latest persisted copy');

      const replacementBacking = path.join(root, 'peer-b-backing');
      await peerB.setBackingFolder(replacementBacking);
      await waitFor(() => !peerB.snapshot().waitingForHostFolder && !peerC.snapshot().waitingForHostFolder, 3000, 'host-folder pause resumes');
      assert.equal(await fileExists(path.join(replacementBacking, 'work.ipynb')), true, 'the new host materializes the complete current project');
      peerB.project.applyCellTextChanges('work.ipynb', 'a', [{ offset: 9, deleteCount: 0, insertText: ' # newest' }]);
      await waitFor(() => peerC.project.notebookSnapshot('work.ipynb').cells[0].source.includes('newest'), 3000, 'post-failover edit');

      const staleEpoch = host.snapshot().clock.hostEpoch;
      await host.transport.start();
      const knownB = host.descriptor.knownPeers.find((peer: any) => peer.peerId === 'peer-b');
      assert.ok(knownB);
      host.transport.connect(knownB);
      await waitFor(() => host.snapshot().clock.hostId === 'peer-b', 5000, 'stale host demotion');
      assert.ok(host.snapshot().clock.hostEpoch > staleEpoch);
      await waitFor(() => host.project.notebookSnapshot('work.ipynb').cells[0].source.includes('newest'), 5000, 'stale host state convergence');
      assert.equal(host.project.notebookSnapshot('work.ipynb').cells[0].source, peerB.project.notebookSnapshot('work.ipynb').cells[0].source);
    } finally {
      for (const runtime of [host, peerB, peerC].filter(Boolean)) runtime.descriptor.mode = 'host-only';
      await Promise.allSettled([host.leave(), peerB?.leave?.(), peerC?.leave?.()]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reconciles two hosts elected at the same epoch in isolated partitions', async function () {
    this.timeout(20_000);
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

      partitionInMemoryTrystero();
      host.descriptor.mode = 'host-only';
      await host.leave();
      await waitFor(() => alpha.coordinator.clock.hostId === 'alpha'
        && beta.coordinator.clock.hostId === 'beta'
        && alpha.coordinator.clock.hostEpoch === beta.coordinator.clock.hostEpoch, 5000, 'independent equal-epoch elections');

      healInMemoryTrystero();
      await waitFor(() => alpha.coordinator.clock.hostId === 'alpha'
        && beta.coordinator.clock.hostId === 'alpha', 5000, 'equal-epoch host convergence');
      assert.equal(alpha.coordinator.clock.hostEpoch, beta.coordinator.clock.hostEpoch);
      assert.equal(alpha.snapshot().waitingForHostFolder, true);
      assert.equal(beta.snapshot().waitingForHostFolder, true);
    } finally {
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

  it('restores persisted compute epochs and resolves same-epoch compute changes deterministically', async () => {
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
      (first as any).computeTargetAvailabilityError = () => undefined;
      (second as any).computeTargetAvailabilityError = () => undefined;
      assert.equal((first as any).computeEpoch, 9, 'constructor restores the maximum persisted epoch');
      assert.equal((second as any).computeEpoch, 9, 'every restarted peer restores the same persisted epoch floor');
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
      assert.deepEqual(first.computeForNotebook('work.ipynb'), second.computeForNotebook('work.ipynb'));
      assert.equal(first.computeForNotebook('work.ipynb').executorId, 'peer-z', 'same-epoch tie is independent of arrival order');
      assert.equal((first as any).computeEpoch, 10);
      assert.equal((second as any).computeEpoch, 10);

      await (first as any).onMessage({
        type: 'computeChanged', payload: new Uint8Array(),
        meta: {
          notebookKey: 'work.ipynb', computeEpoch: 999_999,
          target: { executorId: 'peer-b', device: 'cpu', epoch: 999_999, author: 'peer-b' },
        },
      }, 'peer-b');
      assert.equal((first as any).computeEpoch, 10, 'a peer cannot poison the compute epoch with an arbitrary jump');
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
      assert.deepEqual(local.kernelStatuses, { 'A.ipynb': 'Busy', 'B.ipynb': 'Idle' });

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

  it('keeps local hardware and executable paths private until remote compute is enabled', async () => {
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
      fakeVscode.__config.allowRemoteCompute = false;
      (runtime as any).updatePresence();
      const advertised = runtime.awareness.getLocalState();
      assert.equal(advertised.hardware, undefined);
      assert.equal(advertised.resources, undefined);
      assert.equal(runtime.localComputePresence()?.hardware?.python.executable, 'C:\\Users\\private\\python.exe');

      fakeVscode.__config.allowRemoteCompute = true;
      (runtime as any).updatePresence();
      assert.equal(runtime.awareness.getLocalState()?.hardware?.python.executable, 'C:\\Users\\private\\python.exe');
    } finally {
      delete fakeVscode.__config.allowRemoteCompute;
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

  it('reconnects to remembered peers after a partition promoted it locally', () => {
    const runtime: any = Object.create(SessionRuntime.prototype);
    runtime.descriptor = {
      localPeer: { peerId: 'peer-z' },
      knownPeers: [
        { peerId: 'host', displayName: 'Host', joinOrder: 0 },
        { peerId: 'peer-z', displayName: 'Peer', joinOrder: 1 },
      ],
    };
    runtime.coordinator = { clock: { sessionEpoch: 1, hostEpoch: 2, hostId: 'peer-z' } };
    const connected: string[] = [];
    runtime.transport = { connect: (peer: { peerId: string }) => connected.push(peer.peerId) };

    runtime.reconnect();

    assert.deepEqual(connected, ['host']);
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
      assert.throws(() => (runtime as any).acceptAwarenessUpdate(payload, 'peer-b'), /already owned/i);
      assert.throws(() => (runtime as any).acceptAwarenessUpdate(Uint8Array.of(1), 'peer-a'), /awareness/i);
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


describe('compute and lifecycle regression coverage', () => {
  it('accepts a selected PythonEnvironment by executable and permits a CUDA-ready non-default environment', async () => {
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
      runtime.awareness.getStates().set(99, {
        peer: { peerId: 'peer-z', displayName: 'peer-z', joinOrder: 1 },
        allowRemoteCompute: true,
        allowCpu: true,
        allowGpu: true,
        shareCursor: true,
        cursorColor: '#ffffff',
        kernelStatus: 'Offline',
        hardware: {
          cpuModel: 'CPU', logicalThreads: 8, totalRamMb: 16000, availableRamMb: 8000, discoveredAt: Date.now(),
          gpus: [{
            index: 0, vendor: 'NVIDIA', model: 'GPU', vramMb: 8192, driver: '1', cudaVersion: '12',
            utilizationPercent: 0, memoryUsedMb: 0,
          }],
          python: {
            executable: '/default/python', version: '3.13', torchInstalled: false, torchVersion: '',
            torchCudaAvailable: false, torchCudaVersion: '', cudaDeviceNames: [],
          },
        },
        environments: [
          {
            executable: '/default/python', version: '3.13', environment: 'default', jupyterReady: true,
            torchVersion: '', cudaAvailable: false, source: 'PATH',
          },
          {
            executable: '/cuda/python', version: '3.12', environment: 'cuda-env', jupyterReady: true,
            torchVersion: '2.x', cudaAvailable: true, source: 'Conda',
          },
        ],
      });
      assert.doesNotThrow(() => runtime.changeCompute('peer-z', 'work.ipynb', 'cpu', '/cuda/python'));
      assert.equal(runtime.computeForNotebook('work.ipynb').pythonPath, '/cuda/python');
      assert.doesNotThrow(() => runtime.changeCompute('peer-z', 'work.ipynb', 'gpu:0', '/cuda/python'));
      assert.equal(runtime.computeForNotebook('work.ipynb').device, 'gpu:0');
      assert.throws(() => runtime.changeCompute('peer-z', 'work.ipynb', 'cpu', '/missing/python'), /cannot start a Jupyter kernel/);
      assert.throws(() => runtime.changeCompute('peer-z', 'work.ipynb', 'gpu:0', '/default/python'), /does not expose CUDA/);
    } finally {
      await (runtime as any).disposeAsync();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps local CPU/GPU selectable when remote compute advertisement is disabled', async () => {
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
        allowRemoteCompute: false, allowCpu: false, allowGpu: false,
        hardware: { ...(runtime as any).hardware, gpus: [] }, environments: (runtime as any).environments,
      });
      const local = runtime.localComputePresence();
      assert.equal(local?.allowRemoteCompute, true);
      assert.equal(local?.hardware?.gpus.length, 1);
      assert.doesNotThrow(() => runtime.changeCompute('host', 'work.ipynb', 'cpu', '/cuda/python'));
      assert.doesNotThrow(() => runtime.changeCompute('host', 'work.ipynb', 'gpu:0', '/cuda/python'));
      assert.equal(runtime.computeForNotebook('work.ipynb').device, 'gpu:0');
    } finally {
      await (runtime as any).disposeAsync();
      const saved = JSON.parse(await readFile(path.join(folder, '.pair-notebook-session.json'), 'utf8'));
      assert.equal(saved.notebookCompute['work.ipynb'].device, 'gpu:0', 'shutdown drains the latest queued descriptor write');
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns immediate execution errors when remote compute is disabled or the target is stale', async () => {
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
      sendTo: (peerId: string, type: string, meta: any) => sent.push({ peerId, type, meta }),
      stop: async () => undefined,
    };
    try {
      fakeVscode.__config.allowRemoteCompute = false;
      await (runtime as any).handleExecutionRequest({
        type: 'executeRequest', payload: Buffer.from('1+1'),
        meta: {
          requestId: 'disabled', notebookKey: 'work.ipynb',
          target: { executorId: 'host', device: 'cpu', epoch: 0, author: 'host' },
          documentManifest: {}, binaryManifest: {}, directoryManifest: [],
        },
      }, 'peer-z');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].type, 'executeResult');
      assert.equal(sent[0].meta.result.success, false);
      assert.equal(sent[0].meta.result.content.ename, 'RemoteComputeDisabled');

      sent.length = 0;
      await (runtime as any).handleKernelCommand({
        type: 'kernelCommand', payload: new Uint8Array(),
        meta: { requestId: 'kernel-disabled', notebookKey: 'work.ipynb', command: 'interrupt', target: runtime.computeForNotebook('work.ipynb') },
      }, 'peer-z');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].type, 'kernelCommandResult');
      assert.equal(sent[0].meta.success, false);
      assert.match(sent[0].meta.message, /remote compute/i);

      fakeVscode.__config.allowRemoteCompute = true;
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
      assert.equal(sent[0].meta.result.content.ename, 'ComputeTargetChanged');

      // Turning off an advertised device must be enforced on the executor,
      // even if a peer still holds a previously selected target.
      const currentTarget = runtime.computeForNotebook('work.ipynb');
      fakeVscode.__config.allowCpu = false;
      sent.length = 0;
      await (runtime as any).handleExecutionRequest({
        type: 'executeRequest', payload: Buffer.from('1+1'),
        meta: {
          requestId: 'cpu-disabled', notebookKey: 'work.ipynb', target: currentTarget,
          documentManifest: {}, binaryManifest: {}, directoryManifest: [],
        },
      }, 'peer-z');
      assert.equal(sent[0].meta.result.content.ename, 'CpuComputeDisabled');

      sent.length = 0;
      await (runtime as any).handleKernelCommand({
        type: 'kernelCommand', payload: new Uint8Array(),
        meta: { requestId: 'kernel-cpu-disabled', notebookKey: 'work.ipynb', command: 'interrupt', target: currentTarget },
      }, 'peer-z');
      assert.equal(sent[0].type, 'kernelCommandResult');
      assert.equal(sent[0].meta.success, false);
      assert.match(sent[0].meta.message, /CPU sharing is disabled/);

      fakeVscode.__config.allowCpu = true;
      sent.length = 0;
      await (runtime as any).handleKernelCommand({
        type: 'kernelCommand', payload: new Uint8Array(),
        meta: { requestId: 'kernel-malformed', notebookKey: 'work.ipynb', command: 'interrupt' },
      }, 'peer-z');
      assert.equal(sent[0].type, 'kernelCommandResult');
      assert.equal(sent[0].meta.success, false);
      assert.match(sent[0].meta.message, /malformed/);
    } finally {
      delete fakeVscode.__config.allowRemoteCompute;
      delete fakeVscode.__config.allowCpu;
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
      sessionId: 'send-failure', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'send-failure-token-that-is-long-enough', context(extensionRoot), logger());
    try {
      runtime.descriptor.notebookCompute = {
        'work.ipynb': { executorId: 'peer-z', device: 'cpu', epoch: 1, author: 'host' },
      };
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

  it('retries one idempotent execution request after a route replacement and acknowledges its result', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-exec-route-retry-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'exec-route-retry', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'exec-route-retry-token-that-is-long-enough', context(extensionRoot), logger());
    let attempts = 0;
    let routeWaits = 0;
    const sentTypes: string[] = [];
    try {
      runtime.descriptor.notebookCompute = {
        'work.ipynb': { executorId: 'peer-z', device: 'cpu', epoch: 1, author: 'host' },
      };
      (runtime as any).synchronizeExecutionFiles = async () => ({ documents: {}, binaries: {}, directories: [] });
      (runtime as any).transport = {
        waitForRoute: async () => { routeWaits += 1; },
        sendTo: (_peerId: string, type: string, meta: any) => {
          sentTypes.push(type);
          if (type !== 'executeRequest') return;
          attempts += 1;
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
      assert.ok(routeWaits >= 2);
      assert.ok(sentTypes.includes('executeResultAck'), 'the terminal result is acknowledged');
      assert.equal((runtime as any).pendingExecutions.size, 0);
    } finally {
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
      fakeVscode.__config.allowRemoteCompute = true;
      fakeVscode.__config.allowCpu = true;
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
      delete fakeVscode.__config.allowRemoteCompute;
      delete fakeVscode.__config.allowCpu;
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
        type: 'executeResult', payload: new Uint8Array(), meta: {
          requestId,
          eventCount: 2,
          result: { requestId, success: true, content: { status: 'ok' } },
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

  it('rejects pending remote executions when the session closes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-dispose-exec-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'dispose-exec', role: 'host', peerId: 'host', hostPeerId: 'host',
      workingFolder: folder, pythonPath: process.execPath,
    }), 'dispose-exec-token-that-is-long-enough', context(extensionRoot), logger());
    let rejected = '';
    (runtime as any).pendingExecutions.set('pending', {
      resolve: () => undefined,
      reject: (error: Error) => { rejected = error.message; },
      onEvent: () => undefined,
      executorId: 'peer-z',
      notebookKey: 'work.ipynb',
      timer: setTimeout(() => undefined, 60_000),
      accepted: true,
    });
    try {
      await (runtime as any).disposeAsync();
      assert.match(rejected, /closed during remote execution/);
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
    this.timeout(15_000);
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
    try {
      await host.start();
      host.project.ensureText('handoff.txt', 'saved before handoff');
      await host.flush();
      const oldHostBacking = host.descriptor.backingFolder;
      peer = new SessionRuntime(descriptor({
        sessionId, role: 'peer', peerId: 'peer-z', hostPeerId: 'host', workingFolder: peerFolder,
        pythonPath: process.execPath,
        knownPeers: [{ ...host.descriptor.localPeer }],
      }), token, context(extensionRoot), logger());
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
    } finally {
      host.descriptor.mode = 'host-only';
      if (peer) peer.descriptor.mode = 'host-only';
      await Promise.allSettled([host.leave(), peer?.leave()]);
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lets the host end a Trystero session for every participant', async function () {
    this.timeout(15_000);
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

  it('recovers through a bounded clock jump after missing multiple host changes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-host-clock-reconcile-'));
    const extensionRoot = path.join(root, 'extension');
    const folder = path.join(root, 'project');
    await Promise.all([mkdir(extensionRoot, { recursive: true }), mkdir(folder, { recursive: true })]);
    const runtime = new SessionRuntime(descriptor({
      sessionId: 'clock-reconcile', role: 'host', peerId: 'old-host', hostPeerId: 'old-host',
      workingFolder: folder, pythonPath: process.execPath,
      knownPeers: [{ peerId: 'new-host', displayName: 'New Host', joinOrder: 1 }],
    }), 'clock-reconcile-token-that-is-long-enough', context(extensionRoot), logger());
    const broadcasts: Array<{ type: string; meta: any }> = [];
    (runtime as any).clockReconciliationRequired = true;
    (runtime as any).transport = {
      peerRuntime: () => [{
        peerId: 'new-host', displayName: 'New Host', joinOrder: 1, online: true,
        latency: 1, latencyEma: 1, lastHeartbeat: Date.now(), missedHeartbeats: 0, route: 'Direct',
      }],
      broadcast: (type: string, meta: any) => broadcasts.push({ type, meta }),
      stop: async () => undefined,
    };
    try {
      await (runtime as any).onMessage({
        type: 'helloAck', payload: new Uint8Array(),
        meta: { clock: { sessionEpoch: 10, hostEpoch: 3, hostId: 'new-host' }, hostStorageReady: true },
      }, 'new-host');
      assert.equal(runtime.coordinator.clock.hostId, 'new-host');
      assert.equal(runtime.coordinator.clock.hostEpoch, 3);
      assert.equal(runtime.descriptor.role, 'peer');
      assert.ok(broadcasts.some((item) => item.type === 'hostAnnouncement'));
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
  it('routes Run Cell through per-notebook queues and routes Interrupt to the runtime', async () => {
    const controller = new PairNotebookController(logger());
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const runtime: any = {
      notebookKey: (uri: any) => uri.fsPath,
      notebookCellId: (cell: any) => cell.id,
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
      project: { setCellOutputs: () => undefined, setCellExecution: () => undefined },
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
  it('merges missed per-notebook compute state and ignores an older replay', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-compute-state-'));
    const saved = descriptor({
      sessionId: 'compute-state', role: 'host', peerId: 'host', hostPeerId: 'host',
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
            'work.ipynb': { executorId: 'peer-b', device: 'cpu', epoch: 5, author: 'peer-b' },
          },
        },
      }, 'peer-b');
      assert.deepEqual(runtime.computeForNotebook('work.ipynb'), {
        executorId: 'peer-b', device: 'cpu', epoch: 5, author: 'peer-b', pythonPath: undefined,
      });
      await (runtime as any).onMessage({
        type: 'computeState', payload: new Uint8Array(), meta: {
          targets: {
            'work.ipynb': { executorId: 'peer-a', device: 'cpu', epoch: 4, author: 'peer-a' },
          },
        },
      }, 'peer-a');
      assert.equal(runtime.computeForNotebook('work.ipynb').executorId, 'peer-b');
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
        allowRemoteCompute: false,
        allowCpu: false,
        allowGpu: false,
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

  it('completes teardown when the pre-leave host transfer fails', async function () {
    this.timeout(15_000);
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
      transport.sendTo = (targetId: string, type: string, meta?: unknown, payload?: Uint8Array) => {
        if (type === 'hostTransferPrepare') throw new Error('prepare transport failed');
        return originalSendTo(targetId, type, meta, payload);
      };
      // Leaving must resolve and fully dispose even though the courtesy
      // handover failed; a rejected leave() would keep the session alive.
      await host.leave();
      assert.equal(host.snapshot().closed, true);
    } finally {
      if (peer) peer.descriptor.mode = 'host-only';
      await Promise.allSettled([peer?.leave?.()]);
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
    commands: { executeCommand: async () => undefined },
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
              start: () => undefined,
              end: () => undefined,
              clearOutput: async () => { execution.outputs = []; },
              appendOutput: async (output: any) => { execution.outputs.push(...(Array.isArray(output) ? output : [output])); },
              replaceOutput: async (output: any) => { execution.outputs = Array.isArray(output) ? [...output] : [output]; },
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
    emit({ type: 'iopub', requestId, messageType: 'execute_result', content: { data: { 'text/plain': value }, execution_count: 1 } });
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

function onceEvent(emitter: NodeJS.EventEmitter, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`event ${event} timeout`)), 5000);
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
