import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'mocha';
import type * as vscode from 'vscode';
import type { SessionRuntime } from '../src/runtime/session';
import { VpsServer } from '../src/vps/server';
import { VpsClient, VpsHttpError } from '../src/vps/client';
import { type JobSubmission, MAX_JOB_BYTES, safeJobPath, validateSubmission, vpsSecretKey } from '../src/vps/protocol';
import { trainingProgram, trainingHelper, trainingData, torchPython, torchDatasetSetup, torchTrainingProgram } from './support/modelTraining';

let root: string;
let endpoint = '';
let trusted = true;
let runtime: any;
let editor: any;
let notebook: any;
let documents: any[] = [];
let workspaceFolders: any[] | undefined;
let pick: (items: any[], options: any) => Promise<any>;
let output = '';
let secretRead: ((key: string) => Promise<string | undefined>) | undefined;
const configurationListeners = new Set<(event: any) => void>();
const secrets = new Map<string, string>();
const state = new Map<string, unknown>();
const disposable = () => ({ dispose: () => undefined });
const boundary = {
  TreeItem: class { public constructor(public label: string) {} },
  TreeItemCollapsibleState: { Expanded: 2, None: 0 },
  ThemeIcon: class { public constructor(public id: string) {} },
  NotebookCellKind: { Code: 2 }, ConfigurationTarget: { Global: 1 },
  EventEmitter: class { public event = () => disposable(); public fire(): void {} public dispose(): void {} },
  workspace: {
    get isTrusted() { return trusted; }, get textDocuments() { return documents; },
    get workspaceFolders() { return workspaceFolders; },
    getConfiguration: () => ({ get: () => endpoint, update: async (_key: string, value: string) => { endpoint = value; } }),
    onDidChangeConfiguration: (callback: (event: any) => void) => { configurationListeners.add(callback); return { dispose: () => configurationListeners.delete(callback) }; },
  },
  window: {
    get activeNotebookEditor() { return notebook; }, get activeTextEditor() { return editor; },
    createTreeView: () => ({ visible: true, dispose: () => undefined }),
    createOutputChannel: () => ({ clear: () => { output = ''; }, show: () => undefined,
      append: (value: string) => { output += value; }, appendLine: (value: string) => { output += value + '\n'; }, dispose: () => undefined }),
    showQuickPick: async (items: any[], options: any) => pick(items, options),
    showInformationMessage: async () => undefined,
  },
};
const loader = Module as typeof Module & { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = loader._load;
loader._load = function (request, parent, isMain): unknown {
  return request === 'vscode' ? boundary : originalLoad.call(this, request, parent, isMain);
};
// Only the unavailable VS Code boundary is substituted; source capture,
// receipt persistence, HTTP, and the broker are production implementations.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { VpsComputeController } = require('../src/vscode/vpsCompute') as typeof import('../src/vscode/vpsCompute');
loader._load = originalLoad;
let controller: InstanceType<typeof VpsComputeController>;
function makeController(): InstanceType<typeof VpsComputeController> {
  return new VpsComputeController({ globalStorageUri: { fsPath: path.join(root, 'private') },
    secrets: { get: async (key: string) => secretRead ? secretRead(key) : secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value); } },
    globalState: { get: (key: string) => state.get(key), update: async (key: string, value: unknown) => { state.set(key, value); } },
  } as unknown as vscode.ExtensionContext, () => runtime as SessionRuntime | undefined);
}
async function setup(): Promise<void> {
  root = await mkdtemp(path.join(os.tmpdir(), 'pair-vps-ui-'));
  endpoint = ''; trusted = true; runtime = undefined; notebook = undefined; documents = [];
  workspaceFolders = undefined;
  secrets.clear(); state.clear(); output = ''; secretRead = undefined;
  editor = { document: { uri: { scheme: 'file', fsPath: path.join(root, 'train.py') }, getText: () => 'print("original")' } };
  pick = async (items) => items[0];
  controller = makeController();
}
async function teardown(): Promise<void> { controller.dispose(); await rm(root, { recursive: true, force: true }); }

