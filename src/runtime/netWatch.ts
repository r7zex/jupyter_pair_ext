/**
 * Passive network-change detection for Pair Notebook.
 *
 * Watches `os.networkInterfaces()` on a slow timer and reports a change when
 * the fingerprint of (adapter name, non-internal address) pairs changes.
 * This is an ordinary user-level API: no elevation, no system modification.
 *
 * The watcher NEVER tears anything down by itself. Consumers use the event
 * as a bounded reason to search for alternative routes (make-before-break),
 * never as a reason to disconnect a healthy active route.
 */

import { networkInterfaces } from 'node:os';

export interface InterfaceSnapshotEntry {
  name: string;
  addresses: string[];
}

export function fingerprintInterfaces(
  list: ReturnType<typeof networkInterfaces>,
): string {
  const entries: InterfaceSnapshotEntry[] = [];
  for (const [name, addresses] of Object.entries(list)) {
    const relevant = (addresses ?? [])
      .filter((address) => !address.internal)
      .map((address) => `${address.family}:${address.address}`)
      .sort();
    entries.push({ name, addresses: relevant });
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return JSON.stringify(entries);
}

export class NetworkChangeWatcher {
  private timer: NodeJS.Timeout | undefined;
  private lastFingerprint: string | undefined;

  public constructor(
    private readonly onChange: () => void,
    private readonly options: {
      intervalMs?: number;
      /** Test seam; defaults to os.networkInterfaces(). */
      listInterfaces?: () => ReturnType<typeof networkInterfaces>;
    } = {},
  ) {}

  public start(): void {
    if (this.timer) return;
    this.lastFingerprint = fingerprintInterfaces(this.interfaces());
    // The first check is delayed so session startup never races the probe.
    this.timer = setInterval(() => this.check(), this.options.intervalMs ?? 30_000);
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.lastFingerprint = undefined;
  }

  public check(): boolean {
    const next = fingerprintInterfaces(this.interfaces());
    if (this.lastFingerprint !== undefined && next !== this.lastFingerprint) {
      this.lastFingerprint = next;
      try {
        this.onChange();
      } catch { /* consumer owns its error handling */ }
      return true;
    }
    this.lastFingerprint = next;
    return false;
  }

  private interfaces(): ReturnType<typeof networkInterfaces> {
    return this.options.listInterfaces
      ? this.options.listInterfaces()
      : networkInterfaces();
  }
}
