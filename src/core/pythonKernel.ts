import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';

const MAX_BRIDGE_LINE_BYTES = 32 * 1024 * 1024;
const MAX_BRIDGE_COMMAND_BYTES = 48 * 1024 * 1024;
const MAX_KERNEL_PENDING_EXECUTIONS = 128;
const MAX_KERNEL_PENDING_COMMANDS = 128;
const MAX_KERNEL_INPUT_CHARACTERS = 64 * 1024;
const MAX_COMPLETION_CODE_CHARACTERS = 4 * 1024 * 1024;
const MAX_EXECUTION_CODE_BYTES = 32 * 1024 * 1024;
const MAX_KERNEL_STDIN_BUFFER_BYTES = 64 * 1024 * 1024;
const BRIDGE_MESSAGE_TYPES = new Set([
  'ready', 'fatal', 'accepted', 'iopub', 'shell', 'inputRequest', 'complete',
  'commandResult', 'completionResult', 'kernelInfoResult', 'channelError', 'commandError',
]);

export interface JupyterKernelEvent {
  type: 'accepted' | 'iopub' | 'shell' | 'inputRequest' | 'complete' | 'commandResult'
    | 'completionResult' | 'kernelInfoResult' | 'channelError' | 'commandError';
  requestId?: string | undefined;
  messageType?: string | undefined;
  content?: Record<string, any> | undefined;
  metadata?: Record<string, any> | undefined;
  buffersBase64?: string[] | undefined;
  success?: boolean | undefined;
  executionCount?: number | null | undefined;
  command?: string | undefined;
  channel?: string | undefined;
  message?: string | undefined;
  traceback?: string | undefined;
}

export interface JupyterExecutionResult {
  requestId: string;
  success: boolean;
  executionCount?: number | null | undefined;
  content: Record<string, any>;
}

interface PendingExecution {
  resolve: (value: JupyterExecutionResult) => void;
  reject: (error: Error) => void;
}

interface CommandWaiter {
  resolve: (value: JupyterKernelEvent) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ReadyMessage {
  type: 'ready';
  pythonExecutable: string;
  kernelInfo: Record<string, any>;
}

interface FatalMessage {
  type: 'fatal';
  message: string;
  installCommand?: string;
  traceback?: string;
  kernelStderr?: string;
}

export interface KernelLaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function kernelLaunchSpec(
  pythonPath: string,
  bridgePath: string,
  workingDirectory: string,
  cudaDevice: number | undefined,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): KernelLaunchSpec {
  const env: NodeJS.ProcessEnv = {
    ...baseEnvironment,
    PYTHONUNBUFFERED: '1',
    PAIR_NOTEBOOK_CWD: workingDirectory,
  };
  if (cudaDevice !== undefined) env.CUDA_VISIBLE_DEVICES = String(cudaDevice);
  else delete env.CUDA_VISIBLE_DEVICES;
  return {
    command: pythonPath,
    args: [path.resolve(bridgePath)],
    cwd: workingDirectory,
    env,
  };
}

export class JupyterKernel extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<string, PendingExecution>();
  private readonly commands = new Map<string, CommandWaiter>();
  private starting: Promise<ReadyMessage> | undefined;
  private ready: ReadyMessage | undefined;
  private stopping = false;

  public constructor(
    private readonly pythonPath: string,
    private readonly bridgePath: string,
    private readonly workingDirectory: string,
    private readonly cudaDevice?: number,
  ) {
    super();
  }

