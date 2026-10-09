import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { WireFrame } from './wire';

const HISTORY_CHARS = 128 * 1024;
const CHUNK_CHARS = 16 * 1024;
function terminalId(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value); }
function retainedText(text: string): string {
  const tail = text.slice(-HISTORY_CHARS);
  const first = tail.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail;
}
export interface TerminalView { text: string; reset: boolean }
interface TerminalAuthority {
  isHost(): boolean;
  hostId(): string;
  available(): boolean;
  directory(): string;
  prepare(): Promise<void>;
  send(peer: string | undefined, type: string, meta: Record<string, unknown>, payload?: Uint8Array): void;
}

/** Only local host input reaches a shell. The network exposes output and snapshots. */
export class SharedTerminal extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private history = '';
  private generation: string = randomUUID();
  private readonly streamId = randomUUID();
  private generationIndex = 0;
  private remoteGenerationIndex = -1;
  private remoteStreamId: string | undefined;
  private candidateStreamId: string | undefined;
  private snapshotRequestId: string | undefined;
  private sequence = 0;
  private pending = '';
  private timer: NodeJS.Timeout | undefined;
  private queue = Promise.resolve();
  private queued = 0;
  private commandGeneration = 0;
  private closed = false;
  private snapshotRequested = false;
  private snapshotTimer: NodeJS.Timeout | undefined;
  private readonly requests = new Map<string, number>();

  public constructor(private readonly authority: TerminalAuthority) { super(); }
  public view(): TerminalView { return { text: this.history, reset: true }; }
  public requestSnapshot(fresh = false): void {
    if (this.closed || this.authority.isHost()) return;
    this.snapshotRequested = true;
    if (fresh || !this.snapshotRequestId) this.snapshotRequestId = randomUUID();
    this.send(this.authority.hostId(), 'shellSnapshotRequest', { requestId: this.snapshotRequestId });
    if (this.snapshotRequested && !this.snapshotTimer) {
      this.snapshotTimer = setTimeout(() => { this.snapshotTimer = undefined; if (this.snapshotRequested) this.requestSnapshot(); }, 2000);
      this.snapshotTimer.unref();
    }
  }
  public peerConnected(peer: string): void {
    if (this.authority.isHost()) this.sendSnapshot(peer);
    else if (peer === this.authority.hostId()) this.requestSnapshot(true);
  }
  public handle(frame: WireFrame, source: string): boolean {
    if (!['shellSnapshotRequest', 'shellSnapshot', 'shellOutput', 'shellInput'].includes(frame.type)) return false;
    if (this.closed) return true;
    // Remote input is deliberately rejected, including frames forged by an invite holder.
    if (frame.type === 'shellInput') return true;
    if (frame.type === 'shellSnapshotRequest') {
      const now = Date.now();
      if (this.authority.isHost() && now - (this.requests.get(source) ?? 0) >= 1000) {
        if (this.requests.size >= 256) this.requests.clear();
        this.requests.set(source, now);
        this.sendSnapshot(source, terminalId(frame.meta.requestId) ? frame.meta.requestId : undefined);
      }
      return true;
    }
    if (this.authority.isHost() || source !== this.authority.hostId()) return true;
    const { generation, generationIndex, streamId, sequence, requestId } = frame.meta;
    if (!terminalId(generation)
      || !Number.isSafeInteger(sequence) || Number(sequence) < 0 || frame.payload.byteLength > HISTORY_CHARS * 4) return true;
    if (frame.type === 'shellSnapshot' && requestId !== undefined
      && (!terminalId(requestId) || requestId !== this.snapshotRequestId)) return true;
    let newerGeneration = false;
    if (generationIndex !== undefined) {
      if (!Number.isSafeInteger(generationIndex) || Number(generationIndex) < 0 || !terminalId(streamId)) return true;
      if (streamId !== this.remoteStreamId) {
        // A process restart may reuse the host clock and reset its counter.
        // Adopt a different stream only after a response to our current nonce.
        if (frame.type === 'shellSnapshot' && requestId !== undefined && requestId === this.snapshotRequestId) {
          this.remoteStreamId = streamId;
          this.remoteGenerationIndex = -1;
        } else {
          if (this.candidateStreamId !== streamId || !this.snapshotRequested) {
            this.candidateStreamId = streamId;
            this.requestSnapshot(true);
          }
          return true;
        }
      }
      if (Number(generationIndex) < this.remoteGenerationIndex) return true;
      if (Number(generationIndex) === this.remoteGenerationIndex && generation !== this.generation) return true;
      newerGeneration = Number(generationIndex) > this.remoteGenerationIndex;
      this.remoteGenerationIndex = Number(generationIndex);
      if (newerGeneration && frame.type === 'shellOutput') {
        // Remember the newest generation before asking for its history. Late
        // snapshots from an old repository must not restore its terminal view.
        this.generation = generation;
        this.sequence = 0;
        this.history = '';
        this.emit('view', this.view());
        this.requestSnapshot(true);
        return true;
      }
    } else if (this.remoteGenerationIndex >= 0) return true;
    if (frame.type === 'shellSnapshot') {
      if (!newerGeneration && generation === this.generation && Number(sequence) < this.sequence) return true;
      this.generation = generation;
      this.sequence = Number(sequence);
      this.history = retainedText(Buffer.from(frame.payload).toString('utf8'));
      if (!this.candidateStreamId || this.candidateStreamId === this.remoteStreamId || requestId === this.snapshotRequestId) {
        this.snapshotRequested = false;
        this.snapshotRequestId = undefined;
        this.candidateStreamId = undefined;
        if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
        this.snapshotTimer = undefined;
      }
      this.emit('view', this.view());
    } else {
      if (generation === this.generation && Number(sequence) <= this.sequence) return true;
      if (generation !== this.generation || Number(sequence) !== this.sequence + 1) {
        if (!this.snapshotRequested) this.requestSnapshot();
        return true;
      }
      this.sequence = Number(sequence);
      this.append(Buffer.from(frame.payload).toString('utf8'));
    }
    return true;
  }
  public isRunning(): boolean { return Boolean(this.child) || this.queued > 0; }

  public async execute(command: string): Promise<void> {
    if (this.closed || !this.authority.isHost() || !this.authority.available()) throw new Error('Only the active session host can enter terminal commands.');
    if (!command || command.length > 8192 || /[\uD800-\uDFFF]/u.test(command)
      || [...command].some((character) => { const code = character.charCodeAt(0); return (code < 32 && code !== 9 && code !== 10) || code === 127; })) throw new Error('Enter a command of at most 8192 characters.');
    if (this.queued >= 16) throw new Error('Terminal input queue is full.');
    this.queued++;
    const generation = this.generation;
    const commandGeneration = this.commandGeneration;
    const operation = this.queue.then(async () => {
      await this.authority.prepare();
      if (this.closed || generation !== this.generation || commandGeneration !== this.commandGeneration || !this.authority.isHost() || !this.authority.available()) throw new Error('The terminal host changed or its queued command was cancelled before it could start.');
      const child = this.child ?? this.startShell();
      if (child.stdin.destroyed || child.stdin.writableLength > 64 * 1024) throw new Error('The host shell is not accepting input.');
      this.publish(`\n$ ${command}\n`);
      await new Promise<void>((resolve, reject) => child.stdin.write(command + (process.platform === 'win32' ? '\r\n' : '\n'), (error) => error ? reject(error) : resolve()));
    }).finally(() => { this.queued--; });
    this.queue = operation.catch(() => undefined);
    await operation;
  }
  private startShell(): ChildProcessWithoutNullStreams {
    const windows = process.platform === 'win32';
    const shell = windows ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/sh';
    const directory = this.authority.directory();
    const child = spawn(shell, windows ? ['/d', '/q', '/k', 'chcp 65001>nul'] : [], {
      cwd: directory,
      env: { ...process.env, TERM: 'dumb', PAIR_NOTEBOOK_WORKSPACE: directory,
        PYTHONPATH: directory + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : '') },
      stdio: 'pipe', windowsHide: true, detached: !windows,
    });
    this.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8');
      stream.on('data', (bytes: Buffer) => { if (this.child === child) this.publish(decoder.write(bytes)); });
      stream.on('end', () => { if (this.child === child) this.publish(decoder.end()); });
    }
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => {
      if (this.child !== child) return;
      this.publish(`\n[Cannot start host shell: ${error.message}]\n`);
    });
    child.on('exit', () => {
      // Background commands can redirect all streams and outlive the shell.
      // Releasing its handle before stopping the group would leave training
      // alive after disposal and allow a repository switch around that work.
      if (this.child === child && process.platform !== 'win32') this.stopProcessGroup(child);
    });
    child.on('close', (code) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.publish(`\n[Host shell exited: ${code ?? 'signal'}]\n`);
    });
    return child;
  }
  private publish(text: string): void {
    if (!text || this.closed) return;
    this.pending += text;
    // Drop excess display data while continuing to drain the shell's pipes.
    if (this.pending.length > HISTORY_CHARS) this.pending = retainedText(this.pending);
    if (!this.timer) this.timer = setTimeout(() => this.flushOutput(), 30);
  }
  private flushOutput(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    while (this.pending) {
      let end = Math.min(CHUNK_CHARS, this.pending.length);
      if (/[\uD800-\uDBFF]/.test(this.pending[end - 1] ?? '')) end--;
      const text = this.pending.slice(0, end);
      this.pending = this.pending.slice(end);
      this.sequence++;
      this.append(text);
      this.send(undefined, 'shellOutput', { streamId: this.streamId, generation: this.generation, generationIndex: this.generationIndex, sequence: this.sequence }, Buffer.from(text));
    }
  }
  private append(text: string): void {
    this.history = retainedText(this.history + text);
    this.emit('view', { text, reset: false } satisfies TerminalView);
  }
  private sendSnapshot(peer: string, requestId?: string): void {
    this.flushOutput();
    this.send(peer, 'shellSnapshot', { streamId: this.streamId, generation: this.generation, generationIndex: this.generationIndex, sequence: this.sequence,
      ...(requestId ? { requestId } : {}) }, Buffer.from(this.history));
  }
  private send(peer: string | undefined, type: string, meta: Record<string, unknown>, payload?: Uint8Array): void {
    try { this.authority.send(peer, type, meta, payload); }
    catch { this.emit('deliveryDelayed'); } // Snapshot/reconnect restores output after route loss.
  }
  public reset(): void {
    this.commandGeneration++;
    this.stopShell();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = '';
    this.history = '';
    this.sequence = 0;
    this.generation = randomUUID();
    this.generationIndex++;
    this.remoteGenerationIndex = -1;
    this.remoteStreamId = undefined;
    this.candidateStreamId = undefined;
    this.snapshotRequestId = undefined;
    this.snapshotRequested = false;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = undefined;
    this.requests.clear();
    this.emit('view', this.view());
    if (!this.closed && this.authority.isHost()) this.send(undefined, 'shellSnapshot', { streamId: this.streamId, generation: this.generation, generationIndex: this.generationIndex, sequence: 0 }, Buffer.alloc(0));
  }
  public interrupt(): void {
    if (!this.authority.isHost() || this.closed) throw new Error('Only the session host can interrupt the terminal.');
    this.commandGeneration++;
    this.stopShell();
    this.publish('\n[Host stopped the shell and its commands; the next command starts a new shell.]\n');
  }
  private stopShell(): void {
    const child = this.child;
    this.child = undefined;
    if (!child?.pid) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => child.kill());
    } else {
      this.stopProcessGroup(child);
    }
    child.stdin.destroy();
  }
  private stopProcessGroup(child: ChildProcessWithoutNullStreams): void {
    if (!child.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch { child.kill('SIGKILL'); }
  }
  public dispose(): void { this.closed = true; this.reset(); this.removeAllListeners(); }
}
