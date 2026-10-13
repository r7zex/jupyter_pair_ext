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
  NotebookCellKind: { Code: 2 },
  FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
  FileSystemError: { Unavailable: (message: string) => new Error(message), NoPermissions: (message: string) => new Error(message) },
  window: {
    activeNotebookEditor: undefined as { notebook: { uri: vscode.Uri } } | undefined,
    showWarningMessage: async () => warningChoice,
    showInformationMessage: async (message: string) => { informationMessages.push(message); },
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

describe('Persistent server file save conflicts', () => {
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
});

describe('Persistent notebook execution connection ownership', () => {
  type ExecutionUi = { execute: (cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument) => Promise<void>; connection: unknown };
  for (const phase of ['queue', 'save']) it(`does not submit old notebook cells to a new session after waiting for ${phase}`, async () => {
    let unblock!: () => void;
    const wait = new Promise<void>((resolve) => { unblock = resolve; });
    let saves = 0;
    const connection = { sessionId: 'original', client: { call: async () => { throw new Error('No RPC should be sent'); } } };
    const ui = Object.assign(Object.create(PersistentSessionController.prototype), {
      connection, notebookQueues: new Map(phase === 'queue' ? [['work.ipynb', wait]] : []), disposed: false,
    }) as ExecutionUi;
    const notebook = { uri: { scheme: 'pair-vps', authority: 'original', path: '/work.ipynb' }, save: async () => { saves++; await wait; return true; } } as unknown as vscode.NotebookDocument;
    const pending = ui.execute([], notebook);
    if (phase === 'save') { await Promise.resolve(); await Promise.resolve(); }
    ui.connection = { sessionId: 'replacement' };
    unblock();
    await assert.rejects(pending, /session changed/);
    assert.equal(saves, phase === 'queue' ? 0 : 1);
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
      context: { globalState: { update: async () => undefined } },
      notebook: { createNotebookCellExecution: () => handle },
      observe: async () => ({ state: 'completed' }),
    }) as ExecutionUi;
    const cell = { index: 0, kind: 2, document: { languageId: 'python', getText: () => 'print("displayed")' } } as unknown as vscode.NotebookCell;
    const notebook = { uri: { scheme: 'pair-vps', authority: 'original', path: '/work.ipynb' }, save: async () => true } as unknown as vscode.NotebookDocument;
    await ui.execute([cell], notebook);
    assert.equal(calls[0]?.sessionId, 'original');
    assert.equal(calls[0]?.expectedSourceHash, createHash('sha256').update('print("displayed")').digest('hex'));
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
    await assert.rejects(ui.releaseKernel(), /connected persistent VPS session/);
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
