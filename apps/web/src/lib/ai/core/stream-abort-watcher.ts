import { loggers } from '@pagespace/lib/logging/logger-config';
import { abortStream, listLocalStreams } from '@/lib/ai/core/stream-abort-registry';
import { decideWatcherActions } from '@/lib/ai/core/stream-abort-decisions';
import { clearAbortMarks, readMarkedStreams } from '@/lib/ai/core/stream-abort-mark';
import { ABORT_WATCH_INTERVAL_MS } from '@/lib/ai/core/stream-horizons';

// Re-exported so the poll's period and the budgets that must outlast it stay one number, defined
// in stream-horizons.ts. See the note there on why these live together.
export { ABORT_WATCH_INTERVAL_MS };

/**
 * The owning end of a cross-instance abort.
 *
 * An abort issued on another instance cannot reach this process's AbortControllers — the registry
 * is an in-memory Map. What it CAN do is record the request on the stream's row. This watcher is
 * what reads it back and performs the abort locally, where the controller actually lives.
 *
 * ── WHY A POLL, AND NOT A PUSH ──────────────────────────────────────────────────────────────────
 *
 * A push (the realtime relay, or Postgres LISTEN/NOTIFY) would be faster, and both are worse here:
 *
 *   - The relay is an emit-only, fire-and-forget fan-out to browsers; no web instance subscribes
 *     to it. Making one would need a socket client in the Next server, a service identity, and a
 *     new room shape on a relay that is deliberately generic — and an instance that is mid-restart
 *     when the abort is broadcast misses it PERMANENTLY. There is no retry.
 *   - LISTEN/NOTIFY is at-most-once with no replay, and delivery only to currently-connected
 *     listeners. A dropped listener socket silently swallows a Stop. (Worse here than elsewhere:
 *     `db.ts` deliberately swallows the connection-error event that would tell us.)
 *
 * A durable mark, by contrast, is still there when the reader comes back — so the worst case
 * degrades to "stops within one tick" instead of "never stops". A Stop's latency budget is about a
 * second; its correctness budget is that it must actually stop. This is also the only shape the AI
 * SDK docs name for a self-hosted backend ("write a cancellation flag that the job checks"), and
 * it reuses the Postgres coordination channel that the heartbeat and the distributed rate limiter
 * already are.
 *
 * ── COST ────────────────────────────────────────────────────────────────────────────────────────
 *
 * Zero while the instance owns no streams: the interval is started lazily by `createStreamLifecycle`
 * and STOPS ITSELF the moment its stream set empties. A busy instance issues one batched,
 * PK-indexed query per second, for all of its live streams at once.
 */

/**
 * Keyed on globalThis, not a module-level `let`.
 *
 * Next dev hot-reload (and any double module instantiation) would otherwise leave the previous
 * module's interval running with no handle to clear it — a leaked timer per reload, each polling
 * the DB forever.
 */
const WATCHER_KEY = Symbol.for('pagespace.streamAbortWatcher');

interface WatcherHandle {
  interval: ReturnType<typeof setInterval> | null;
}

const globalWatcher = globalThis as typeof globalThis & { [WATCHER_KEY]?: WatcherHandle };

const getHandle = (): WatcherHandle => {
  const existing = globalWatcher[WATCHER_KEY];
  if (existing) return existing;
  const handle: WatcherHandle = { interval: null };
  globalWatcher[WATCHER_KEY] = handle;
  return handle;
};

/**
 * One pass: read the marks on the streams WE own, and act only on those we can prove are ours.
 *
 * Exported for tests — the interval body is not otherwise reachable without wall-clock time.
 */
export const runAbortWatchTick = async (): Promise<void> => {
  const localStreams = listLocalStreams();

  if (localStreams.length === 0) {
    stopStreamAbortWatcher();
    return;
  }

  try {
    const markedRows = await readMarkedStreams({
      messageIds: localStreams.map((s) => s.messageId),
    });
    if (markedRows.length === 0) return;

    const { abort, clear, corrupt } = decideWatcherActions({ localStreams, markedRows });

    for (const target of abort) {
      // As the owner named by our OWN row — never by a caller's claim. `abortStream` re-checks it
      // against the registry entry, and also runs the attached finisher, so the row goes terminal
      // as part of stopping the stream rather than depending on a callback that may not fire.
      const result = abortStream({ streamId: target.streamId, userId: target.userId });

      loggers.ai.info('cross-instance abort: consumed abort request for a locally-owned stream', {
        messageId: target.messageId,
        aborted: result.aborted,
        reason: result.reason,
      });
    }

    if (corrupt.length > 0) {
      // Should be unreachable: messageId is a per-request cuid2 primary key, and the row was
      // inserted by the same route that made the registry entry. If the two disagree about who
      // owns the stream, aborting would stop the WRONG USER's generation — so we refuse, and we
      // make it loud. This is an alarm, not a warning.
      loggers.ai.error('cross-instance abort: refused — row owner disagrees with local stream owner', {
        conflicts: corrupt,
      });
    }

    if (clear.length > 0) {
      await clearAbortMarks({ messageIds: clear });
    }
  } catch (error) {
    // Never throw out of an interval. The mark is durable: if this tick failed, the next one
    // reads it again.
    loggers.ai.warn('cross-instance abort: watch tick failed', {
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
};

/**
 * Start the watcher if it is not already running. Idempotent — called on every stream start.
 */
export const ensureStreamAbortWatcher = (): void => {
  const handle = getHandle();
  if (handle.interval) return;

  const interval = setInterval(() => {
    void runAbortWatchTick();
  }, ABORT_WATCH_INTERVAL_MS);

  // Same as the lifecycle heartbeat: a polling timer must never be the reason a process refuses
  // to exit.
  interval.unref?.();
  handle.interval = interval;
};

export const stopStreamAbortWatcher = (): void => {
  const handle = getHandle();
  if (!handle.interval) return;
  clearInterval(handle.interval);
  handle.interval = null;
};

export const isStreamAbortWatcherRunning = (): boolean => getHandle().interval !== null;
