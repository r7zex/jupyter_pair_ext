/** Retry a lost initial-state request while allowing a large, progressing transfer. */
export async function waitForInitialState(options: {
  ready: Promise<void>;
  progressAt: () => number;
  request: () => void;
  signal?: AbortSignal | undefined;
  idleMs?: number;
  maximumMs?: number;
  retryMs?: number;
}): Promise<void> {
  const started = Date.now();
  const idleMs = options.idleMs ?? 45_000;
  const maximumMs = options.maximumMs ?? 180_000;
  const retryMs = options.retryMs ?? 10_000;
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const waiting = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('Session connection cancelled.'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    timer = setInterval(() => {
      const now = Date.now();
      if (now - Math.max(started, options.progressAt()) >= idleMs || now - started >= maximumMs) {
        reject(new Error('The host stopped providing initial project state. Check the peer route or use a WebSocket relay.'));
        return;
      }
      try { options.request(); } catch (error) { reject(error); }
    }, Math.min(retryMs, idleMs));
  });
  try {
    options.request();
    await Promise.race([options.ready, waiting]);
  } finally {
    if (timer) clearInterval(timer);
    if (abort) options.signal?.removeEventListener('abort', abort);
  }
}
