import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JupyterKernel, JupyterKernelEvent } from '../src/core/pythonKernel';

describe('Jupyter bridge stdout framing', () => {
  async function withBridge(source: string, action: (kernel: JupyterKernel) => Promise<void>): Promise<void> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pair-bridge-framing-'));
    const bridge = path.join(root, 'bridge.js');
    await writeFile(bridge, source, 'utf8');
    const kernel = new JupyterKernel(process.execPath, bridge, root);
    try {
      await action(kernel);
    } finally {
      await kernel.stopConfirmed();
      await rm(root, { recursive: true, force: true });
    }
  }

  it('preserves split UTF-8 and CRLF while dispatching multiple lines in one chunk', async () => {
    await withBridge([
      "const readline = require('node:readline');",
      "process.stdout.write(JSON.stringify({type:'ready',pythonExecutable:process.execPath,kernelInfo:{}})+'\\n');",
      "readline.createInterface({input:process.stdin}).on('line', line => {",
      '  const command = JSON.parse(line);',
      "  if (command.command === 'shutdown') return process.exit(0);",
      "  if (command.command === 'interrupt') return process.stdout.write(JSON.stringify({type:'commandResult',requestId:command.requestId,success:true})+'\\n');",
      "  if (command.command !== 'execute') return;",
      "  const first = JSON.stringify({type:'iopub',requestId:command.requestId,messageType:'stream',content:{text:'Привет 🌍'}});",
      "  const second = JSON.stringify({type:'iopub',requestId:command.requestId,messageType:'stream',content:{text:'second'}});",
      "  const last = JSON.stringify({type:'complete',requestId:command.requestId,success:true,content:{status:'ok'}});",
      "  const bytes = Buffer.from(first+'\\r\\n\\n'+second+'\\n'+last+'\\n');",
      "  const unicodeSplit = bytes.indexOf(Buffer.from('🌍')) + 1;",
      '  const crSplit = bytes.indexOf(0x0d) + 1;',
      '  process.stdout.write(bytes.subarray(0, unicodeSplit));',
      '  setTimeout(() => {',
      '    process.stdout.write(bytes.subarray(unicodeSplit, crSplit));',
      '    setTimeout(() => process.stdout.write(bytes.subarray(crSplit)), 40);',
      '  }, 40);',
      '});',
    ].join('\n'), async (kernel) => {
      const events: JupyterKernelEvent[] = [];
      kernel.on('event', (event: JupyterKernelEvent) => events.push(event));
      const result = await kernel.execute('unicode-framing', 'unused');
      assert.equal(result.success, true);
      assert.deepEqual(events.map((event) => event.type), ['iopub', 'iopub', 'complete']);
      assert.deepEqual(events.slice(0, 2).map((event) => event.content?.text), ['Привет 🌍', 'second']);
    });
  });

  it('accepts a fragmented protocol line at the original 32 MiB boundary', async () => {
    await withBridge([
      "const readline = require('node:readline');",
      "const message = {type:'ready',pythonExecutable:process.execPath,kernelInfo:{padding:''}};",
      "message.kernelInfo.padding = 'x'.repeat(32 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(message)));",
      "process.stdout.write(JSON.stringify(message)+'\\n');",
      "readline.createInterface({input:process.stdin}).on('line', line => {",
      '  const command = JSON.parse(line);',
      "  if (command.command === 'shutdown') process.exit(0);",
      "  if (command.command === 'interrupt') process.stdout.write(JSON.stringify({type:'commandResult',requestId:command.requestId,success:true})+'\\n');",
      '});',
    ].join('\n'), async (kernel) => {
      const ready = await kernel.start();
      assert.equal(Buffer.byteLength(JSON.stringify(ready)), 32 * 1024 * 1024);
      assert.equal(ready.kernelInfo.padding.at(-1), 'x');
    });
  });
});