describe('VPS project input resources', () => {
  beforeEach(setup); afterEach(teardown);
  it('includes canonical project config and data while excluding credential files', async () => {
    const project = new Map([['helper.py', 'VALUE=1'], ['config.json', '{"epochs":40}'], ['data.csv', 'x,y\n1,3'], ['.env', 'PRIVATE=secret']]);
    runtime = { descriptor: { workingFolder: root }, project: { keys: () => project.keys(), kindOf: () => 'text', text: (key: string) => project.get(key) } };
    const snapshot = await (controller as any).sourceSnapshot();
    assert.equal(snapshot.files['config.json'], '{"epochs":40}');
    assert.equal(snapshot.files['data.csv'], 'x,y\n1,3');
    assert.equal(snapshot.files['.env'], undefined);
  });
  it('snapshots standalone repository dependencies and overlays unsaved modules after disk reads', async () => {
    await mkdir(path.join(root, 'experiments'));
    await writeFile(path.join(root, 'helper.py'), 'VALUE=1');
    await writeFile(path.join(root, 'config.json'), '{"epochs":40}');
    await writeFile(path.join(root, '.env'), 'PRIVATE=secret');
    editor = { document: { uri: { scheme: 'file', fsPath: path.join(root, 'experiments', 'train.py') }, getText: () => 'from helper import VALUE' } };
    workspaceFolders = [{ uri: { fsPath: root } }];
    documents = [{ uri: { scheme: 'file', fsPath: path.join(root, 'helper.py') }, isDirty: true, getText: () => 'VALUE=2' }];
    const snapshot = await (controller as any).sourceSnapshot();
    assert.equal(snapshot.entrypoint, 'experiments/train.py');
    assert.equal(snapshot.files['helper.py'], 'VALUE=2');
    assert.equal(snapshot.files['config.json'], '{"epochs":40}');
    assert.equal(snapshot.files['.env'], undefined);
  });
});

describe('Stage 64 — source snapshot, dialog cancellation and concurrent edit combinations', () => {
  beforeEach(setup); afterEach(teardown);
  for (let mask = 0; mask < 64; mask++) {
    it(`case ${mask}: captures one current snapshot after dialogs, or aborts safely`, async () => {
      let helper = 'VALUE=1';
      const project = new Map([['helper.py', helper]]);
      runtime = { descriptor: { workingFolder: root }, project: {
        keys: () => project.keys(), kindOf: () => 'text', text: (key: string) => ({ get length() { return project.get(key)!.length; }, toString: () => project.get(key)! }),
      } };
      if (mask & 2) documents = [{ uri: { scheme: 'file', fsPath: path.join(root, 'helper.py') }, isDirty: true, getText: () => helper }];
      const cells = ['print("first")', 'print("second")'].map((code) => ({ kind: 2, document: { languageId: 'python', getText: () => code } }));
      notebook = { notebook: { uri: { scheme: 'file', fsPath: path.join(root, 'train.ipynb') }, getCells: () => cells, cellAt: (index: number) => cells[index] }, selection: { start: 1 } };
      pick = async (items) => {
        if (mask & 4) { project.set('helper.py', 'VALUE=2'); helper = 'VALUE=3'; }
        if (mask & 16) runtime = undefined;
        if (mask & 32) project.set('huge.py', 'x'.repeat(MAX_JOB_BYTES + 1));
        return mask & 8 ? undefined : items[mask & 1 ? 1 : 0];
      };
      const capture = () => (controller as unknown as { sourceSnapshot(): Promise<Pick<JobSubmission, 'entrypoint' | 'files'> | undefined> }).sourceSnapshot();
      if ((mask & 8) === 0 && (mask & 48)) { await assert.rejects(capture()); return; }
      const snapshot = await capture();
      if (mask & 8) { assert.equal(snapshot, undefined); return; }
      assert.ok(snapshot);
      assert.equal(snapshot.files['helper.py'], mask & 2 ? helper : mask & 4 ? 'VALUE=2' : 'VALUE=1');
      assert.equal(snapshot.files[snapshot.entrypoint], mask & 1 ? 'print("second")' : 'print("first")\n\nprint("second")');
    });
  }
});

