/**
 * Shutdown sequencing for processes that buffer telemetry (#890 Phase 3 FIX).
 *
 * The logger's flush feeds rows INTO the ClickHouse insert buffers
 * (writeLogsToDatabase → analytics-inserts), so the order is load-bearing:
 * flush logs first, then drain the analytics buffers, then exit. The old
 * handler fire-and-forgot flush() and called process.exit(0) synchronously —
 * losing up to 500 buffered rows per table on every deploy.
 *
 * Pure core: the sequencing is a factory over injected effects, testable
 * without real signals or a real process.
 */

export interface ShutdownHandlerDeps {
  flushLogs: () => Promise<void>;
  drainAnalytics: () => Promise<void>;
  exit: (code: number) => void;
  /** Receives payload-free failure notes; defaults to console.error. */
  logError?: (message: string) => void;
}

export function createShutdownHandler(deps: ShutdownHandlerDeps): () => Promise<void> {
  const logError = deps.logError ?? ((message: string) => console.error(message));
  let running: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    try {
      await deps.flushLogs();
    } catch (error) {
      logError(`[shutdown] log flush failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await deps.drainAnalytics();
    } catch (error) {
      logError(`[shutdown] analytics drain failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    deps.exit(0);
  };

  return () => {
    // A second signal while the first shutdown is in flight must not restart
    // the sequence (or exit before the drain completes).
    if (!running) running = run();
    return running;
  };
}
