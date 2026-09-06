export const OUTPUT_STATE_CADENCE_MS = 500;

export class CadencedTask {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private pending = false;
  private draining = false;
  private disposed = false;

  public constructor(
    private readonly intervalMs: number,
    private readonly task: () => void | Promise<void>,
    private readonly onBackgroundError: (error: unknown) => void = () => undefined,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
      throw new Error('Cadenced task interval must be a positive integer.');
    }
  }

  /** Keeps only the latest requested state and starts at most one timer. */
  public schedule(): void {
    if (this.disposed) return;
    this.pending = true;
    this.arm();
  }

  /** Runs the latest pending state now and waits for any in-flight task. */
  public async flush(): Promise<void> {
    if (this.disposed) {
      await this.running;
      return;
    }
    this.draining = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    try {
      if (this.running) await this.running;
      while (this.pending && !this.disposed) await this.runOnce();
    } finally {
      this.draining = false;
      this.arm();
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    if (this.disposed || this.draining || !this.pending || this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runOnce().catch((error) => this.onBackgroundError(error));
    }, this.intervalMs);
  }

  private async runOnce(): Promise<void> {
    if (this.disposed || !this.pending) return;
    this.pending = false;
    const running = Promise.resolve().then(this.task);
    this.running = running;
    try {
      await running;
    } finally {
      if (this.running === running) this.running = undefined;
      this.arm();
    }
  }
}