describe('Round 2 Stage 64 — portable notebook names and mixed-cell snapshots', () => {
  beforeEach(setup); afterEach(teardown);
  for (let mask = 0; mask < 64; mask++) {
    it(`case ${mask}: a valid original notebook always produces a valid Python entrypoint`, async () => {
      const stem = mask & 1 ? (mask & 2 ? '学'.repeat(80) : 't'.repeat(240)) : (mask & 2 ? '学習' : 'train');
      const relative = `${mask & 4 ? 'pkg/' : ''}${stem}.ipynb`;
      const project = new Map([['helper.py', 'VALUE=1']]);
      runtime = { descriptor: { workingFolder: root }, project: { keys: () => project.keys(), kindOf: () => 'text',
        text: (key: string) => ({ length: project.get(key)!.length, toString: () => project.get(key)! }) } };
      if (mask & 16) documents = [{ uri: { scheme: 'file', fsPath: path.join(root, 'helper.py') }, isDirty: true, getText: () => 'VALUE=2' }];
      const cells = [{ kind: 2, document: { languageId: 'python', getText: () => 'print("first")' } },
        ...(mask & 32 ? [{ kind: 2, document: { languageId: 'javascript', getText: () => 'throw Error("not python")' } }] : []),
        { kind: 2, document: { languageId: 'python', getText: () => 'print("second")' } }];
      notebook = { notebook: { uri: { scheme: 'file', fsPath: path.join(root, relative) }, getCells: () => cells, cellAt: (index: number) => cells[index] }, selection: { start: cells.length - 1 } };
      pick = async (items) => items[mask & 8 ? 1 : 0];
      const snapshot = await (controller as any).sourceSnapshot();
      assert.ok(safeJobPath(snapshot.entrypoint), 'Generated Python filename must respect the 255-byte portable limit');
      const job = validateSubmission({ id: 'portable', agentId: 'pc', title: 'Training', device: 'cpu', args: [], ...snapshot });
      assert.equal(job.files['helper.py'], mask & 16 ? 'VALUE=2' : 'VALUE=1');
      assert.equal(job.files[job.entrypoint], mask & 8 ? 'print("second")' : 'print("first")\n\nprint("second")');
      assert.equal(job.entrypoint.startsWith('pkg/'), !!(mask & 4));
    });
  }
});

describe('Round 2 output selection regressions', () => {
  beforeEach(setup); afterEach(teardown);
  it('keeps the latest selected job when earlier credential loading finishes late', async () => {
    endpoint = 'http://localhost:9999'; secrets.set(vpsSecretKey(endpoint), 'a'.repeat(32));
    let release!: (value: string) => void; let reads = 0;
    secretRead = async () => ++reads === 1 ? new Promise<string>((resolve) => { release = resolve; }) : 'a'.repeat(32);
    const original = VpsClient.prototype.job;
    VpsClient.prototype.job = async (id) => ({ id, title: id, agentId: 'pc', device: 'cpu', status: 'succeeded', exitCode: 0, logStart: 0, logEnd: 0, log: '' } as any);
    try {
      const earlier = controller.showJob('earlier'); await controller.showJob('latest'); release('a'.repeat(32)); await earlier;
      assert.match(output, /latest/); assert.doesNotMatch(output, /earlier/);
    } finally { VpsClient.prototype.job = original; }
  });
  for (const status of [401, 403, 404]) it(`stops polling HTTP ${status} with an actionable message`, async () => {
    endpoint = 'http://localhost:9999'; secrets.set(vpsSecretKey(endpoint), 'a'.repeat(32));
    const original = VpsClient.prototype.job;
    VpsClient.prototype.job = async () => { throw new VpsHttpError(status); };
    try { await controller.showJob('missing'); assert.equal((controller as any).logTimer, undefined); assert.match(output, status === 404 ? /not found/i : /Connect to VPS/i); }
    finally { VpsClient.prototype.job = original; }
  });
});

