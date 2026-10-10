import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { JupyterKernel } from '../src/core/pythonKernel';
import { SharedTerminal } from '../src/core/sharedTerminal';
import type { SessionDescriptor } from '../src/core/types';

// Substitute the VS Code host API only. Restore the module cache so this
// boundary never becomes another integration test's VS Code implementation.
const moduleLoader = Module as typeof Module & { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleLoader._load;
const sessionPath = require.resolve('../src/runtime/session');
const cachedSession = require.cache[sessionPath];
const previouslyCachedModules = new Set(Object.keys(require.cache));
const productionSourceRoot = path.resolve(path.dirname(sessionPath), '..');
delete require.cache[sessionPath];
let typedValue: string | undefined;
let promptCount = 0;
const fakeVscode = {
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
  commands: { executeCommand: async () => undefined },
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
  window: { showInputBox: async (options: { value: string }) => {
    assert.equal(options.value, '', 'confirmation must start empty'); promptCount++; return typedValue;
  } },
};
moduleLoader._load = function load(request, parent, isMain) {
  return request === 'vscode' ? fakeVscode : originalLoad.call(this, request, parent, isMain);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SessionRuntime } = require('../src/runtime/session') as { SessionRuntime: new (...args: any[]) => any };
moduleLoader._load = originalLoad;
// The runtime loads output rendering helpers which also capture VS Code.
// Remove every newly loaded production dependency, preserving pre-existing
// modules, so later integration suites load their own complete VS Code API.
for (const cachedPath of Object.keys(require.cache)) {
  if (cachedPath.startsWith(productionSourceRoot + path.sep) && !previouslyCachedModules.has(cachedPath)) {
    delete require.cache[cachedPath];
  }
}
delete require.cache[sessionPath];
if (cachedSession) require.cache[sessionPath] = cachedSession;

function runtime(folder: string, peerId = 'host'): any {
  const descriptor: SessionDescriptor = {
    sessionId: 'interactive-stop', projectId: 'project', projectName: 'Experiment', mode: 'resilient',
    role: peerId === 'host' ? 'host' : 'peer', localPeer: { peerId, displayName: peerId, joinOrder: peerId === 'host' ? 0 : 1 },
    hostPeerId: 'host', backingFolder: peerId === 'host' ? folder : '', workingFolder: `${folder}-working`,
    createdAt: Date.now(), sessionEpoch: 1, hostEpoch: 0, computeExecutorId: 'host', pythonPath: 'python3',
  };
  return new SessionRuntime(descriptor, 'interactive-stop-token-that-is-long-enough',
    { extensionUri: { fsPath: process.cwd() } }, { appendLine: () => undefined });
}
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const status = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return !/^\s*[ZX]/.test(status.slice(status.lastIndexOf(')') + 1));
    }
    return true;
  } catch { return false; }
}
async function until(check: () => boolean | Promise<boolean>, budget = 5000): Promise<void> {
  const deadline = Date.now() + budget;
  while (!(await check())) {
    if (Date.now() >= deadline) assert.fail('Expected process or execution transition timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function reserve(host: any, runId = 'run-a', owner = 'host'): { stops: () => number } {
  let stops = 0;
  host.executionOwners.set(runId, { peerId: owner, notebookKey: 'train.ipynb', accepted: true, startedAt: Date.now() });
  host.kernels.set('train.ipynb', { stopConfirmed: async () => { stops++; host.executionOwners.delete(runId); }, stop: () => undefined });
  return { stops: () => stops };
}

describe('interactive executor-issued CONFIRM protection', () => {
  it('leaves running work untouched on empty, wrong-case, extra-character and dismissed dialogs', async () => {
    const host = runtime('/tmp/interactive-confirm-ui'); const operation = reserve(host);
    try {
      for (typedValue of [undefined, '', 'confirm', 'Confirm', 'CONFIRM ', ' CONFIRM', 'CONFIRM\n']) {
        assert.equal(await host.confirmOperation('interrupt', 'train.ipynb'), false);
        assert.equal(operation.stops(), 0);
      }
      typedValue = 'CONFIRM';
      assert.equal(await host.confirmOperation('interrupt', 'train.ipynb'), true);
      assert.equal(operation.stops(), 1);
      assert.equal(promptCount, 8);
    } finally { await host.disposeAsync(); }
  });

  it('checks identity, scope, action, expiry, authority and exact value, then applies once', async () => {
    const host = runtime('/tmp/interactive-confirm-api'); const operation = reserve(host);
    try {
      const challenge = await host.requestExecutionStop('interrupt', 'train.ipynb');
      await assert.rejects(host.applyExecutionStop(challenge, true), /Exact typed CONFIRM/);
      await assert.rejects(host.applyIssuedExecutionStop(challenge.id, 'CONFIRM', 'intruder', 'interrupt', 'train.ipynb'), /identity/);
      await assert.rejects(host.applyIssuedExecutionStop(challenge.id, 'CONFIRM', 'host', 'restart', 'train.ipynb'), /action/);
      await assert.rejects(host.applyIssuedExecutionStop(challenge.id, 'CONFIRM', 'host', 'interrupt', 'other.ipynb'), /scope/);
      host.executionStopChallenges.get(challenge.id).challenge.expiresAt = Date.now() - 1;
      await assert.rejects(host.applyExecutionStop(challenge, 'CONFIRM'), /expired/);
      const authority = await host.requestExecutionStop('interrupt', 'train.ipynb');
      host.executionStopChallenges.get(authority.id).challenge.authority.hostEpoch++;
      await assert.rejects(host.applyExecutionStop(authority, 'CONFIRM'), /authority/);
      const valid = await host.requestExecutionStop('interrupt', 'train.ipynb');
      await Promise.all([host.applyExecutionStop(valid, 'CONFIRM'), host.applyExecutionStop(valid, 'CONFIRM')]);
      assert.equal(operation.stops(), 1);
      await host.applyExecutionStop(valid, 'CONFIRM');
      assert.equal(operation.stops(), 1);
    } finally { await host.disposeAsync(); }
  });

  it('rejects old run confirmations and guests attempting a whole-session stop', async () => {
    const host = runtime('/tmp/interactive-confirm-race'); reserve(host);
    const guest = runtime('/tmp/interactive-confirm-guest', 'guest');
    try {
      const challenge = await host.requestExecutionStop('interrupt', 'train.ipynb');
      host.executionOwners.delete('run-a');
      const replacement = reserve(host, 'run-b');
      await assert.rejects(host.applyExecutionStop(challenge, 'CONFIRM'), /executions changed/);
      assert.equal(replacement.stops(), 0);
      await assert.rejects(guest.requestExecutionStop('stop-session'), /Only the current host/);
      assert.throws(() => host.issueExecutionStop('interrupt', 'train.ipynb', 'guest'), /belong/);
      host.executionOwners.clear();
    } finally { await Promise.all([host.disposeAsync(), guest.disposeAsync()]); }
  });

  for (const action of ['interrupt', 'restart'] as const) {
    it(`rejects a stale ${action} scope when the accepted run's notebook is renamed during confirmation`, async () => {
      const host = runtime(`/tmp/interactive-confirm-rename-${action}`); const operation = reserve(host);
      try {
        const challenge = await host.requestExecutionStop(action, 'train.ipynb');
        host.renameNotebookRuntimeState('train.ipynb', 'renamed.ipynb');
        assert.equal(host.executionOwners.get('run-a').notebookKey, 'renamed.ipynb');
        assert.equal(host.kernels.has('renamed.ipynb'), true);
        await assert.rejects(host.applyExecutionStop(challenge, 'CONFIRM'), /Affected executions changed/);
        assert.equal(operation.stops(), 0, 'stale scope must not stop the renamed execution');
        assert.equal(host.executionOwners.has('run-a'), true);
      } finally { host.executionOwners.clear(); await host.disposeAsync(); }
    });
  }

  it('blocks direct interrupt/restart/leave/transfer calls while managed work exists', async () => {
    const host = runtime('/tmp/interactive-confirm-bypass'); const operation = reserve(host);
    try {
      await assert.rejects(host.interruptNotebook('train.ipynb'), /typed CONFIRM/);
      await assert.rejects(host.restartNotebook('train.ipynb'), /typed CONFIRM/);
      await assert.rejects(host.leave(), /typed CONFIRM/);
      await assert.rejects(host.endSession(), /typed CONFIRM/);
      await assert.rejects(host.transferHost('guest'), /typed CONFIRM/);
      assert.equal(operation.stops(), 0);
    } finally { host.executionOwners.clear(); await host.disposeAsync(); }
  });

  it('fences preparing work synchronously and leaves whole-session intake closed after confirmed stop', async () => {
    const host = runtime('/tmp/interactive-confirm-preparing');
    let release!: () => void;
    host.prepareWorkingCopy = () => new Promise<void>((resolve) => { release = resolve; });
    let beforePreparationFailure: unknown;
    const running = host.executeCell('train.ipynb', 'cell-a', 'print(1)', () => undefined);
    void running.catch((error: unknown) => { beforePreparationFailure = error; });
    const execution = assert.rejects(running, /confirmed.*stop|cancelled/i);
    try {
      await until(() => { if (beforePreparationFailure) throw beforePreparationFailure; return Boolean(release); });
      const challenge = await host.requestExecutionStop('stop-session');
      assert.equal(challenge.targets.length, 1, 'preparing runs are included before a kernel exists');
      const stopping = host.applyExecutionStop(challenge, 'CONFIRM');
      assert.equal(host.stopAllExecutions, true, 'fence must be synchronous with validation');
      release();
      await Promise.all([stopping, execution]);
      assert.equal(host.kernels.size, 0, 'cancelled preparation cannot launch a kernel');
      await assert.rejects(host.executeCell('train.ipynb', 'cell-b', 'print(2)', () => undefined), /Confirmed session stop/);
    } finally { release?.(); await host.disposeAsync(); }
  });

  it('does not authorize a new shell which appears while a session dialog is open', async () => {
    const host = runtime('/tmp/interactive-confirm-new-shell'); const operation = reserve(host);
    const challenge = await host.requestExecutionStop('stop-session');
    let terminalStops = 0;
    host.hostTerminal = { isRunning: () => true, executionGeneration: () => 'new-command',
      stopConfirmed: async () => { terminalStops++; }, dispose: () => undefined };
    try {
      await assert.rejects(host.applyExecutionStop(challenge, 'CONFIRM'), /Terminal execution changed/);
      assert.equal(terminalStops, 0);
      assert.equal(operation.stops(), 0);
    } finally { host.executionOwners.clear(); await host.disposeAsync(); }
  });

  it('retains active and completed replay ownership when the observer disconnects', async () => {
    const host = runtime('/tmp/interactive-confirm-observer'); const operation = reserve(host, 'run-a', 'guest');
    const expiryTimer = setTimeout(() => undefined, 60_000); expiryTimer.unref();
    host.completedRemoteExecutions.set('completed-run', { sourceId: 'guest', expiryTimer });
    host.installTransportHandlers();
    try {
      host.transport.emit('peerDisconnected', { peerId: 'guest', displayName: 'Guest', joinOrder: 1 });
      assert.equal(host.executionOwners.has('run-a'), true);
      assert.equal(host.completedRemoteExecutions.has('completed-run'), true);
      assert.equal(operation.stops(), 0);
    } finally { host.executionOwners.clear(); await host.disposeAsync(); }
  });

  it('keeps an already accepted observation pending through executor route loss', async () => {
    const guest = runtime('/tmp/interactive-confirm-observation', 'guest');
    let rejected = 0;
    guest.pendingExecutions.set('accepted-run', { executorId: 'host', accepted: true, reject: () => { rejected++; } });
    try {
      guest.cancelExecutorRequests('host', 'route disconnected');
      assert.equal(guest.pendingExecutions.has('accepted-run'), true);
      assert.equal(rejected, 0);
    } finally { guest.pendingExecutions.clear(); await guest.disposeAsync(); }
  });

  it('cancels a queued canonical-cell convergence wait as part of the same confirmation', async () => {
    const host = runtime('/tmp/interactive-confirm-convergence'); reserve(host);
    host.kernels.clear();
    host.executionOwners.get('run-a').accepted = false;
    const waiting = host.waitForAuthoritativeCellState({ notebookKey: 'train.ipynb', cellId: 'cell-a',
      executorId: 'host', computeEpoch: 0, cellRevision: 'missing', cellDigest: 'a'.repeat(64) }, 'run-a', 'host')
      .finally(() => { host.executionOwners.delete('run-a'); });
    const cancelled = assert.rejects(waiting, /cancelled by a confirmed stop/i);
    try {
      const challenge = await host.requestExecutionStop('interrupt', 'train.ipynb');
      await host.applyExecutionStop(challenge, 'CONFIRM');
      await cancelled;
      assert.equal(host.listenerCount('executionStop'), 0);
    } finally { host.executionOwners.clear(); await host.disposeAsync(); }
  });

  it('rejects a remote plain boolean interrupt and returns an authority-issued challenge', async () => {
    const host = runtime('/tmp/interactive-confirm-remote'); const operation = reserve(host, 'run-a', 'guest');
    const replies: any[] = [];
    host.transport = { broadcast: () => undefined, sendTo: (_peer: string, _type: string, meta: unknown) => { replies.push(meta); }, stop: async () => undefined };
    try {
      const target = host.computeForNotebook('train.ipynb');
      await host.handleKernelCommand({ type: 'kernelCommand', payload: new Uint8Array(), meta: {
        requestId: 'a'.repeat(32), notebookKey: 'train.ipynb', target, command: 'interrupt', confirmed: true,
      } }, 'guest');
      assert.equal(replies.at(-1).success, false);
      assert.equal(operation.stops(), 0);
      await host.handleKernelCommand({ type: 'kernelCommand', payload: new Uint8Array(), meta: {
        requestId: 'b'.repeat(32), notebookKey: 'train.ipynb', target, command: 'prepare-stop', action: 'interrupt',
      } }, 'guest');
      const challenge = replies.at(-1).challenge;
      assert.equal(challenge.initiatorId, 'guest');
      await host.handleKernelCommand({ type: 'kernelCommand', payload: new Uint8Array(), meta: {
        requestId: 'c'.repeat(32), notebookKey: 'train.ipynb', target, command: 'interrupt', proof: { challengeId: challenge.id, value: 'CONFIRM' },
      } }, 'guest');
      assert.equal(replies.at(-1).success, true);
      assert.equal(operation.stops(), 1);
    } finally { await host.disposeAsync(); }
  });
});

describe('confirmed interactive process tree stop with real filesystem/processes', () => {
  it('invalidates terminal consent on new command admission and stops redirected workers only after valid consent', async function () {
    if (process.platform === 'win32') this.skip();
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-terminal-confirm-'));
    const terminal = new SharedTerminal({ isHost: () => true, hostId: () => 'host', available: () => true,
      directory: () => root, prepare: async () => undefined, send: () => undefined });
    const unrelated = spawn('sleep', ['30'], { stdio: 'ignore' });
    let workerPid = 0;
    try {
      await terminal.execute('sleep 30 >/dev/null 2>&1 & echo $! > worker.pid');
      await until(async () => { try { workerPid = Number(await readFile(path.join(root, 'worker.pid'), 'utf8')); return workerPid > 0; } catch { return false; } });
      await assert.rejects(terminal.interrupt({ challengeId: 'unknown', value: true }), /Exact typed/);
      assert.equal(running(workerPid), true);
      const stale = terminal.requestInterrupt();
      await terminal.execute('printf READY');
      await assert.rejects(terminal.interrupt({ challengeId: stale.id, value: 'CONFIRM' }), /changed/);
      const valid = terminal.requestInterrupt();
      await Promise.all([terminal.interrupt({ challengeId: valid.id, value: 'CONFIRM' }), terminal.interrupt({ challengeId: valid.id, value: 'CONFIRM' })]);
      await until(() => !running(workerPid));
      assert.equal(running(unrelated.pid!), true);
    } finally { terminal.dispose(); unrelated.kill('SIGKILL'); if (workerPid && running(workerPid)) process.kill(workerPid, 'SIGKILL'); await rm(root, { recursive: true, force: true }); }
  });

  it('escalates a real Jupyter run which ignores interrupts and terminates its redirected worker', async function () {
    this.timeout(25_000);
    if (process.platform === 'win32') this.skip();
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-kernel-confirm-'));
    const python = process.env.PAIR_NOTEBOOK_TEST_PYTHON || 'python3';
    const kernel = new JupyterKernel(python, path.resolve('media/jupyter_kernel_bridge.py'), root);
    let workerPid = 0;
    try {
      await kernel.start();
      const execution = kernel.execute('confirmed-training', [
        'import signal, subprocess, time', 'from pathlib import Path',
        'signal.signal(signal.SIGINT, signal.SIG_IGN)', 'signal.signal(signal.SIGTERM, signal.SIG_IGN)',
        'worker = subprocess.Popen(["sleep", "30"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)',
        'Path("worker.pid").write_text(str(worker.pid))', 'while True: time.sleep(0.1)',
      ].join('\n'));
      const completed = execution.then(() => undefined, () => undefined);
      await until(async () => { try { workerPid = Number(await readFile(path.join(root, 'worker.pid'), 'utf8')); return workerPid > 0; } catch { return false; } }, 15_000);
      assert.equal(running(workerPid), true);
      await kernel.stopConfirmed();
      await completed;
      await until(() => !running(workerPid));
    } finally { await kernel.stopConfirmed(); if (workerPid && running(workerPid)) process.kill(workerPid, 'SIGKILL'); await rm(root, { recursive: true, force: true }); }
  });
});
