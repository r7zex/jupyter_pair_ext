import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { JupyterKernel } from '../src/core/pythonKernel';

const execFileAsync = promisify(execFile);

describe('Jupyter execution failures', () => {
  it('settles rejected execute commands immediately and permits the next cell', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-command-rejection-'));
    const bridge = path.join(root, 'bridge.js');
    await writeFile(bridge, [
      "const readline = require('node:readline');",
      "const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');",
      "emit({type:'ready',pythonExecutable:process.execPath,kernelInfo:{}});",
      "let rejectExecution = true;",
      "readline.createInterface({input:process.stdin}).on('line', line => {",
      " const command = JSON.parse(line);",
      " if (command.command === 'shutdown') process.exit(0);",
      " if (command.command !== 'execute') return;",
      " if (rejectExecution) { rejectExecution = false; emit({type:'commandError',requestId:command.requestId,message:'Execution code rejected'}); }",
      " else emit({type:'complete',requestId:command.requestId,success:true,content:{status:'ok'}});",
      "});",
    ].join('\n'));
    const kernel = new JupyterKernel(process.execPath, bridge, root);
    try {
      await assert.rejects(withDeadline(kernel.execute('reused-id', '1 + 1'), 2000), /Execution code rejected/);
      assert.equal((await kernel.execute('reused-id', '2 + 2')).success, true);
    } finally {
      kernel.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  it('finishes a cell after actual kernel death and starts a usable replacement', async function () {
    this.timeout(60_000);
    const python = process.env.PAIR_NOTEBOOK_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    try {
      await execFileAsync(python, ['-c', 'import jupyter_client,ipykernel'], { timeout: 5000 });
    } catch (error) {
      console.warn(`[jupyter capability] BLOCKED: kernel death/recovery test needs jupyter_client and ipykernel: ${String(error)}`);
      this.skip();
      return;
    }
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-kernel-death-'));
    const kernel = new JupyterKernel(python, path.resolve(__dirname, '../../media/jupyter_kernel_bridge.py'), root);
    try {
      try {
        await kernel.start();
      } catch (error) {
        if (/Operation not permitted|Permission denied|\bEPERM\b|\bEACCES\b/i.test(String(error))) {
          console.warn(`[jupyter capability] BLOCKED: kernel death/recovery sockets denied: ${String(error)}`);
          this.skip();
          return;
        }
        throw error;
      }
      const result = await withDeadline(kernel.execute('crashed-cell', 'import os\nos._exit(23)'), 5000);
      assert.equal(result.success, false);
      assert.equal(result.content.ename, 'KernelDied');
      assert.match(String(result.content.evalue), /exited unexpectedly/);
      assert.equal((await kernel.execute('recovered-cell', 'assert 2 + 2 == 4')).success, true);
    } finally {
      kernel.stop();
      await new Promise((resolve) => setTimeout(resolve, 500));
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });
});

function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Execution did not settle after kernel failure.')), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}