  public async start(): Promise<ReadyMessage> {
    if (this.ready && this.process && !this.process.killed) return this.ready;
    if (this.starting) return this.starting;
    this.starting = this.spawnBridge();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  public async execute(requestId: string, code: string, silent = false): Promise<JupyterExecutionResult> {
    await this.start();
    if (!requestId || requestId.length > 256 || /[\0\r\n]/.test(requestId)) {
      throw new Error('Invalid Jupyter execution request identifier.');
    }
    if (this.pending.has(requestId)) throw new Error(`Jupyter execution ${requestId} is already pending.`);
    if (this.pending.size >= MAX_KERNEL_PENDING_EXECUTIONS) {
      throw new Error('Too many Jupyter executions are pending.');
    }
    if (typeof code !== 'string' || Buffer.byteLength(code, 'utf8') > MAX_EXECUTION_CODE_BYTES) {
      throw new Error('Jupyter execution code exceeds the 32 MiB safety limit.');
    }
    return new Promise<JupyterExecutionResult>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        this.send({
          command: 'execute',
          requestId,
          codeBase64: Buffer.from(code, 'utf8').toString('base64'),
          silent,
        });
      } catch (error) {
        this.pending.delete(requestId);
        reject(asError(error));
      }
    });
  }

  public inputReply(value: string): void {
    if (value.length > MAX_KERNEL_INPUT_CHARACTERS) {
      throw new Error('Jupyter input exceeds the 64 KiB safety limit.');
    }
    this.send({ command: 'inputReply', value });
  }

  public async interrupt(): Promise<void> {
    await this.command('interrupt');
  }

  public async restart(): Promise<void> {
    await this.command('restart', 35_000);
  }

  public async complete(code: string, cursorPos: number): Promise<Record<string, any>> {
    if (code.length > MAX_COMPLETION_CODE_CHARACTERS || !Number.isSafeInteger(cursorPos)
      || cursorPos < 0 || cursorPos > code.length) {
      throw new Error('Invalid Jupyter completion request.');
    }
    const event = await this.command('complete', 10_000, { code, cursorPos }, 'completionResult');
    return event.content ?? {};
  }

  public stop(): void {
    this.stopping = true;
    if (this.process && !this.process.killed) {
      try { this.send({ command: 'shutdown' }); } catch { /* already gone */ }
      const child = this.process;
      const timer = setTimeout(() => child.kill(), 1000);
      timer.unref();
    }
    this.rejectAll(new Error('Jupyter kernel stopped.'));
    this.process = undefined;
    this.ready = undefined;
  }

  private spawnBridge(): Promise<ReadyMessage> {
    this.stopping = false;
    const launch = kernelLaunchSpec(
      this.pythonPath,
      this.bridgePath,
      this.workingDirectory,
      this.cudaDevice,
    );
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = child;
    return new Promise<ReadyMessage>((resolve, reject) => {
      let settled = false;
      const startupTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error('Jupyter kernel startup timed out after 35 seconds.'));
      }, 35_000);
      let stdoutBuffer = Buffer.alloc(0);
      let protocolFailed = false;
      const failProtocol = (error: Error): void => {
        if (protocolFailed) return;
        protocolFailed = true;
        const current = this.process === child;
        if (current) this.emit('protocolError', error);
        if (!settled) {
          settled = true;
          clearTimeout(startupTimer);
          reject(error);
        }
        if (current) this.rejectAll(error);
        child.kill();
      };
      const acceptLine = (line: string): void => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          failProtocol(new Error(`Invalid Jupyter bridge message: ${asError(error).message}`));
          return;
        }
        if (!isRecord(parsed) || typeof parsed.type !== 'string' || !BRIDGE_MESSAGE_TYPES.has(parsed.type)) {
          failProtocol(new Error('Invalid Jupyter bridge message shape.'));
          return;
        }
        const message = parsed as unknown as ReadyMessage | FatalMessage | JupyterKernelEvent;
        if (message.type === 'ready') {
          if (typeof message.pythonExecutable !== 'string' || !isRecord(message.kernelInfo)) {
            failProtocol(new Error('Invalid Jupyter bridge ready message.'));
            return;
          }
          if (this.process !== child) return;
          this.ready = message;
          if (!settled) {
            settled = true;
            clearTimeout(startupTimer);
            resolve(message);
          }
          this.emit('ready', message);
          return;
        }
        if (message.type === 'fatal') {
          const fatalMessage = typeof message.message === 'string' ? message.message : 'Jupyter bridge failed.';
          const suffix = typeof message.installCommand === 'string' ? ` Install with: ${message.installCommand}` : '';
          const diagnostic = typeof message.kernelStderr === 'string' && message.kernelStderr.trim()
            ? message.kernelStderr.trim()
            : typeof message.traceback === 'string' ? message.traceback.trim() : '';
          const error = new Error(`${fatalMessage}${suffix}${diagnostic ? `\n${diagnostic}` : ''}`);
          if (!settled) {
            settled = true;
            clearTimeout(startupTimer);
            reject(error);
          }
          if (this.process === child) {
            this.rejectAll(error);
            this.emit('fatal', error);
          }
          child.kill();
          return;
        }
        if (this.process === child) this.handleEvent(message);
      };
      child.stdout.on('data', (chunk: Buffer) => {
        if (protocolFailed) return;
        stdoutBuffer = stdoutBuffer.byteLength
          ? Buffer.concat([stdoutBuffer, chunk], stdoutBuffer.byteLength + chunk.byteLength)
          : Buffer.from(chunk);
        let newline = stdoutBuffer.indexOf(0x0a);
        while (newline >= 0) {
          const lineBytes = stdoutBuffer.subarray(0, newline);
          stdoutBuffer = stdoutBuffer.subarray(newline + 1);
          if (lineBytes.byteLength > MAX_BRIDGE_LINE_BYTES) {
            failProtocol(new Error('Jupyter bridge message exceeds the 32 MiB safety limit.'));
            return;
          }
          const line = lineBytes.subarray(0, lineBytes.at(-1) === 0x0d ? lineBytes.byteLength - 1 : lineBytes.byteLength)
            .toString('utf8');
          if (line) acceptLine(line);
          if (protocolFailed) return;
          newline = stdoutBuffer.indexOf(0x0a);
        }
        if (stdoutBuffer.byteLength > MAX_BRIDGE_LINE_BYTES) {
          failProtocol(new Error('Jupyter bridge message exceeds the 32 MiB safety limit.'));
        }
      });
      child.stderr.on('data', (chunk: Buffer) => this.emit('stderr', chunk.toString('utf8')));
      const failStream = (stream: string, error: Error) => {
        // Child stdio streams emit their own `error` events. Without listeners,
        // an EPIPE while the kernel exits can terminate the whole extension host.
        if (!this.stopping) failProtocol(new Error(`Jupyter bridge ${stream} failed: ${error.message}`));
      };
      child.stdin.on('error', (error) => failStream('stdin', error));
      child.stdout.on('error', (error) => failStream('stdout', error));
      child.stderr.on('error', (error) => failStream('stderr', error));
      child.once('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(startupTimer);
          reject(error);
        }
        if (this.process === child) this.rejectAll(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(startupTimer);
        const error = new Error(`Jupyter bridge exited (${String(code ?? signal)}).`);
        if (!settled) {
          settled = true;
          reject(error);
        }
        // A stopped bridge can exit after the same JupyterKernel instance has
        // already started a replacement. Never let the stale child's handlers
        // clear or reject the replacement's state.
        if (this.process !== child) return;
        this.process = undefined;
        this.ready = undefined;
        this.rejectAll(error);
        if (!this.stopping) this.emit('exit', code, signal);
      });
    });
  }

  private handleEvent(event: JupyterKernelEvent): void {
    if (event.requestId) {
      const waiter = this.commands.get(event.requestId);
      const isExpected = waiter && ['commandResult', 'completionResult', 'kernelInfoResult', 'commandError'].includes(event.type);
      if (waiter && isExpected) {
        clearTimeout(waiter.timer);
        this.commands.delete(event.requestId);
        if (event.type === 'commandError') waiter.reject(new Error(event.message ?? 'Jupyter command failed.'));
        else waiter.resolve(event);
      }
      if (event.type === 'complete') {
        const pending = this.pending.get(event.requestId);
        if (pending) {
          this.pending.delete(event.requestId);
          pending.resolve({
            requestId: event.requestId,
            success: event.success === true,
            executionCount: event.executionCount,
            content: event.content ?? {},
          });
        }
      }
    }
    this.emit('event', event);
  }

  private async command(
    command: string,
    timeoutMs = 10_000,
    extra: Record<string, unknown> = {},
    expectedType = 'commandResult',
  ): Promise<JupyterKernelEvent> {
    await this.start();
    if (this.commands.size >= MAX_KERNEL_PENDING_COMMANDS) {
      throw new Error('Too many Jupyter commands are pending.');
    }
    const requestId = `${command}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise<JupyterKernelEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.commands.delete(requestId);
        reject(new Error(`Jupyter ${command} timed out.`));
      }, timeoutMs);
      this.commands.set(requestId, {
        resolve: (event) => event.type === expectedType ? resolve(event) : reject(new Error(`Unexpected ${event.type} response.`)),
        reject,
        timer,
      });
      try {
        this.send({ command, requestId, ...extra });
      } catch (error) {
        clearTimeout(timer);
        this.commands.delete(requestId);
        reject(asError(error));
      }
    });
  }

  private send(message: Record<string, unknown>): void {
    if (!this.process || this.process.killed || !this.process.stdin.writable) throw new Error('Jupyter kernel is offline.');
    const encoded = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(encoded, 'utf8') > MAX_BRIDGE_COMMAND_BYTES) {
      throw new Error('Jupyter bridge command exceeds the 48 MiB safety limit.');
    }
    if (this.process.stdin.writableLength + Buffer.byteLength(encoded, 'utf8') > MAX_KERNEL_STDIN_BUFFER_BYTES) {
      throw new Error('Jupyter bridge input queue exceeds the 64 MiB safety limit.');
    }
    this.process.stdin.write(encoded);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiter of this.commands.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.commands.clear();
  }
}

/** Backward-compatible name for integrations compiled against 0.1.x. */
export { JupyterKernel as PythonKernel };

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
