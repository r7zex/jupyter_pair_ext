import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { PersistentClient } from '../vps/persistentClient';
import type { PersistentSessionView } from '../vps/persistentProtocol';

const run = promisify(execFile);
interface AgentConnection { endpoint: string; sessionId: string; memberId: string }

/** Launches the bundled isolated agent; membership secrets never enter command arguments. */
export class PersistentAgentLauncher {
  constructor(private readonly context: vscode.ExtensionContext, private readonly log: vscode.OutputChannel) {}

  async start(connection: AgentConnection, token: string, install = false): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace before sharing this computer.');
    const directory = path.join(this.context.globalStorageUri.fsPath, 'local-agents', connection.sessionId);
    const marker = path.join(directory, 'process.json');
    try {
      const saved = JSON.parse(await readFile(marker, 'utf8')) as { pid: number; memberId: string };
      if (saved.memberId === connection.memberId && Number.isSafeInteger(saved.pid) && saved.pid > 0) {
        process.kill(saved.pid, 0);
        const client = new PersistentClient(connection.endpoint, { kind: 'membership', token });
        try {
          const view = await client.call<PersistentSessionView>('view', { sessionId: connection.sessionId });
          if (view.devices.some(device => device.id === `pc-${connection.memberId}` && device.online)) return;
        } finally { client.dispose(); }
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && !['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    let command: string;
    let prefix: string[] = [];
    let python: string;
    let state: string;
    let script = vscode.Uri.joinPath(this.context.extensionUri, 'scripts', 'pair-notebook-session-agent.py').fsPath;
    let bridge = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'jupyter_kernel_bridge.py').fsPath;
    let credential = path.join(directory, 'credential.json');
    if (process.platform === 'win32') {
      const { stdout } = await run('wsl.exe', ['--list', '--quiet'], { timeout: 10_000, windowsHide: true });
      const distributions = stdout.replace(/\0/g, '').split(/\r?\n/).map(value => value.trim()).filter(value => /^(Ubuntu|Debian)/i.test(value));
      const distribution = distributions[0];
      if (!distribution) throw new Error('Install an Ubuntu or Debian WSL2 distribution to use isolated local compute. The VPS remains available.');
      const { stdout: version } = await run('wsl.exe', ['--list', '--verbose'], { timeout: 10_000, windowsHide: true });
      const escaped = distribution.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`^.*\\b${escaped}\\s+\\S+\\s+2\\s*$`, 'm').test(version.replace(/\0/g, ''))) throw new Error('Isolated local compute requires WSL2.');
      command = 'wsl.exe'; prefix = ['--distribution', distribution, '--exec'];
      const { stdout: home } = await run(command, [...prefix, 'printenv', 'HOME'], { timeout: 10_000, windowsHide: true });
      state = path.posix.join(home.trim(), '.local', 'share', 'pair-notebook');
      python = path.posix.join(state, 'runtime', 'bin', 'python');
      script = linuxPath(script); bridge = linuxPath(bridge); credential = linuxPath(credential);
    } else if (process.platform === 'linux') {
      command = 'python3'; state = path.join(directory, 'runtime-state');
      python = path.join(this.context.globalStorageUri.fsPath, 'agent-runtime', 'bin', 'python');
    } else throw new Error('Local persistent compute on macOS requires the Docker agent described in PERSISTENT_VPS.md.');
    if (install) {
      const runtime = path.posix.dirname(path.posix.dirname(python.replace(/\\/g, '/')));
      const arguments_ = ['-m', 'venv', runtime];
      if (process.platform === 'win32') await run(command, [...prefix, 'python3', ...arguments_], { timeout: 60_000, windowsHide: true });
      else await run(command, arguments_, { timeout: 60_000, windowsHide: true });
      await run(process.platform === 'win32' ? command : python, [...prefix, ...(process.platform === 'win32' ? [python] : []), '-m', 'pip', 'install', 'jupyter_client==8.10.0', 'ipykernel==7.4.0'], { timeout: 240_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    }
    const executable = process.platform === 'win32' ? command : python;
    const arguments_ = [...prefix, ...(process.platform === 'win32' ? [python] : []), script, '--python', python, '--bridge', bridge];
    try { await run(executable, [...arguments_, '--check-isolation'], { timeout: 30_000, windowsHide: true }); }
    catch { throw new Error('The isolated local runtime is not ready. Use My computer to prepare it; the current VPS kernel remains selected.'); }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, 'credential.json'), JSON.stringify({ ...connection, token }), { mode: 0o600 });
    const child = spawn(executable, [...arguments_, '--config', credential, '--state', path.posix.join(state.replace(/\\/g, '/'), connection.sessionId), '--share'], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    await writeFile(marker, JSON.stringify({ pid: child.pid, memberId: connection.memberId }), { mode: 0o600 });
    this.log.appendLine('[info] Started the isolated persistent compute agent. Accepted work remains independent of the editor connection.');
  }
}

function linuxPath(filename: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(filename);
  if (!match) throw new Error('The WSL agent requires local drive paths.');
  return `/mnt/${match[1]!.toLowerCase()}/${match[2]!.replace(/\\/g, '/')}`;
}