describe('VPS compute UI recovery and lifecycle regressions', () => {
  let broker: VpsServer;
  let client: VpsClient;
  const token = randomBytes(32).toString('hex');
  const agentToken = randomBytes(32).toString('hex');
  beforeEach(async () => {
    await setup();
    broker = new VpsServer({ dataDirectory: path.join(root, 'broker'), clientToken: token, agentTokens: { pc: agentToken } });
    endpoint = `http://127.0.0.1:${await broker.start()}`;
    secrets.set(vpsSecretKey(endpoint), token); client = new VpsClient(endpoint, token);
  });
  afterEach(async () => { controller.dispose(); await broker.stop(); await teardown(); });
  async function register(): Promise<void> {
    const response = await fetch(endpoint + '/v1/agents/pc/poll', { method: 'POST', headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId: 'pc-installation', name: 'Compute PC', resources: { cpuCount: 4, python: 'python3', gpus: [] } }) });
    assert.equal(response.status, 200); await response.arrayBuffer();
  }
  for (const useTorch of [false, true]) it(`trains ${useTorch ? 'PyTorch with binary owner data' : 'from a real repository snapshot'}, reloads a model and recovers after the editor and VPS stop`, async function () {
    this.timeout(20_000);
    const pythonPath = useTorch ? torchPython : 'python3';
    if (useTorch && spawnSync(pythonPath, ['-c', "import importlib.util; raise SystemExit(0 if importlib.util.find_spec('torch') else 1)"]).status !== 0) this.skip();
    const repository = path.join(root, 'repository');
    await mkdir(path.join(repository, 'experiments'), { recursive: true });
    const dataset = useTorch ? '.git/dataset.pt' : 'data.csv';
    if (useTorch) {
      await mkdir(path.join(repository, '.git'));
      const setup = spawnSync(pythonPath, ['-c', torchDatasetSetup, path.join(repository, dataset)], { encoding: 'utf8' });
      assert.equal(setup.status, 0, setup.stderr);
    }
    await writeFile(path.join(repository, 'config.json'), JSON.stringify({ dataset, delay: 0.8 }));
    await writeFile(path.join(repository, 'data.csv'), trainingData);
    await writeFile(path.join(repository, 'training_helpers.py'), 'raise RuntimeError("stale disk module")');
    workspaceFolders = [{ uri: { fsPath: repository } }];
    editor = { document: { uri: { scheme: 'file', fsPath: path.join(repository, 'experiments', 'train.py') }, getText: () => useTorch ? torchTrainingProgram : trainingProgram } };
    documents = [{ uri: { scheme: 'file', fsPath: path.join(repository, 'training_helpers.py') }, isDirty: true, getText: () => trainingHelper }];
    let daemon: ChildProcess | undefined;
    const until = async (check: () => Promise<boolean>): Promise<void> => {
      const end = Date.now() + 8000;
      while (!await check()) { if (Date.now() > end) assert.fail('Model pipeline did not complete'); await new Promise((resolve) => setTimeout(resolve, 25)); }
    };
    try {
      daemon = spawn(pythonPath, [path.resolve('scripts/pair-notebook-agent.py'), '--url', endpoint, '--id', 'pc',
        '--state', path.join(root, 'agent'), '--workspace', repository, '--poll-seconds', '0.1'],
      { env: { ...process.env, PAIR_AGENT_TOKEN: agentToken, NO_PROXY: '127.0.0.1,localhost' }, stdio: 'ignore' });
      await until(async () => (await client.agents()).length === 1);
      await controller.submit();
      const submitted = (await client.jobs())[0]!;
      const work = path.join(root, 'agent', 'jobs', submitted.id, 'work');
      await until(async () => Buffer.from((await client.job(submitted.id)).log, 'base64').toString().includes('TRAINING_STARTED'));
      controller.dispose();
      await broker.stop();
      await until(async () => { try { await readFile(path.join(work, 'checkpoints', 'model.json')); return true; } catch { return false; } });
      const model = JSON.parse(await readFile(path.join(work, 'checkpoints', 'model.json'), 'utf8'));
      assert.equal(model.epochs, useTorch ? 100 : 400);
      if (useTorch) {
        assert.equal(model.backend, 'pytorch'); assert.equal(model.steps, 300);
        assert.equal(model.checkpoint_reloaded, true); assert.equal(model.optimizer_state_reloaded, true);
        assert.ok(model.mse < 1e-10);
        assert.ok((await readFile(path.join(work, 'checkpoints', 'model.pt'))).byteLength > 0);
        await assert.rejects(readFile(path.join(work, dataset)), { code: 'ENOENT' });
      }
      assert.ok(Math.abs(model.weights[0] * 3 + model.weights[1] - 7) < 1e-4);
      const port = Number(new URL(endpoint).port);
      broker = new VpsServer({ dataDirectory: path.join(root, 'broker'), clientToken: token, agentTokens: { pc: agentToken } });
      await broker.start(port);
      await until(async () => (await client.job(submitted.id)).status === 'succeeded');
      const completed = await client.job(submitted.id);
      assert.match(Buffer.from(completed.log, 'base64').toString(), /"mse"/);
      assert.equal((await client.jobs()).length, 1);
    } finally {
      if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
        const exit = new Promise<void>((resolve) => daemon!.once('exit', () => resolve())); daemon.kill('SIGTERM'); await exit;
      }
    }
  });
  it('truncates a long job title without splitting a Unicode code point', async () => {
    await register();
    editor.document.uri.fsPath = path.join(root, 'a'.repeat(199) + '🧠.py');
    await controller.submit();
    const jobs = await client.jobs(); assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.title, 'a'.repeat(199));
  });
  it('retries the exact source and ID after an accepted request loses its response and the editor restarts', async () => {
    await register();
    const originalSubmit = VpsClient.prototype.submit;
    VpsClient.prototype.submit = async function (job) { await originalSubmit.call(this, job); throw new Error('Lost response'); };
    try { await assert.rejects(controller.submit(), /Could not confirm/); }
    finally { VpsClient.prototype.submit = originalSubmit; }
    const jobs = await client.jobs(); assert.equal(jobs.length, 1);
    controller.dispose(); controller = makeController();
    editor.document.getText = () => 'print("new edits must not replace the receipt")';
    pick = async () => { assert.fail('Recovery must not create a fresh selection or ID'); };
    await controller.submit();
    assert.equal((await client.jobs()).length, 1);
    const stored = JSON.parse(await readFile(path.join(root, 'broker', `${jobs[0]!.id}.json`), 'utf8'));
    assert.equal(stored.files['train.py'], 'print("original")');
  });
  it('blocks double-click submissions while selection is in progress', async () => {
    await register();
    let release!: () => void;
    let entered!: () => void;
    const selecting = new Promise<void>((resolve) => { entered = resolve; });
    pick = async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); return undefined; };
    const first = controller.submit(); await selecting;
    await assert.rejects(controller.submit(), /already in progress/);
    release(); await first; assert.equal((await client.jobs()).length, 0);
  });
  it('rejects a configuration change during selection before saving or sending code', async () => {
    await register(); pick = async (items) => { endpoint = 'https://changed.example'; return items[0]; };
    await assert.rejects(controller.submit(), /configuration changed/);
    assert.equal((await client.jobs()).length, 0);
  });
  it('shows setup and empty-job guidance and an actionable credential error', async () => {
    const groups = await controller.getChildren();
    assert.match(String((await controller.getChildren(groups[0]))[0]!.label), /Start the compute agent/);
    assert.match(String((await controller.getChildren(groups[1]))[0]!.label), /No background jobs/);
    secrets.set(vpsSecretKey(endpoint), randomBytes(32).toString('hex'));
    const denied = (await controller.getChildren(groups[0]))[0]!;
    assert.equal(denied.command!.command, 'pairNotebook.connectVps');
  });
  it('prevents execution in an untrusted workspace', async () => {
    trusted = false; await assert.rejects(controller.submit(), /Trust this workspace/);
    assert.equal((await client.jobs()).length, 0);
  });
  it('discards a late log response when the configured endpoint changes', async () => {
    await client.submit({ id: 'log-watch', agentId: 'pc', title: 'train', device: 'cpu', entrypoint: 'train.py', files: { 'train.py': '' }, args: [] });
    const original = VpsClient.prototype.job;
    let release!: (job: Awaited<ReturnType<VpsClient['job']>>) => void;
    VpsClient.prototype.job = () => new Promise((resolve) => { release = resolve; });
    try {
      const watch = controller.showJob('log-watch');
      await new Promise((resolve) => setImmediate(resolve));
      for (const callback of configurationListeners) callback({ affectsConfiguration: (key: string) => key === 'pairNotebook.vpsUrl' });
      release(await original.call(client, 'log-watch'));
      await watch; assert.equal(output, '');
    } finally { VpsClient.prototype.job = original; }
  });
});
