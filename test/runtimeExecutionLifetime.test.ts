import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { SessionDescriptor } from '../src/core/types';
import type { WireFrame } from '../src/core/wire';

// Substitute only the unavailable VS Code APIs. Execution below uses the
// production session protocol and a real Jupyter bridge/kernel process.
const moduleWithLoader = Module as typeof Module & { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleWithLoader._load;
const fakeVscode = {
  workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
  commands: { executeCommand: async () => undefined },
  Uri: { joinPath: (base: { fsPath: string }, ...parts: string[]) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
};
moduleWithLoader._load = function load(request: string, parent: unknown, isMain: boolean): unknown {
  return request === 'vscode' ? fakeVscode : originalLoad.call(this, request, parent, isMain);
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SessionRuntime } = require('../src/runtime/session') as { SessionRuntime: new (...args: any[]) => any };
moduleWithLoader._load = originalLoad;

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function runtime(folder: string, role: 'host' | 'peer'): any {
  const localPeer = { peerId: role === 'host' ? 'host' : 'guest', displayName: role, joinOrder: role === 'host' ? 0 : 1 };
  const descriptor: SessionDescriptor = {
    sessionId: 'training-lifetime', projectId: 'project', projectName: 'Training', mode: 'resilient',
    role, localPeer, hostPeerId: 'host', backingFolder: role === 'host' ? folder : '', workingFolder: `${folder}-working`,
    createdAt: Date.now(), sessionEpoch: 1, hostEpoch: 0, computeExecutorId: 'host', pythonPath: 'python3',
  };
  return new SessionRuntime(descriptor, 'training-lifetime-token-that-is-long-enough',
    { extensionUri: { fsPath: process.cwd() } }, { appendLine: () => undefined });
}

async function withAcceleratedFormerTrainingDeadline(action: () => Promise<void>): Promise<void> {
  const original = globalThis.setTimeout;
  // Turn the previous ten/eleven-minute cutoffs into 25ms, keeping delivery,
  // bridge startup and cleanup budgets unchanged. A short real kernel run can
  // therefore reproduce an hours-long training interruption deterministically.
  globalThis.setTimeout = ((callback: (...args: any[]) => void, milliseconds?: number, ...args: any[]) =>
    original(callback, milliseconds === 600_000 || milliseconds === 660_000 ? 25 : milliseconds, ...args)) as typeof setTimeout;
  try { await action(); }
  finally { globalThis.setTimeout = original; }
}

describe('accepted training execution lifetime', () => {
  it('allows local training to finish beyond the previous automatic interruption deadline', async function () {
    this.timeout(20_000);
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-long-local-training-'));
    const host = runtime(root, 'host');
    try {
      const code = 'import time\nfrom pathlib import Path\ntime.sleep(0.15)\nPath("checkpoint.txt").write_text("completed")';
      await withAcceleratedFormerTrainingDeadline(async () => {
        const result = await host.executeCell('training.ipynb', 'cell-a', code, () => undefined);
        assert.equal(result.success, true, JSON.stringify(result.content));
      });
      assert.equal(await readFile(path.join(root, 'checkpoint.txt'), 'utf8'), 'completed');
    } finally { await host.disposeAsync(); await rm(root, { recursive: true, force: true }); }
  });

  it('keeps an accepted guest request alive until real host training and its result finish', async function () {
    this.timeout(20_000);
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-long-remote-training-'));
    const hostFolder = path.join(root, 'host'); const guestFolder = path.join(root, 'guest');
    await Promise.all([mkdir(hostFolder), mkdir(guestFolder)]);
    const host = runtime(hostFolder, 'host'); const guest = runtime(guestFolder, 'peer');
    const code = 'import time\nfrom pathlib import Path\ntime.sleep(0.15)\nPath("guest-checkpoint.txt").write_text("completed")';
    host.project.ensureNotebook('training.ipynb', { metadata: {}, cells: [
      { id: 'cell-a', kind: 2, language: 'python', source: code, metadata: {}, outputs: [] },
    ] });
    guest.project.applyRemoteUpdate('training.ipynb', 'notebook', host.project.encodeUpdate('training.ipynb'));
    guest.synchronizeExecutionFiles = async () => undefined;
    guest.waitForTransportRoute = async () => undefined;
    // The transport boundary delivers production protocol frames; the host's
    // authority checks, acceptance, event ordering and Jupyter execution stay real.
    const transport = (recipient: any, source: string) => ({
      broadcast: () => 'broadcast', peerRuntime: () => [], stop: async () => undefined,
      sendTo: (_peer: string, type: string, meta: Record<string, unknown>, payload = new Uint8Array()) => {
        void recipient.onMessage({ type, meta, payload } satisfies WireFrame, source);
        return 'message';
      },
    });
    host.transport = transport(guest, 'host'); guest.transport = transport(host, 'guest');
    try {
      await withAcceleratedFormerTrainingDeadline(async () => {
        const result = await guest.executeCell('training.ipynb', 'cell-a', 'guest code is not authoritative', () => undefined);
        assert.equal(result.success, true, JSON.stringify(result.content));
      });
      assert.equal(await readFile(path.join(hostFolder, 'guest-checkpoint.txt'), 'utf8'), 'completed');
      await assert.rejects(readFile(path.join(guestFolder, 'guest-checkpoint.txt')), { code: 'ENOENT' });
      assert.equal(guest.pendingExecutions.size, 0);
    } finally { await Promise.all([host.disposeAsync(), guest.disposeAsync()]); await rm(root, { recursive: true, force: true }); }
  });

  it('still cancels an accepted execution when the session closes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-accepted-training-close-'));
    const guest = runtime(root, 'peer');
    guest.project.ensureNotebook('training.ipynb', { metadata: {}, cells: [
      { id: 'cell-a', kind: 2, language: 'python', source: 'pass', metadata: {}, outputs: [] },
    ] });
    guest.synchronizeExecutionFiles = async () => undefined;
    guest.waitForTransportRoute = async () => undefined;
    let accepted = false;
    guest.transport = {
      broadcast: () => 'broadcast', peerRuntime: () => [], stop: async () => undefined,
      sendTo: (_peer: string, type: string, meta: Record<string, unknown>) => {
        if (type === 'executeRequest') {
          guest.markRemoteExecutionAccepted(String(meta.requestId), 'host');
          accepted = true;
        }
        return 'message';
      },
    };
    try {
      const execution = assert.rejects(guest.executeCell('training.ipynb', 'cell-a', 'pass', () => undefined), /session closed/);
      while (!accepted) await delay(1);
      assert.equal([...guest.pendingExecutions.values()][0]?.timer, undefined);
      await guest.disposeAsync();
      await execution;
      assert.equal(guest.pendingExecutions.size, 0);
    } finally { await guest.disposeAsync(); await rm(root, { recursive: true, force: true }); }
  });
});
