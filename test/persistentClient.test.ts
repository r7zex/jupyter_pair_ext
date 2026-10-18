import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import Module from 'node:module';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'mocha';
import type * as vscode from 'vscode';
import { installProxyAwareWebSocket } from '../src/runtime/proxyWebSocket';
import { PersistentClient, PersistentHttpError } from '../src/vps/persistentClient';
import { mergePersistentNotebookOutputs } from '../src/vps/persistentNotebookMerge';
import type { PersistentExecution } from '../src/vps/persistentProtocol';

describe('Persistent session transport and credential boundaries', () => {
  const servers: http.Server[] = [];
  beforeEach(() => installProxyAwareWebSocket({ env: {} }));
  afterEach(async () => {
    installProxyAwareWebSocket({ env: {} });
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  async function serve(handler: http.RequestListener): Promise<string> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  it('requires HTTPS outside loopback and rejects credentials in endpoint URLs', () => {
    assert.throws(() => new PersistentClient('http://192.0.2.10', { kind: 'anonymous' }), /HTTPS/);
    assert.throws(() => new PersistentClient('https://owner:secret@example.com', { kind: 'anonymous' }), /HTTPS/);
    assert.equal(new PersistentClient('https://192.0.2.10/', { kind: 'anonymous' }).endpoint, 'https://192.0.2.10');
  });
  it('joins without any administrative bearer and confines membership credentials to persistent RPC', async () => {
    const observed: { authorization: string | undefined; path: string | undefined; operation: string }[] = [];
    const endpoint = await serve((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      request.on('end', () => {
        observed.push({ authorization: request.headers.authorization, path: request.url, operation: JSON.parse(body).operation as string });
        response.end('{}');
      });
    });
    await new PersistentClient(endpoint, { kind: 'anonymous' }).call('join', { password: 'session-password', sessionId: 'one' });
    const member = new PersistentClient(endpoint, { kind: 'membership', token: 'm'.repeat(32) });
    await member.call('snapshot', { sessionId: 'one', operation: 'create' });
    await assert.rejects(member.call('create'), /administrative/);
    await assert.rejects(new PersistentClient(endpoint, { kind: 'admin', token: 'a'.repeat(32) }).call('snapshot'), /Join/);
    assert.deepEqual(observed, [
      { authorization: undefined, path: '/v1/sessions/rpc', operation: 'join' },
      { authorization: `Bearer ${'m'.repeat(32)}`, path: '/v1/sessions/rpc', operation: 'snapshot' },
    ]);
  });
  it('does not follow redirects or reveal response bodies in errors', async () => {
    let forwarded = false;
    const target = await serve((_request, response) => { forwarded = true; response.end('{}'); });
    const endpoint = await serve((_request, response) => { response.writeHead(302, { location: target }); response.end('private-token'); });
    await assert.rejects(new PersistentClient(endpoint, { kind: 'membership', token: 'm'.repeat(32) }).call('view'), (error: Error) => {
      assert.doesNotMatch(error.message, /private-token/);
      return error instanceof PersistentHttpError && error.status === 302;
    });
    assert.equal(forwarded, false);
  });
  it('bounds individual requests without imposing a total notebook execution timeout', async () => {
    const endpoint = await serve((_request, response) => { response.writeHead(200); response.write('{'); });
    await assert.rejects(new PersistentClient(endpoint, { kind: 'membership', token: 'm'.repeat(32) }, 60).call('execution'), /timed out/);
  });
});

let warningChoice: string | undefined;
let quickPick: ((items: unknown[]) => Promise<unknown>) | undefined;
const informationMessages: string[] = [];
const boundary = {
  TreeItem: class {},
  EventEmitter: class {
    public event = () => ({ dispose: () => undefined });
    public fire(): void {}
    public dispose(): void {}
  },
  Uri: { from: (value: unknown) => value },
  FileType: { File: 1, Directory: 2 },
  FilePermission: { Readonly: 1 },
  ProgressLocation: { Notification: 1 },
  NotebookCellKind: { Code: 2 },
  NotebookCellOutput: class { public constructor(public items: unknown[]) {} },
  NotebookCellOutputItem: {
    error: (error: Error) => ({ mime: 'application/vnd.code.notebook.error', data: Buffer.from(error.message) }),
    stdout: (text: string) => ({ mime: 'application/vnd.code.notebook.stdout', data: Buffer.from(text) }),
  },
  FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
  FileSystemError: { Unavailable: (message: string) => new Error(message), NoPermissions: (message: string) => new Error(message) },
  window: {
    activeNotebookEditor: undefined as { notebook: { uri: vscode.Uri } } | undefined,
    showWarningMessage: async () => warningChoice,
    showQuickPick: async (items: unknown[]) => quickPick?.(items),
    showOpenDialog: async () => [{ scheme: 'file', path: '/selected.txt' }],
    showInputBox: async () => 'upload',
    showInformationMessage: async (message: string) => { informationMessages.push(message); },
    showTextDocument: async (document: unknown) => { void document; },
  },
  commands: { executeCommand: async () => undefined },
  workspace: {
    isTrusted: true,
    workspaceFolders: undefined as vscode.WorkspaceFolder[] | undefined,
    notebookDocuments: [] as vscode.NotebookDocument[],
    updateWorkspaceFolders: () => true,
    registerFileSystemProvider: () => ({ dispose: () => undefined }),
    openTextDocument: async (options: { language: string; content: string }) => options,
    fs: { stat: async () => ({ type: 1, size: 5 }), readFile: async () => Buffer.from('local private fixture') },
  },
};
const loader = Module as typeof Module & { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
function loadPersistentUi(): typeof import('../src/vscode/persistent') {
  const cachedBefore = new Set(Object.keys(require.cache));
  loader._load = function (request, parent, isMain): unknown {
    return request === 'vscode' ? boundary : originalLoad.call(this, request, parent, isMain);
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../src/vscode/persistent') as typeof import('../src/vscode/persistent');
  } finally {
    loader._load = originalLoad;
    // Keep the captured UI classes for this suite, but let later suites load
    // shared renderers with their own complete VS Code boundary.
    for (const id of Object.keys(require.cache)) {
      if (!cachedBefore.has(id) && id.includes(`${path.sep}src${path.sep}`)) delete require.cache[id];
    }
  }
}
const { PersistentFileSystem, PersistentSessionController } = loadPersistentUi();
it('renders another participant\'s input request without prompting or replying on their behalf', async () => {
  let prompts = 0; let replies = 0; const originalInput = boundary.window.showInputBox;
  boundary.window.showInputBox = async () => { prompts++; return 'unexpected'; };
  const connection = { sessionId: 'session', client: { call: async () => { replies++; return {}; } } };
  const ui = Object.assign(Object.create(PersistentSessionController.prototype), { connection, disposed: false, view: { generation: 1 } }) as {
    observe: (run: PersistentExecution, handle: vscode.NotebookCellExecution | undefined, connection: unknown, interactive: boolean) => Promise<PersistentExecution>;
  };
  try {
    const run: PersistentExecution = { id: 'other-run', notebook: 'book.ipynb', cellIndex: 0, requesterId: 'other', deviceId: 'vps', generation: 1, state: 'completed', events: [{ type: 'inputRequest', content: { prompt: 'Other participant input:' } }] };
    assert.equal(await ui.observe(run, undefined, connection, false), run); assert.equal(prompts, 0); assert.equal(replies, 0);
  } finally { boundary.window.showInputBox = originalInput; }
});

describe('Persistent server file save conflicts', () => {
  for (const sameEpoch of [true, false]) it(`retries a delete after live editing only for the same notebook epoch=${sameEpoch}`, async () => {
    const provider = new PersistentFileSystem(); let removals = 0;
    provider.notebookEpoch = () => 'current-epoch';
    provider.setConnection({ sessionId: 'session', client: { call: async (operation: string, input: Record<string, unknown>) => {
      if (operation === 'remove') { if (++removals === 1) throw new PersistentHttpError(409); assert.equal(input.expectedRevision, 9); return { revision: 10, entries: [] }; }
      assert.equal(operation, 'read'); return { revision: 9, content: Buffer.from(JSON.stringify({ metadata: { pair_crdt: { epoch: sameEpoch ? 'current-epoch' : 'replacement-epoch' } } })).toString('base64') };
    } } } as never);
    const removing = provider.delete({ scheme: 'pair-vps', authority: 'session', path: '/book.ipynb' } as vscode.Uri, { recursive: false });
    if (sameEpoch) await removing; else await assert.rejects(removing, /conflict/);
    assert.equal(removals, sameEpoch ? 2 : 1); provider.dispose();
  });
  it('invalidates a delayed read when its file is deleted and recreated at the same path', async () => {
    const provider = new PersistentFileSystem(); let finish!: (reply: unknown) => void;
    const delayed = new Promise(resolve => { finish = resolve; });
    const entry = { path: 'book.ipynb', type: 'file', size: 10, mtime: 1, version: 1, visibility: 'public' };
    provider.setConnection({ sessionId: 'session', client: { call: () => delayed } } as never);
    provider.accept({ revision: 1, entries: [entry] } as never);
    const reading = provider.readFile({ scheme: 'pair-vps', authority: 'session', path: '/book.ipynb' } as vscode.Uri);
    provider.accept({ revision: 2, entries: [] }); provider.accept({ revision: 3, entries: [{ ...entry, version: 3, mtime: 3 }] } as never);
    finish({ revision: 1, content: Buffer.from('old instance').toString('base64') });
    await assert.rejects(reading, /deleted or replaced/); provider.dispose();
  });
  it('presents a completed peer execution once and keeps it protected until its compute generation changes', async () => {
    const previous = boundary.workspace.notebookDocuments; let presentations = 0;
    const run = { id: 'completed-peer', state: 'completed', notebook: 'peer.ipynb', cellId: 'peer-cell', generation: 1, events: [] };
    const notebook = { uri: { scheme: 'pair-vps', authority: 'session', path: '/peer.ipynb' }, getCells: () => [cell] };
    const cell = { notebook, metadata: { id: 'peer-cell' }, document: { isClosed: false, getText: () => 'print(7)' } };
    const connection = { sessionId: 'session', client: { call: async () => run } };
    const controller = Object.assign(Object.create(PersistentSessionController.prototype), {
      connection, disposed: false, view: { generation: 1 }, executions: new Map(), mirroredRuns: new Map(), latestExecutions: new Map(),
      managedRuns: new WeakMap(), localRunning: new Set(), selectedNotebooks: new Set([notebook]),
      files: { visibilityOf: () => 'public' }, observe: async () => run,
      notebookSource: { createNotebookCellExecution: () => { presentations++; return { start() {}, end() {} }; } },
    }) as any;
    boundary.workspace.notebookDocuments = [notebook] as any;
    try {
      await controller.mirrorExecution(run.id); await controller.mirrorExecution(run.id);
      assert.equal(presentations, 1); assert.equal(controller.managesCell(cell), true);
      controller.view.generation = 2; assert.equal(controller.managesCell(cell), false);
    } finally { boundary.workspace.notebookDocuments = previous; }
  });
  it('waits for native completion metadata before returning from Run so an immediate Save captures the final version', async () => {
    const previous = (boundary.workspace as any).onDidChangeNotebookDocument; let changed: ((event: any) => void) | undefined;
    (boundary.workspace as any).onDidChangeNotebookDocument = (listener: (event: any) => void) => { changed = listener; return { dispose() { changed = undefined; } }; };
    const notebook = {}; const cell = { notebook, document: { isClosed: false }, executionSummary: undefined } as any;
    const controller = Object.create(PersistentSessionController.prototype) as any;
    try {
      let resolved = false; let complete!: () => void;
      const pending = controller.endExecution({ end: (success: boolean, endTime: number) => { complete = () => { cell.executionSummary = { success, timing: { endTime } }; changed?.({ notebook }); }; } }, cell, true).then(() => { resolved = true; });
      await Promise.resolve(); assert.equal(resolved, false);
      complete(); await pending; assert.equal(cell.executionSummary.success, true); assert.equal(changed, undefined);
    } finally { (boundary.workspace as any).onDidChangeNotebookDocument = previous; }
  });
  it('renders a pushed execution without another round trip and fences cached runs to their connection', async () => {
    const controller = Object.create(PersistentSessionController.prototype) as any;
    let reads = 0; const connection = { client: { call: async () => { reads++; throw new Error('Unexpected execution poll'); } } };
    controller.connection = connection; controller.disposed = false;
    controller.executionChanges = new Map(); controller.executionWaiters = new Map(); controller.latestExecutions = new Map();
    const run = { id: 'inline-run', state: 'running', events: [] };
    const observing = controller.observe(run, undefined, connection, false);
    const completed = { ...run, state: 'completed', events: [{ type: 'iopub', messageType: 'stream', content: { name: 'stdout', text: 'pushed' } }] };
    controller.notifyExecution(run.id, completed);
    assert.equal(await observing, completed); assert.equal(reads, 0);
    controller.notifyExecution(run.id, run);
    assert.equal(controller.latestExecution(run.id, connection), completed, 'A delayed running event must not replace completion');
    assert.equal(controller.latestExecution(run.id, { ...connection }), undefined, 'A replacement connection cannot use an old run');
  });
  it('wakes a running observer on its authenticated live update before the polling fallback', async () => {
    const controller = Object.create(PersistentSessionController.prototype) as any;
    const run = { id: 'live-run', state: 'running', events: [] };
    let reads = 0;
    const connection = { client: { call: async () => { reads++; return { ...run, state: 'completed' }; } } };
    controller.connection = connection; controller.disposed = false;
    controller.executionChanges = new Map(); controller.executionWaiters = new Map();
    const observing = controller.observe(run, undefined, connection, false);
    assert.equal(controller.executionWaiters.has(run.id), true);
    controller.notifyExecution(run.id);
    let timer!: NodeJS.Timeout;
    try {
      const result = await Promise.race([observing, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Live update waited for the polling fallback')), 200); })]);
      assert.equal(result.state, 'completed'); assert.equal(reads, 1); assert.equal(controller.executionWaiters.size, 0);
    } finally { clearTimeout(timer); }
  });
  it('resumes observation of the same accepted execution after a temporary route failure', async () => {
    const controller = Object.create(PersistentSessionController.prototype) as any;
    const run = { id: 'accepted-before-outage', state: 'running', events: [] }; let polls = 0;
    const connection = { sessionId: 'session', client: { call: async (operation: string, fields: any) => {
      assert.equal(operation, 'execution'); assert.equal(fields.executionId, run.id);
      if (++polls === 1) throw new Error('temporary route failure'); return { ...run, state: 'completed' };
    } } };
    Object.assign(controller, { connection, disposed: false, executionChanges: new Map(), executionWaiters: new Map(), waitForExecutionUpdate: async () => undefined });
    assert.equal((await controller.observe(run, undefined, connection, false)).state, 'completed'); assert.equal(polls, 2);
  });
  it('keeps a managed notebook save stamp stable across its live durable publications', async () => {
    const provider = new PersistentFileSystem(); let revision = 1; let managed = false;
    const snapshot = () => ({ revision, entries: [{ path: 'book.ipynb', type: 'file' as const, size: 12 + revision, mtime: revision, version: revision, visibility: 'public' as const }] });
    const client = { call: async (operation: string) => operation === 'read' ? { content: Buffer.from('{}').toString('base64'), revision } : snapshot() };
    provider.setConnection({ endpoint: 'https://example.com', sessionId: 'session', memberId: 'member', name: 'Test', client } as unknown as Parameters<typeof provider.setConnection>[0]);
    const uri = { scheme: 'pair-vps', authority: 'session', path: '/book.ipynb' } as vscode.Uri;
    provider.notebookManaged = () => managed; provider.accept(snapshot()); await provider.readFile(uri);
    managed = true; revision = 5; provider.accept(snapshot());
    assert.equal((await provider.stat(uri)).mtime, 1);
    let saved = false; provider.notebookSave = async () => { saved = true; return true; };
    await provider.writeFile(uri, Buffer.from('saved native notebook'), { create: true, overwrite: true });
    assert.equal(saved, true); assert.equal((await provider.stat(uri)).mtime, 1);
    assert.equal((await provider.stat(uri)).size, Buffer.byteLength('saved native notebook'));
    managed = false; await provider.release(uri); assert.equal((await provider.stat(uri)).mtime, 5); provider.dispose();
  });
  it('restores a notebook save stamp before its dirty model is reclaimed after Reload Window', async () => {
    const saved = new Map<string, unknown>();
    const state = { get: (key: string, fallback?: unknown) => saved.get(key) ?? fallback, update: async (key: string, value: unknown) => { saved.set(key, value); } } as Pick<vscode.Memento, 'get' | 'update'>;
    let revision = 1;
    const snapshot = () => ({ revision, entries: [{ path: 'book.ipynb', type: 'file' as const, size: 12 + revision, mtime: revision, version: revision, visibility: 'public' as const }] });
    const first = new PersistentFileSystem(state);
    const connection = { endpoint: 'https://example.com', sessionId: 'session', client: { call: async (operation: string) => operation === 'read' ? { content: Buffer.from('{}').toString('base64'), revision } : snapshot() } } as Parameters<typeof first.setConnection>[0];
    const uri = { scheme: 'pair-vps', authority: 'session', path: '/book.ipynb' } as vscode.Uri;
    first.setConnection(connection); first.accept(snapshot());
    await first.readFile(uri); first.notebookManaged = () => true; first.notebookSave = async () => true;
    await first.writeFile(uri, Buffer.from('saved native notebook'), { create: true, overwrite: true });
    const baseline = await first.stat(uri); first.dispose(); revision = 5;
    const restored = new PersistentFileSystem(state); restored.setConnection(connection); restored.accept(snapshot());
    assert.deepEqual(await restored.stat(uri), baseline);
    await restored.readFile(uri); restored.notebookManaged = () => true;
    assert.deepEqual(await restored.stat(uri), baseline);
    await restored.release(uri); restored.notebookManaged = () => false;
    assert.equal((await restored.stat(uri)).mtime, 5); restored.dispose();
    const other = new PersistentFileSystem(state); other.setConnection({ ...connection!, endpoint: 'https://other.example.com' }); other.accept(snapshot());
    assert.equal((await other.stat(uri)).mtime, 5); other.dispose();
  });
  it('rejects a delayed read from a disconnected session without poisoning the new editing baseline', async () => {
    const provider = new PersistentFileSystem();
    let resolveRead!: (value: { content: string; revision: number }) => void;
    const oldRead = new Promise<{ content: string; revision: number }>((resolve) => { resolveRead = resolve; });
    const connection = (client: unknown) => ({ endpoint: 'https://example.com', sessionId: 'session', memberId: 'member', name: 'Test', client }) as Parameters<typeof provider.setConnection>[0];
    provider.setConnection(connection({ call: async () => oldRead }));
    const uri = { scheme: 'pair-vps', authority: 'session', path: '/main.py' } as vscode.Uri;
    const pending = provider.readFile(uri);
    const writes: Record<string, unknown>[] = [];
    provider.setConnection(connection({ call: async (operation: string, input: Record<string, unknown>) => {
      if (operation === 'read') return { content: Buffer.from('new connection').toString('base64'), revision: 2 };
      writes.push(input); return { revision: 3, entries: [] };
    } }));
    resolveRead({ content: Buffer.from('old private content').toString('base64'), revision: 99 });
    await assert.rejects(pending, /session changed/);
    assert.equal(Buffer.from(await provider.readFile(uri)).toString(), 'new connection');
    await provider.writeFile(uri, Buffer.from('new edit'), { create: true, overwrite: true });
    assert.equal(writes[0]?.expectedRevision, 2);
    provider.dispose();
  });

  it('rejects a delayed save acknowledgement without replacing a new session snapshot', async () => {
    const provider = new PersistentFileSystem();
    let resolveWrite!: (value: { revision: number; entries: [] }) => void;
    const pendingWrite = new Promise<{ revision: number; entries: [] }>((resolve) => { resolveWrite = resolve; });
    const connection = (client: unknown) => ({ endpoint: 'https://example.com', sessionId: 'session', memberId: 'member', name: 'Test', client }) as Parameters<typeof provider.setConnection>[0];
    provider.setConnection(connection({ call: async () => pendingWrite }));
    const pending = provider.writeFile({ scheme: 'pair-vps', authority: 'session', path: '/main.py' } as vscode.Uri, Buffer.from('edit'), { create: true, overwrite: true });
    await Promise.resolve();
    provider.setConnection(connection({ call: async () => ({ revision: 2, entries: [] }) }));
    provider.accept({ revision: 2, entries: [] });
    resolveWrite({ revision: 99, entries: [] });
    await assert.rejects(pending, /session changed/);
    assert.equal(provider.revision, 2);
    provider.dispose();
  });
  it('rejects a nonrecursive delete of a nonempty folder without sending a server mutation', async () => {
    const provider = new PersistentFileSystem();
    const operations: string[] = [];
    const client = { call: async (operation: string) => {
      operations.push(operation);
      return { revision: 2, entries: [] };
    } };
    provider.setConnection({ endpoint: 'https://example.com', sessionId: 'session', memberId: 'member', name: 'Test', client } as unknown as Parameters<typeof provider.setConnection>[0]);
    provider.accept({ revision: 1, entries: [
      { path: 'folder', type: 'directory', size: 0, mtime: 1, version: 1, visibility: 'public' },
      { path: 'folder/main.py', type: 'file', size: 8, mtime: 1, version: 1, visibility: 'public' },
    ] });
    const uri = { scheme: 'pair-vps', authority: 'session', path: '/folder' } as vscode.Uri;
    await assert.rejects(provider.delete(uri, { recursive: false }), /folder is not empty/);
    assert.deepEqual(operations, []);
    await provider.delete(uri, { recursive: true });
    assert.deepEqual(operations, ['remove']);
    provider.dispose();
  });
  it('keeps the read revision for a dirty file when newer server revisions arrive', async () => {
    const provider = new PersistentFileSystem();
    const inputs: Record<string, unknown>[] = [];
    const client = { call: async (operation: string, input: Record<string, unknown>) => {
      if (operation === 'read') return { content: Buffer.from('original').toString('base64'), revision: 4 };
      inputs.push(input);
      throw new PersistentHttpError(409);
    } };
    provider.setConnection({ endpoint: 'https://example.com', sessionId: 'session', memberId: 'member', name: 'Test', client } as unknown as Parameters<typeof provider.setConnection>[0]);
    provider.accept({ revision: 4, entries: [{ path: 'main.py', type: 'file', size: 8, mtime: 1, version: 1, visibility: 'public' }] });
    const uri = { scheme: 'pair-vps', authority: 'session', path: '/main.py' } as vscode.Uri;
    await provider.readFile(uri);
    provider.accept({ revision: 5, entries: [{ path: 'main.py', type: 'file', size: 8, mtime: 2, version: 2, visibility: 'public' }] });
    const dirty = Buffer.from('my unsaved edit');
    await assert.rejects(provider.writeFile(uri, dirty, { create: false, overwrite: true }), /Save conflict/);
    assert.equal(inputs[0]?.expectedRevision, 4);
    assert.equal(dirty.toString(), 'my unsaved edit');
    provider.dispose();
  });
  it('does not advance a dirty notebook baseline when execution results or comparison reads refresh the server state', async () => {
    const provider = new PersistentFileSystem();
    let revision = 7;
    let content = '{"cells":[{"source":"original"}]}';
    let writes = 0;
    const entries = () => [{ path: 'test.ipynb', type: 'file' as const, size: content.length, mtime: revision, version: revision, visibility: 'public' as const }];
    const client = { call: async (operation: string, input: Record<string, unknown>) => {
      if (operation === 'read') return { content: Buffer.from(content).toString('base64'), revision };
      if (operation === 'snapshot') return { revision, entries: entries() };
      if (input.expectedRevision !== revision) throw new PersistentHttpError(409);
      writes++;
      return { revision: ++revision, entries: entries() };
    } };
    provider.setConnection({ endpoint: 'https://example.com', sessionId: 'session', memberId: 'member', name: 'Test', client } as unknown as Parameters<typeof provider.setConnection>[0]);
    provider.accept({ revision, entries: entries() });
    const uri = { scheme: 'pair-vps', authority: 'session', path: '/test.ipynb' } as vscode.Uri;
    const oldSource = await provider.readFile(uri);
    // A collaborator edits source while execution updates and snapshots arrive.
    revision++;
    content = '{"cells":[{"source":"collaborator edit"}]}';
    await provider.refresh();
    await provider.readFile(uri); // Showing the new server version does not replace the dirty editor.
    await assert.rejects(provider.writeFile(uri, oldSource, { create: false, overwrite: true }), /Save conflict/);
    assert.equal(writes, 0);
    assert.match(content, /collaborator edit/);
    provider.dispose();
  });
  for (const open of [false, true]) it(`blocks raw notebook Overwrite without replacing its epoch when an editor is open=${open}`, async () => {
    const provider = new PersistentFileSystem(); const operations: string[] = [];
    const snapshot = { revision: 7, entries: [{ path: 'test.ipynb', type: 'file' as const, size: 10, mtime: 1, version: 1, visibility: 'public' as const }] };
    const client = { call: async (operation: string) => { operations.push(operation); return snapshot; } };
    provider.setConnection({ endpoint: 'https://example.com', sessionId: 'session', memberId: 'member', name: 'Member', client } as unknown as Parameters<typeof provider.setConnection>[0]);
    provider.accept(snapshot); if (open) provider.notebookSave = async () => false;
    const uri = { scheme: 'pair-vps', authority: 'session', path: '/test.ipynb' } as vscode.Uri;
    const local = Buffer.from('local same-name notebook');
    await assert.rejects(provider.writeFile(uri, local, { create: true, overwrite: true }), /Overwrite cannot replace/);
    assert.deepEqual(operations, []); assert.equal(local.toString(), 'local same-name notebook');
    await provider.writeFile(uri, local, { create: true, overwrite: true }, true);
    assert.deepEqual(operations, ['write'], 'only the separate confirmed upload replacement may replace a notebook'); provider.dispose();
  });
});

describe('Persistent notebook execution connection ownership', () => {
  it('shows fresh-kernel namespace reset events even when the server generation did not change', async () => {
    informationMessages.length = 0;
    const message = 'A fresh Python kernel was started; previous variables are unavailable.';
    const ui = Object.assign(Object.create(PersistentSessionController.prototype), {
      connection: { sessionId: 'session' }, disposed: false,
    }) as { observe: (initial: PersistentExecution) => Promise<PersistentExecution> };
    await ui.observe({ id: 'fresh-kernel', notebook: 'work.ipynb', cellIndex: 0, requesterId: 'member', deviceId: 'vps',
      generation: 1, state: 'completed', events: [{ type: 'kernelState', message }] });
    assert.ok(informationMessages.includes(message));
  });

  for (const change of ['generation', 'source']) it(`keeps late outputs and errors in recovery after a ${change} change`, async () => {
    const calls: string[] = []; const source = change === 'source' ? 'changed cell' : 'admitted cell';
    const handle = { cell: { document: { getText: () => source, isClosed: false } }, replaceOutput: async () => { calls.push('outputs'); }, appendOutput: async () => { calls.push('errors'); } } as unknown as vscode.NotebookCellExecution;
    const ui = Object.assign(Object.create(PersistentSessionController.prototype), { connection: { sessionId: 'session' }, disposed: false, view: { generation: change === 'generation' ? 2 : 1 } }) as { observe: (initial: PersistentExecution, handle: vscode.NotebookCellExecution) => Promise<PersistentExecution> };
    const result: PersistentExecution = { id: 'late', notebook: 'work.ipynb', cellIndex: 0, requesterId: 'member', deviceId: 'old-device', generation: 1, state: 'completed', sourceHash: createHash('sha256').update('admitted cell').digest('hex'), events: [], error: 'late private error' };
    assert.equal(await ui.observe(result, handle), result); assert.deepEqual(calls, []);
  });

  type ExecutionUi = { execute: (cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument) => Promise<void>; connection: unknown };
  for (const outcome of ['failed', 'preparation-error']) it(`stops a batch after ${outcome} and permits a later independent Run`, async () => {
    let admitted = 0; let importsFlushed = 0; let preparationFails = outcome === 'preparation-error'; const ended: unknown[] = [];
    const connection = { sessionId: 'original', client: { call: async () => { admitted++; return { id: 'run', state: 'running', events: [] }; } } };
    const handle = { start() {}, clearOutput: async () => undefined, appendOutput: async () => undefined, end: (success: unknown) => { ended.push(success); } };
    const ui = Object.assign(Object.create(PersistentSessionController.prototype), {
      connection, notebookQueues: new Map(), executions: new Map(), disposed: false, files: { revision: 1, refresh: async () => undefined },
      context: { globalState: { get: (_key: string, fallback: unknown) => fallback, update: async () => undefined } }, notebookSource: { createNotebookCellExecution: () => handle },
      notebookSync: { prepareExecution: async () => { if (preparationFails) { preparationFails = false; throw new Error('prepare failed'); } return undefined; } },
      textSync: { flushAll: async () => { importsFlushed++; } }, observe: async () => ({ state: 'failed', events: [] }),
    }) as ExecutionUi;
    const cells = [0, 1].map((index) => ({ index, kind: 2, document: { languageId: 'python', getText: () => 'print(1)' } }) as unknown as vscode.NotebookCell);
    const notebook = { uri: { scheme: 'pair-vps', authority: 'original', path: '/work.ipynb' } } as vscode.NotebookDocument;
    await ui.execute(cells, notebook); assert.equal(admitted, outcome === 'failed' ? 1 : 0); assert.deepEqual(ended, [false]);
    await ui.execute([cells[1]!], notebook); assert.equal(admitted, outcome === 'failed' ? 2 : 1); assert.ok(importsFlushed >= 1);
  });
  for (const phase of ['queue']) it(`does not submit old notebook cells to a new session after waiting for ${phase}`, async () => {
    let unblock!: () => void;
    const wait = new Promise<void>((resolve) => { unblock = resolve; });
    let saves = 0;
    const connection = { sessionId: 'original', client: { call: async () => { throw new Error('No RPC should be sent'); } } };
    const ui = Object.assign(Object.create(PersistentSessionController.prototype), {
      connection, notebookQueues: new Map(phase === 'queue' ? [['work.ipynb', wait]] : []), disposed: false,
    }) as ExecutionUi;
    const notebook = { uri: { scheme: 'pair-vps', authority: 'original', path: '/work.ipynb' }, save: async () => { saves++; await wait; return true; } } as unknown as vscode.NotebookDocument;
    const pending = ui.execute([], notebook);
    ui.connection = { sessionId: 'replacement' };
    unblock();
    await assert.rejects(pending, /session changed/);
    assert.equal(saves, 0);
  });
  it('does not admit a cell into a replacement session after waiting for source synchronization', async () => {
    let release!: () => void; let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; }); const synchronized = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0; let ended: boolean | undefined;
    const connection = { sessionId: 'original', client: { call: async () => { calls++; throw new Error('No RPC should be sent'); } } };
    const handle = { start: () => undefined, clearOutput: async () => undefined, appendOutput: async () => undefined, end: (success: boolean) => { ended = success; } };
    const ui = Object.assign(Object.create(PersistentSessionController.prototype), {
      connection, notebookQueues: new Map(), executions: new Map(), disposed: false,
      context: { globalState: { get: (_key: string, fallback: unknown) => fallback, update: async () => undefined } }, notebookSource: { createNotebookCellExecution: () => handle },
      notebookSync: { prepareExecution: async () => { entered(); await waiting; return { revision: 1, cells: [] }; } },
    }) as ExecutionUi;
    const cell = { index: 0, kind: 2, document: { languageId: 'python', getText: () => 'print(1)' } } as unknown as vscode.NotebookCell;
    const notebook = { uri: { scheme: 'pair-vps', authority: 'original', path: '/work.ipynb' }, save: async () => { throw new Error('Native save must not gate Run Cell'); } } as unknown as vscode.NotebookDocument;
    const pending = ui.execute([cell], notebook); await synchronized;
    ui.connection = { sessionId: 'replacement' }; release(); await pending;
    assert.equal(calls, 0); assert.equal(ended, false);
  });

  it('binds admission to the original session and the actual displayed cell source', async () => {
    const calls: Record<string, unknown>[] = [];
    const connection = { sessionId: 'original', client: { call: async (_operation: string, input: Record<string, unknown>) => {
      calls.push(input); return { id: 'accepted', state: 'completed', events: [] };
    } } };
    const handle = { start: () => undefined, clearOutput: async () => undefined, end: () => undefined };
    const ui = Object.assign(Object.create(PersistentSessionController.prototype), {
      connection, notebookQueues: new Map(), executions: new Map(), disposed: false,
      files: { revision: 9, refresh: async () => undefined },
      context: { globalState: { get: (_key: string, fallback: unknown) => fallback, update: async () => undefined } },
      notebookSource: { createNotebookCellExecution: () => handle },
      observe: async () => ({ state: 'completed' }),
    }) as ExecutionUi;
    const cell = { index: 0, kind: 2, document: { languageId: 'python', getText: () => 'print("displayed")' } } as unknown as vscode.NotebookCell;
    const notebook = { uri: { scheme: 'pair-vps', authority: 'original', path: '/work.ipynb' }, save: async () => true } as unknown as vscode.NotebookDocument;
    await ui.execute([cell], notebook);
    assert.equal(calls[0]?.sessionId, 'original');
    assert.equal(calls[0]?.expectedSourceHash, createHash('sha256').update('print("displayed")').digest('hex'));
  });
});

describe('Persistent compute selection UI', () => {
  afterEach(() => { quickPick = undefined; warningChoice = undefined; });
  for (const phase of ['dialog', 'response']) it(`keeps current-device consent attached to the original connection during ${phase}`, async () => {
    let release!: () => void; let submitted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { submitted = resolve; });
    const calls: unknown[] = [];
    const view = { memberId: 'member', target: { deviceId: 'pc' }, members: [], consents: [], devices: [
      { id: 'pc', ownerId: 'owner', name: 'Machine', python: '/python', cpu: 'CPU', isolation: 'bwrap', enabled: true, online: true, gpus: [] },
    ] };
    const connection = { sessionId: 'original', client: { call: async (_operation: string, input: unknown) => {
      calls.push(input); submitted(); await gate; return view;
    } } };
    const ui = Object.assign(Object.create(PersistentSessionController.prototype), { connection, view, poll: async () => undefined }) as {
      selectCompute: () => Promise<void>; connection: unknown; view: unknown;
    };
    quickPick = async (items) => { if (phase === 'dialog') { submitted(); await gate; } return items[0]; };
    warningChoice = 'Request access';
    const pending = ui.selectCompute(); await started;
    const replacement = { target: { deviceId: 'new-session-pc' } };
    ui.connection = { sessionId: 'replacement' }; ui.view = replacement;
    release(); await pending;
    assert.equal(calls.length, phase === 'dialog' ? 0 : 1);
    assert.equal(ui.view, replacement);
  });
});

describe('Persistent session actions preserve their original connection', () => {
  afterEach(() => { quickPick = undefined; warningChoice = undefined; });
  for (const action of ['manage', 'shareComputer', 'upload', 'recoverExecution']) it(`rejects ${action} after a session changes during its dialog`, async () => {
    let release!: () => void; let opened!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const dialog = new Promise<void>((resolve) => { opened = resolve; });
    const calls: unknown[] = [];
    const original = { sessionId: 'original', client: { call: async () => { calls.push('original'); return { id: 'run', notebook: 'old.ipynb', cellIndex: 0, state: 'completed', deviceId: 'vps', generation: 1, events: [] }; } } };
    const replacement = { sessionId: 'replacement', client: { call: async () => { calls.push('replacement'); return { id: 'run', notebook: 'old.ipynb', state: 'completed' }; } } };
    const ui = Object.assign(Object.create(PersistentSessionController.prototype), {
      connection: original, disposed: false, poll: async () => undefined,
      view: { id: 'original', name: 'Original', ownerId: 'owner', memberId: 'owner', allowMemberSwitch: false,
        members: [{ id: 'owner', role: 'owner' }], consents: [], devices: [{ id: 'pc', ownerId: 'owner', enabled: true }] },
      context: { globalState: { get: () => [{ notebook: 'old.ipynb', requestId: 'old-request' }] } },
      files: { refresh: async () => undefined, uri: () => ({}), createPrivateDirectory: async () => { calls.push('mkdir'); },
        writeFile: async () => { calls.push('upload'); } },
    }) as { connection: unknown; [key: string]: unknown };
    quickPick = async (items) => {
      opened(); await gate;
      return action === 'manage' ? items.find((item) => (item as { action?: string }).action === 'settings')
        : action === 'shareComputer' ? items.find((item) => (item as { action?: string }).action === 'toggle') : items[0];
    };
    const pending = (ui[action] as () => Promise<void>)(); await dialog;
    ui.connection = replacement; release();
    await assert.rejects(pending, /session changed/);
    assert.deepEqual(calls, action === 'recoverExecution' ? ['original'] : []);
  });

  for (const outcome of ['inspect', 'cancel', 'expired']) it(`loads only the selected saved result after showing summaries: ${outcome}`, async () => {
    const requests: Record<string, unknown>[] = [];
    const shown: unknown[] = [];
    const showDocument = boundary.window.showTextDocument;
    boundary.window.showTextDocument = async document => { shown.push(document); };
    const connection = { sessionId: 'recovery', endpoint: 'https://example.com', memberId: 'member', name: 'Experiment', client: {
      call: async (operation: string, fields: Record<string, unknown>) => {
        assert.equal(operation, 'execution'); requests.push(fields);
        if (!fields.summary && outcome === 'expired') throw new PersistentHttpError(404, 'Unavailable');
        return { id: fields.executionId, notebook: 'data/test.ipynb', cellIndex: fields.executionId === 'newer' ? 2 : 0,
          requesterId: 'member', deviceId: 'vps', generation: 1, state: 'completed',
          events: fields.summary ? [] : [{ type: 'iopub', messageType: 'stream', content: { text: 'saved output sentinel' } }] };
      },
    } };
    const ui = Object.assign(Object.create(PersistentSessionController.prototype), {
      connection, disposed: false, view: { devices: [] },
      context: { globalState: { get: () => [{ id: 'older', createdAt: 1 }, { id: 'newer', createdAt: 2 }, { id: 'other-project', sessionId: 'another' }] } },
    }) as { recoverExecution: () => Promise<void> };
    quickPick = async items => {
      assert.equal(requests.length, 2); assert.ok(requests.every(request => request.summary === true));
      assert.match((items[0] as { label: string }).label, /Cell 3/);
      return outcome === 'cancel' ? undefined : items[0];
    };
    try {
      await ui.recoverExecution();
      assert.equal(requests.length, outcome === 'cancel' ? 2 : 3);
      if (outcome === 'inspect') {
        assert.equal(requests[2]!.executionId, 'newer'); assert.equal(requests[2]!.summary, undefined);
        assert.match((shown[0] as { content: string }).content, /saved output sentinel/);
        assert.match((shown[0] as { content: string }).content, /No code was rerun/);
      } else assert.deepEqual(shown, []);
    } finally { boundary.window.showTextDocument = showDocument; }
  });

  for (const action of ['skip', 'replace', 'private']) it(`handles an upload collision with ${action} without publishing existing private files`, async () => {
    const information = boundary.window.showInformationMessage;
    const calls: boolean[] = []; const publications: string[] = [];
    const connection = { sessionId: 'upload-session', endpoint: 'https://example.com', name: 'Upload test' };
    (boundary.window as any).withProgress = async (_options: unknown, task: () => Promise<void>) => task();
    (boundary.window as any).showInformationMessage = async () => 'Upload';
    let choices = 0;
    quickPick = async items => ++choices === 1 ? items[1] : items.find(item => (item as any).action === action);
    const ui = Object.assign(Object.create(PersistentSessionController.prototype), {
      connection, disposed: false, files: { refresh: async () => undefined, uri: (key: string) => ({ path: key }),
        visibilityOf: (key: string) => action === 'private' && key.endsWith('/selected.txt') ? 'private' : 'public',
        writeFile: async (_uri: unknown, _content: unknown, options: { overwrite: boolean }) => { calls.push(options.overwrite); if (!options.overwrite) throw Object.assign(new Error('exists'), { code: 'FileExists' }); },
        setVisibility: async (uri: { path: string }) => { publications.push(uri.path); },
      },
    }) as { upload: () => Promise<void> };
    try {
      if (action === 'private') await assert.rejects(ui.upload(), /privacy was preserved/); else await ui.upload();
      assert.deepEqual(calls, action === 'replace' ? [false, true] : [false]);
      assert.deepEqual(publications, [], 'uploading into a public folder must not republish its unrelated private children');
    } finally {
      boundary.window.showInformationMessage = information;
      delete (boundary.window as any).withProgress; quickPick = undefined;
    }
  });

  it('does not clear a replacement connection when an old leave acknowledgement arrives late', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const replacement = { sessionId: 'replacement' };
    const ui = Object.assign(Object.create(PersistentSessionController.prototype), {
      connection: { sessionId: 'original', client: { call: async () => gate } },
      context: { globalState: { get: () => [], update: async () => undefined } },
      files: { setConnection: () => undefined }, status: { hide: () => undefined }, changed: { fire: () => undefined },
    }) as { connection: unknown; leave: () => Promise<void> };
    const pending = ui.leave(); ui.connection = replacement; release(); await pending;
    assert.equal(ui.connection, replacement);
  });

  it('keeps a newer attachment while retaining credentials from a delayed older heartbeat', async () => {
    let release!: () => void;
    let reached!: () => void;
    const heartbeatReached = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalCall = PersistentClient.prototype.call;
    PersistentClient.prototype.call = async function <T>(operation: string): Promise<T> {
      if (operation === 'compatibility') return { protocol: 1, features: ['notebook-bootstrap-empty-v1'] } as T;
      if (this.endpoint.includes('first.example') && operation === 'heartbeat') { reached(); await gate; }
      return { id: this.endpoint, name: this.endpoint, state: 'running', memberId: 'member', ownerId: 'owner', members: [{ id: 'member', name: 'Member', role: 'member', online: true }] } as T;
    };
    let saved: unknown[] = []; const credentials: string[] = [];
    const ui = Object.assign(Object.create(PersistentSessionController.prototype), {
      disposed: false, connectionAttempt: 0, credentialWrites: Promise.resolve(), updateUi: () => undefined,
      context: { secrets: { store: async (key: string) => { credentials.push(key); } },
        globalState: { get: () => saved, update: async (_key: string, value: unknown[]) => { saved = value; } } },
      files: { setConnection: () => undefined, accept: () => undefined, refresh: async () => undefined, uri: () => ({ toString: () => 'pair-vps://second/' }) },
    }) as { attach: (saved: unknown, token: string) => Promise<void>; connection: { sessionId: string } };
    const descriptor = (name: string) => ({ endpoint: `https://${name}.example`, sessionId: name, memberId: 'member', name });
    const first = ui.attach(descriptor('first'), 'a'.repeat(40));
    await heartbeatReached;
    try {
      await ui.attach(descriptor('second'), 'b'.repeat(40)); release();
      await assert.rejects(first, /connection changed/);
      assert.equal(ui.connection.sessionId, 'second');
      assert.equal(credentials.length, 2);
      assert.deepEqual(saved.map((item) => (item as { sessionId: string }).sessionId), ['second', 'first']);
    } finally { release(); PersistentClient.prototype.call = originalCall; }
  });
});

describe('Server project startup safety', () => {
  it('opens a recreated path once with its current epoch while keeping the old document detached', async () => {
    const execute = boundary.commands.executeCommand; let discoveries = 0; const opened: unknown[][] = [];
    boundary.commands.executeCommand = (async (...args: unknown[]) => { opened.push(args); }) as typeof execute;
    const uri = { scheme: 'pair-vps', authority: 'session', path: '/book.ipynb', toString: () => 'pair-vps://session/book.ipynb', with: (change: unknown) => ({ ...uri, ...change as object }) };
    const ui = Object.assign(Object.create(PersistentSessionController.prototype), {
      connection: { sessionId: 'session', client: { call: async () => { discoveries++; return { epoch: 'new-epoch' }; } } },
      notebookOpenings: new Map(), currentNotebookUris: new Map(), notebookSync: { isRetired: () => true },
    }) as any;
    try {
      await Promise.all([ui.openCurrentNotebook(uri), ui.openCurrentNotebook(uri), ui.openCurrentNotebook({ ...uri, query: 'old-epoch' })]);
      assert.equal(discoveries, 1); assert.equal(opened.length, 1); assert.equal(opened[0]![0], 'vscode.openWith');
      assert.equal((opened[0]![1] as { query: string }).query, 'pairNotebookEpoch=new-epoch');
    } finally { boundary.commands.executeCommand = execute; }
  });
  it('keeps the provider registered through reconnect and readonly changes', () => {
    const original = boundary.workspace.registerFileSystemProvider; let registrations = 0; let disposals = 0;
    boundary.workspace.registerFileSystemProvider = () => { registrations++; return { dispose: () => { disposals++; } }; };
    const ui = Object.assign(Object.create(PersistentSessionController.prototype), { files: {} }) as any;
    try {
      ui.setFilesReadonly(true); ui.setFilesReadonly(false); ui.setFilesReadonly(true); ui.setFilesReadonly(false);
      assert.equal(registrations, 1); assert.equal(disposals, 0); assert.equal(ui.files.readonlyFiles, false);
    } finally { boundary.workspace.registerFileSystemProvider = original; }
  });
  for (const status of [401, 403, 404, 426]) it(`isolates notebook HTTP ${status} while preserving project authentication checks`, async () => {
    let leaves = 0; let refreshed = false;
    const connection = { sessionId: 'project' };
    const view = { consents: [], collaborationRevision: 1 };
    const ui = Object.assign(Object.create(PersistentSessionController.prototype), {
      connection, disposed: false, polling: false, commentsRevision: 1,
      rpc: async () => view, files: { refresh: async () => { refreshed = true; } },
      notebookSync: { flush: async () => { throw new PersistentHttpError(status); } },
      leave: async () => { leaves++; }, connectionProblem: () => undefined, updateUi: () => undefined,
      log: { appendLine: () => undefined },
    }) as any;
    const documents = boundary.workspace.notebookDocuments;
    boundary.workspace.notebookDocuments = [{}] as vscode.NotebookDocument[];
    try { await ui.poll(); assert(refreshed); assert.equal(leaves, [403, 404].includes(status) ? 0 : 1); }
    finally { boundary.workspace.notebookDocuments = documents; }
  });
  it('restores a saved file URI before reading its remote bytes', async () => {
    const files = new PersistentFileSystem();
    const uri = { scheme: 'pair-vps', authority: 'project', path: '/test.ipynb' } as vscode.Uri;
    let release!: () => void; let reads = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    files.restore = async requested => {
      assert.equal(requested, uri); await gate;
      files.setConnection({ endpoint: 'https://example.com', sessionId: 'project', memberId: 'owner', name: 'Project', client: {
        call: async () => { reads++; return { content: Buffer.from('preserved notebook').toString('base64'), revision: 1 }; },
      } } as never);
    };
    const reading = files.readFile(uri); assert.equal(reads, 0); release();
    assert.equal(Buffer.from(await reading).toString(), 'preserved notebook'); assert.equal(reads, 1);
    files.dispose();
  });
  it('waits for local notebook and text journals before detaching a project', async () => {
    let release!: () => void; let saved = false;
    const journal = new Promise<void>(resolve => { release = () => { saved = true; resolve(); }; });
    const connection = { endpoint: 'https://example.com', sessionId: 'project', memberId: 'owner', name: 'Project', client: { call: async () => undefined } };
    const ui = Object.assign(Object.create(PersistentSessionController.prototype), {
      connection, context: { globalState: { get: () => [], update: async () => undefined } },
      notebookSync: { checkpoint: () => journal, reset: () => { assert(saved); } },
      textSync: { checkpoint: () => journal, reset: () => { assert(saved); } },
      files: { setConnection: () => undefined }, status: { hide: () => undefined }, changed: { fire: () => undefined },
    }) as { leave: () => Promise<void>; connection?: unknown };
    const leaving = ui.leave(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(ui.connection, connection); release(); await leaving; assert.equal(ui.connection, undefined);
  });
  it('blocks incompatible attachment before mounting files or announcing readiness', async () => {
    const original = PersistentClient.prototype.checkCompatibility;
    let mounts = 0; const messages = informationMessages.length;
    PersistentClient.prototype.checkCompatibility = async () => { throw new PersistentHttpError(426); };
    const ui = Object.assign(Object.create(PersistentSessionController.prototype), {
      disposed: false, connectionAttempt: 0,
      files: { setConnection: () => { mounts++; } },
    }) as { attach: (saved: unknown, token: string) => Promise<void> };
    try {
      await assert.rejects(ui.attach({ endpoint: 'https://example.com', sessionId: 'project', memberId: 'owner', name: 'Saved project' }, 'a'.repeat(40)), /incompatible/);
      assert.equal(mounts, 0); assert.equal(informationMessages.length, messages);
    } finally { PersistentClient.prototype.checkCompatibility = original; }
  });
  it('persists explicit leave for only that identity without deleting credentials or server project data', async () => {
    const first = { endpoint: 'https://example.com', sessionId: 'first', memberId: 'owner', name: 'First' };
    const second = { ...first, sessionId: 'second', name: 'Second' };
    let saved = [first, second] as (typeof first & { autoConnect?: boolean })[];
    const operations: string[] = [];
    const ui = Object.assign(Object.create(PersistentSessionController.prototype), {
      connection: { ...first, client: { call: async (operation: string) => { operations.push(operation); } } },
      context: { globalState: { get: () => saved, update: async (_key: string, value: typeof saved) => { saved = value; } }, secrets: { delete: () => { throw new Error('Credentials must survive Leave'); } } },
      files: { setConnection: () => undefined }, status: { hide: () => undefined }, changed: { fire: () => undefined },
    }) as { leave: () => Promise<void> };
    await ui.leave();
    assert.equal(saved[0]!.autoConnect, false); assert.equal(saved[1]!.autoConnect, undefined);
    assert.deepEqual(operations, ['leave']);
  });
});

describe('Persistent notebook kernel lifecycle UI', () => {
  beforeEach(() => {
    informationMessages.length = 0;
    warningChoice = undefined;
    boundary.window.activeNotebookEditor = { notebook: { uri: { scheme: 'pair-vps', authority: 'session', path: '/test.ipynb' } as vscode.Uri } };
  });
  afterEach(() => { boundary.window.activeNotebookEditor = undefined; });
  const execution = (state: PersistentExecution['state']): PersistentExecution => ({
    id: 'kernel-control', requesterId: 'member', notebook: 'test.ipynb', cellIndex: 0,
    deviceId: 'device', generation: 1, state, events: [],
  });
  function controller(call: (operation: string, input: Record<string, unknown>) => Promise<unknown>): InstanceType<typeof PersistentSessionController> {
    return Object.assign(Object.create(PersistentSessionController.prototype) as InstanceType<typeof PersistentSessionController>, {
      connection: { endpoint: 'https://example.com', sessionId: 'session', memberId: 'member', name: 'Test', client: { call } },
      executions: new Map(), disposed: false,
    });
  }
  it('queues release for the active notebook and reports success only after the server completes it', async () => {
    warningChoice = 'Release kernel';
    const calls: { operation: string; input: Record<string, unknown> }[] = [];
    const ui = controller(async (operation, input) => {
      calls.push({ operation, input });
      assert.deepEqual(informationMessages, [], 'Queued control must not be reported as completed.');
      return execution(operation === 'kernel' ? 'queued' : 'completed');
    });
    await ui.releaseKernel();
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.operation, 'kernel');
    assert.deepEqual({ ...calls[0]!.input, requestId: 'uuid' }, { sessionId: 'session', notebook: 'test.ipynb', command: 'release', requestId: 'uuid' });
    assert.match(String(calls[0]!.input.requestId), /^[a-f0-9-]{36}$/);
    assert.equal(calls[1]?.operation, 'execution');
    assert.match(informationMessages[0]!, /kernel released/);
    assert.match(informationMessages[0]!, /saved cell outputs remain/);
  });
  it('waits for restart completion and surfaces kernel failures without reporting success', async () => {
    warningChoice = 'Restart kernel';
    const states: PersistentExecution['state'][] = ['queued', 'failed'];
    const ui = controller(async () => ({ ...execution(states.shift()!), error: 'Compute device unavailable' }));
    await assert.rejects(ui.restartKernel(), /Compute device unavailable/);
    assert.deepEqual(informationMessages, []);
  });
  it('rejects a kernel command for a notebook from another session', async () => {
    warningChoice = 'Release kernel';
    boundary.window.activeNotebookEditor!.notebook.uri = { scheme: 'pair-vps', authority: 'other-session', path: '/test.ipynb' } as vscode.Uri;
    let called = false;
    const ui = controller(async () => { called = true; return execution('completed'); });
    await assert.rejects(ui.releaseKernel(), /connected server project/);
    assert.equal(called, false);
  });
  it('does not report success in another session after switching connections during submission', async () => {
    warningChoice = 'Release kernel';
    const ui = controller(async () => {
      Object.assign(ui, { connection: undefined });
      return execution('completed');
    });
    await assert.rejects(ui.releaseKernel(), /accepted in the previous session.*kernel-control/);
    assert.deepEqual(informationMessages, []);
  });
});

describe('Output-only notebook three-way reconciliation', () => {
  const code = (source: unknown, outputs: unknown[] = [], count: number | null = null) => ({ id: 'stable-cell', cell_type: 'code', metadata: { trusted: false }, source, outputs, execution_count: count });
  const bytes = (cell: Record<string, unknown>) => Buffer.from(JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: 'python3' } }, cells: [cell] }));
  const stream = (value: unknown) => ({ output_type: 'stream', name: 'stdout', text: value });
  it('accepts the same real execution outputs from the editor and server, including nbformat text array normalization', () => {
    const baseline = bytes(code(['value = 42\n', 'print(value)']));
    const local = bytes(code('value = 42\nprint(value)', [stream('42\n')], 1));
    const latest = bytes(code('value = 42\nprint(value)', [stream(['42', '\n'])], 1));
    const merged = mergePersistentNotebookOutputs(baseline, local, latest);
    assert.ok(merged, 'A normal repeated cell save must not conflict on its own persisted outputs.');
    assert.equal(JSON.parse(Buffer.from(merged).toString()).cells[0].execution_count, 1);
  });
  it('preserves a remote output change while applying local source edits with unchanged local outputs', () => {
    const baseline = bytes(code('print(1)'));
    const local = bytes(code('print(2)'));
    const latest = bytes(code('print(1)', [stream('1\n')], 1));
    const merged = mergePersistentNotebookOutputs(baseline, local, latest);
    assert.ok(merged);
    const cell = JSON.parse(Buffer.from(merged).toString()).cells[0];
    assert.equal(cell.source, 'print(2)');
    assert.deepEqual(cell.outputs, [stream('1\n')]);
  });
  it('rejects remote source and metadata edits even if local changes only execution outputs', () => {
    const baseline = bytes(code('print(1)'));
    const local = bytes(code('print(1)', [stream('1\n')], 1));
    assert.equal(mergePersistentNotebookOutputs(baseline, local, bytes(code('print("collaborator")'))), undefined);
    assert.equal(mergePersistentNotebookOutputs(baseline, local, bytes({ ...code('print(1)'), metadata: { trusted: true } })), undefined);
  });
  it('rejects different simultaneous local and remote output changes', () => {
    const baseline = bytes(code('print(value)'));
    const local = bytes(code('print(value)', [stream('first kernel\n')], 1));
    const latest = bytes(code('print(value)', [stream('another kernel\n')], 1));
    assert.equal(mergePersistentNotebookOutputs(baseline, local, latest), undefined);
  });
});
