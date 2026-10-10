import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SharedTerminal } from '../src/core/sharedTerminal';

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // Some container init processes do not reap adopted children promptly.
    // Zombies have already stopped executing and cannot keep writing training data.
    if (process.platform === 'linux') {
      const status = readFileSync(`/proc/${pid}/stat`, 'utf8');
      return !/^\s*[ZX]/.test(status.slice(status.lastIndexOf(')') + 1));
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH' || (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await check())) {
    if (Date.now() >= deadline) assert.fail('Host shell process cleanup did not finish');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('shared terminal process lifecycle', () => {
  for (const operation of ['shell-exit', 'interrupt', 'dispose'] as const) {
    it(`stops background commands with redirected streams after ${operation}`, async function () {
      if (process.platform === 'win32') this.skip();
      const root = await mkdtemp(path.join(os.tmpdir(), 'pair-shell-child-lifetime-'));
      const terminal = new SharedTerminal({ isHost: () => true, hostId: () => 'host', available: () => true,
        directory: () => root, prepare: async () => undefined, send: () => undefined });
      let workerPid: number | undefined;
      try {
        await terminal.execute('sleep 30 >/dev/null 2>&1 & echo $! > worker.pid' + (operation === 'shell-exit' ? '; exit' : ''));
        await until(async () => {
          try { workerPid = Number((await readFile(path.join(root, 'worker.pid'), 'utf8')).trim()); return workerPid > 0; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
        });
        assert.ok(workerPid);
        if (operation === 'interrupt') { const challenge = terminal.requestInterrupt(); await terminal.interrupt({ challengeId: challenge.id, value: 'CONFIRM' }); }
        if (operation === 'dispose') terminal.dispose();
        await until(() => !terminal.isRunning());
        await until(() => !processRunning(workerPid!));
      } finally {
        terminal.dispose();
        if (workerPid && processRunning(workerPid)) process.kill(workerPid, 'SIGKILL');
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
