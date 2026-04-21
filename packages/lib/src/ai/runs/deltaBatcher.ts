export type DeltaBatcherOptions = {
  runId: string;
  flushIntervalMs?: number;
  flushCharThreshold?: number;
  onFlush: (params: { runId: string; text: string }) => Promise<void>;
};

export type DeltaBatcher = {
  pushToken: (text: string) => void;
  flush: () => Promise<void>;
  dispose: () => Promise<void>;
};

export function createDeltaBatcher(options: DeltaBatcherOptions): DeltaBatcher {
  const { runId, onFlush } = options;
  const flushIntervalMs = options.flushIntervalMs ?? 250;
  const flushCharThreshold = options.flushCharThreshold ?? 800;

  let buffer = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function armTimer(): void {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      scheduleFlush();
    }, flushIntervalMs);
  }

  function scheduleFlush(): Promise<void> {
    if (buffer === '') return chain;
    const text = buffer;
    buffer = '';
    clearTimer();
    chain = chain.then(() => onFlush({ runId, text }));
    return chain;
  }

  function pushToken(text: string): void {
    if (disposed) {
      throw new Error('deltaBatcher: pushToken called on disposed batcher');
    }
    buffer += text;
    if (buffer.length >= flushCharThreshold) {
      scheduleFlush();
      return;
    }
    armTimer();
  }

  function flush(): Promise<void> {
    return scheduleFlush();
  }

  async function dispose(): Promise<void> {
    disposed = true;
    await scheduleFlush();
  }

  return { pushToken, flush, dispose };
}
