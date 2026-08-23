import { EventEmitter } from 'node:events';
import { lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const AUTOSAVE_INTERVAL_MS = 5 * 60_000;
export const AUTOSAVE_RETENTION = 3;

export interface AutosaveStatus {
  enabled: boolean;
  folder: string;
  intervalMs: number;
  retention: number;
  copies: number;
  lastAt: number;
  nextAt: number;
  lastSnapshotPath?: string;
  lastError?: string;
}

export interface LocalAutosaveOptions {
  root: string;
  sessionId: string;
  projectName: string;
  writeSnapshot: (targetFolder: string) => Promise<void>;
  intervalMs?: number;
  retention?: number;
  now?: () => number;
}

const SNAPSHOT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?$/;
const PARTIAL_PATTERN = /^\.partial-\d+-\d+-\d+$/;

/**
 * Creates isolated, point-in-time project folders. A staging directory is
 * renamed only after every file is present, so a crash cannot publish a
 * half-written autosave as a valid recovery copy.
 */
export class LocalAutosaveManager extends EventEmitter {
  private readonly intervalMs: number;
  private readonly retention: number;
  private readonly now: () => number;
  private readonly sessionRoot: string;
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<string> | undefined;
  private active = false;
  private sequence = 0;
  private stagingSequence = 0;
  private sessionRootIdentity: { dev: number; ino: number } | undefined;
  private state: AutosaveStatus;

  public constructor(private readonly options: LocalAutosaveOptions) {
    super();
    this.intervalMs = options.intervalMs ?? AUTOSAVE_INTERVAL_MS;
    this.retention = options.retention ?? AUTOSAVE_RETENTION;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.intervalMs) || this.intervalMs < 1) throw new Error('Autosave interval must be positive.');
    if (!Number.isInteger(this.retention) || this.retention < 1) throw new Error('Autosave retention must be a positive integer.');
    const project = safeComponent(options.projectName || 'project');
    const session = safeComponent(options.sessionId).slice(0, 12) || 'session';
    this.sessionRoot = path.resolve(options.root, `${project}-${session}`);
    this.state = {
      enabled: false,
      folder: path.resolve(options.root),
      intervalMs: this.intervalMs,
      retention: this.retention,
      copies: 0,
      lastAt: 0,
      nextAt: 0,
    };
  }

  public async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      await this.ensureSessionRoot();
      await this.removeAbandonedStagingDirectories();
      const snapshots = await this.snapshotDirectories();
      await this.removeStaleSnapshots(snapshots);
      this.state.copies = (await this.snapshotDirectories()).length;
      this.state.enabled = true;
      this.arm();
      this.emitState();
    } catch (error) {
      this.active = false;
      this.state.enabled = false;
      this.state.nextAt = 0;
      this.state.lastError = formatError(error);
      this.emitState();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.state.enabled = false;
    this.state.nextAt = 0;
    const current = this.current;
    if (current) await current.catch(() => undefined);
    this.emitState();
  }

  public status(): AutosaveStatus {
    return { ...this.state };
  }

  /** Runs one autosave immediately; exposed for the host command and tests. */
  public async runNow(): Promise<string> {
    if (!this.active) throw new Error('Local autosaves are not active on this participant.');
    if (this.current) return this.current;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const operation = this.createSnapshot().finally(() => {
      if (this.current === operation) this.current = undefined;
      if (this.active) {
        this.arm();
        this.emitState();
      }
    });
    this.current = operation;
    return operation;
  }

  private async createSnapshot(): Promise<string> {
    await this.ensureSessionRoot();
    const timestamp = this.now();
    const baseName = new Date(timestamp).toISOString().replace(/:/g, '-').replace(/\./g, '-');
    const existing = new Set(await this.snapshotDirectories());
    for (const name of existing) {
      const match = new RegExp(`^${escapeRegExp(baseName)}-(\\d+)$`).exec(name);
      if (match) this.sequence = Math.max(this.sequence, Number(match[1]));
    }
    let name: string;
    do name = `${baseName}-${++this.sequence}`;
    while (existing.has(name));
    const finalFolder = path.join(this.sessionRoot, name);
    const stagingFolder = path.join(this.sessionRoot, `.partial-${process.pid}-${timestamp}-${++this.stagingSequence}`);
    try {
      await this.ensureSessionRoot();
      await mkdir(stagingFolder, { recursive: false });
      await this.options.writeSnapshot(stagingFolder);
      await writeFile(path.join(stagingFolder, '.pair-notebook-autosave.json'), `${JSON.stringify({
        projectName: this.options.projectName,
        sessionId: this.options.sessionId,
        createdAt: timestamp,
      }, null, 2)}\n`, 'utf8');
      await this.ensureSessionRoot();
      await rename(stagingFolder, finalFolder);
      const snapshots = await this.snapshotDirectories();
      await this.removeStaleSnapshots(snapshots);
      const retained = await this.snapshotDirectories();
      this.state.copies = retained.length;
      this.state.lastAt = timestamp;
      this.state.lastSnapshotPath = finalFolder;
      this.state.lastError = undefined;
      this.emitState();
      return finalFolder;
    } catch (error) {
      await this.ensureSessionRoot()
        .then(() => rm(stagingFolder, { recursive: true, force: true }))
        .catch(() => undefined);
      this.state.lastError = formatError(error);
      this.emitState();
      throw error;
    }
  }

  private arm(): void {
    if (!this.active) return;
    if (this.timer) clearTimeout(this.timer);
    this.state.nextAt = this.now() + this.intervalMs;
    this.timer = setTimeout(() => {
      void this.runNow().catch(() => undefined);
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private async snapshotDirectories(): Promise<string[]> {
    await this.ensureSessionRoot();
    const entries = await readdir(this.sessionRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && SNAPSHOT_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareSnapshotNames);
  }

  private async removeAbandonedStagingDirectories(): Promise<void> {
    await this.ensureSessionRoot();
    const entries = await readdir(this.sessionRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && PARTIAL_PATTERN.test(entry.name)) {
        await rm(path.join(this.sessionRoot, entry.name), { recursive: true, force: true });
      }
    }
  }

  private async removeStaleSnapshots(snapshots: readonly string[]): Promise<void> {
    await this.ensureSessionRoot();
    for (const stale of snapshots.slice(0, Math.max(0, snapshots.length - this.retention))) {
      await rm(path.join(this.sessionRoot, stale), { recursive: true, force: true });
    }
  }

  private async ensureSessionRoot(): Promise<void> {
    await mkdir(this.sessionRoot, { recursive: true });
    const info = await lstat(this.sessionRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('The autosave session folder must be a regular local directory, not a symbolic link.');
    }
    const identity = { dev: info.dev, ino: info.ino };
    if (this.sessionRootIdentity
      && (identity.dev !== this.sessionRootIdentity.dev || identity.ino !== this.sessionRootIdentity.ino)) {
      throw new Error('The autosave session folder changed while autosaves were active.');
    }
    this.sessionRootIdentity = identity;
  }

  private emitState(): void {
    this.emit('state', this.status());
  }
}

function compareSnapshotNames(left: string, right: string): number {
  const parse = (value: string): { base: string; sequence: number } => {
    const match = /^(.*?Z)(?:-(\d+))?$/.exec(value);
    return { base: match?.[1] ?? value, sequence: Number(match?.[2] ?? 0) };
  };
  const a = parse(left);
  const b = parse(right);
  return a.base.localeCompare(b.base) || a.sequence - b.sequence;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function defaultAutosaveRoot(): string {
  if (process.platform === 'win32') {
    const systemDrive = process.env.SystemDrive?.trim();
    const driveRoot = systemDrive
      ? path.parse(`${systemDrive}${path.sep}`).root
      : path.parse(os.tmpdir()).root || 'C:\\';
    return path.join(driveRoot, 'Temp', 'PairNotebook', 'autosaves');
  }
  return path.join(os.tmpdir(), 'pair-notebook', 'autosaves');
}

function safeComponent(value: string): string {
  const cleaned = value.trim().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 60) || 'pair-notebook';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
