import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { waitForInitialState } from '../src/core/initialState';

describe('initial project state recovery', () => {
  it('requests state again when the first completion frame was lost', async () => {
    let resolve!: () => void;
    const ready = new Promise<void>(done => { resolve = done; });
    let requests = 0;
    await waitForInitialState({ ready, progressAt: () => 0, retryMs: 10, idleMs: 100,
      request: () => { if (++requests === 2) resolve(); } });
    assert.equal(requests, 2);
  });
  it('allows a progressing transfer beyond the idle deadline', async () => {
    let resolve!: () => void;
    const ready = new Promise<void>(done => { resolve = done; });
    let progress = Date.now(), requests = 0;
    await waitForInitialState({ ready, progressAt: () => progress, retryMs: 10, idleMs: 40, maximumMs: 500,
      request: () => { progress = Date.now(); if (++requests === 8) resolve(); } });
    assert.equal(requests, 8);
  });
  it('still bounds a silent host and honors cancellation', async () => {
    await assert.rejects(waitForInitialState({ ready: new Promise(() => undefined), progressAt: () => 0,
      request: () => undefined, idleMs: 20, retryMs: 5 }), /host stopped/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(waitForInitialState({ ready: new Promise(() => undefined), progressAt: () => 0,
      request: () => undefined, signal: controller.signal }), /cancelled/);
  });
});

describe('temporary guest workspace removal', () => {
  const { removeGuest } = createRequire(__filename)(path.resolve(__dirname, '../../media/cleanup-session.cjs')) as { removeGuest: (base: string, target: string) => Promise<boolean> };
  for (const role of ['host', 'peer']) it(`removes a managed ${role} workspace after editor exit`, async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'pair-guest-editor-exit-'));
    try {
      const base = path.join(fixture, 'pair-notebook.pair-notebook');
      const target = path.join(base, 'sessions', 'session', 'guest');
      const workingFolder = path.join(target, 'workspace');
      await mkdir(workingFolder, { recursive: true });
      await writeFile(path.join(workingFolder, 'copy.py'), 'print(42)');
      const context = { extensionPath: path.resolve(__dirname, '../..'), globalStorageUri: { fsPath: base } };
      const descriptor = { role, sessionId: 'session', localPeer: { peerId: 'guest' }, workingFolder };
      const code = "const {retireGuestWorkspace}=require(process.argv[1]);const input=JSON.parse(process.argv[2]);retireGuestWorkspace(input.context,input.descriptor).then(()=>process.exit(0),()=>process.exit(1));";
      const child = spawn(process.execPath, ['-e', code, path.resolve(__dirname, '../src/vscode/temporarySessions.js'), JSON.stringify({ context, descriptor })], { cwd: workingFolder, windowsHide: true, stdio: 'ignore' });
      const [exit] = await once(child, 'exit'); assert.equal(exit, 0);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try { await access(target); } catch { return; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.fail('Detached cleanup kept its own guest workspace locked.');
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });
  it('removes only an explicitly retired guest, including journals beside its workspace', async () => {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'pair-guest-cleanup-'));
    try {
      const base = path.join(fixture, 'pair-notebook.pair-notebook');
      const target = path.join(base, 'sessions', 'session', 'guest');
      const host = path.join(fixture, 'host-project');
      await mkdir(path.join(target, 'workspace'), { recursive: true }); await mkdir(host);
      await writeFile(path.join(host, 'keep.py'), 'print(42)');
      await writeFile(path.join(target, 'workspace', 'copy.py'), 'print(42)');
      await writeFile(path.join(target, 'journal'), 'private state');
      await assert.rejects(removeGuest(base, target), /ENOENT/);
      await writeFile(path.join(target, '.pair-guest-cleanup.json'), JSON.stringify({ version: 1, sessionId: 'session', peerId: 'guest' }));
      assert.equal(await removeGuest(base, target), true);
      await assert.rejects(access(target));
      assert.equal(await readFile(path.join(host, 'keep.py'), 'utf8'), 'print(42)');
      await assert.rejects(removeGuest(base, host), /Invalid guest cleanup path/);
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });
  it('rejects directory links rather than traversing them', async function () {
    const fixture = await mkdtemp(path.join(os.tmpdir(), 'pair-guest-link-'));
    try {
      const base = path.join(fixture, 'pair-notebook.pair-notebook');
      await mkdir(base); await mkdir(path.join(fixture, 'outside'));
      await symlink(path.join(fixture, 'outside'), path.join(base, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(removeGuest(base, path.join(base, 'sessions', 'session', 'guest')), /real extension directories/);
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });
});
