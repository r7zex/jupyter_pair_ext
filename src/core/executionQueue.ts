/** Serializes Jupyter work per notebook without coupling independent notebooks. */
export class PerNotebookExecutionQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, number>();
  private totalPending = 0;

  public constructor(
    private readonly maximumPerNotebook = 256,
    private readonly maximumTotal = 1024,
  ) {
    if (!Number.isSafeInteger(maximumPerNotebook) || maximumPerNotebook < 1
      || !Number.isSafeInteger(maximumTotal) || maximumTotal < maximumPerNotebook) {
      throw new Error('Invalid notebook execution queue limits.');
    }
  }

  public enqueue<T>(notebookKey: string, task: () => Promise<T>): Promise<T> {
    const notebookPending = this.pending.get(notebookKey) ?? 0;
    if (notebookPending >= this.maximumPerNotebook || this.totalPending >= this.maximumTotal) {
      return Promise.reject(new Error('Too many notebook executions are queued.'));
    }
    this.pending.set(notebookKey, notebookPending + 1);
    this.totalPending += 1;
    const previous = this.tails.get(notebookKey) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(notebookKey, tail);
    void tail.finally(() => {
      const remaining = Math.max(0, (this.pending.get(notebookKey) ?? 1) - 1);
      if (remaining) this.pending.set(notebookKey, remaining);
      else this.pending.delete(notebookKey);
      this.totalPending = Math.max(0, this.totalPending - 1);
      if (this.tails.get(notebookKey) === tail) this.tails.delete(notebookKey);
    });
    return result;
  }

  public whenIdle(notebookKey: string): Promise<void> {
    return this.tails.get(notebookKey) ?? Promise.resolve();
  }
}
