/**
 * The one place that decides how long a stream may plausibly still be running.
 *
 * Three independent mechanisms used to answer this question, and they disagreed:
 *
 *   - the heartbeat cap in `stream-lifecycle.ts` (how long a generation keeps declaring
 *     itself alive),
 *   - the abort registry's eviction (how long a stream can still be STOPPED),
 *   - the multicast registry's eviction (how long a stream can still be JOINED).
 *
 * When they disagree, the system lies. With the registries at 10 minutes and the heartbeat
 * at an hour, a deep-research or long tool-loop generation still alive at minute 15 was
 * correctly reported as running by `/active-streams` — and every client rendered it with a
 * Stop button that could not abort it (the abort entry was gone) and could not stream its
 * tokens (the multicast entry was gone). A live stream you cannot watch and cannot stop.
 *
 * So they share one number. Eviction here is a leak backstop, not a policy: a stream that
 * ends normally removes its own entries in `finish()`, so the only things this reclaims are
 * generations whose process died — and holding those a little longer costs nothing next to
 * shipping a Stop button that silently does nothing.
 */
export const STREAM_MAX_LIFETIME_MS = 60 * 60 * 1000;

/**
 * How often the instance that OWNS a stream checks whether someone has asked it to stop.
 *
 * Lives here, next to the horizon above, for exactly the reason that module exists: the numbers
 * below are derived from it, and when a system's timeouts drift apart it starts lying.
 */
export const ABORT_WATCH_INTERVAL_MS = 1_000;

/**
 * How long a Stop waits to learn whether the owning instance actually stopped the stream.
 *
 * It MUST leave real headroom over `ABORT_WATCH_INTERVAL_MS`, and this is not a comfort margin —
 * it is the difference between a true report and a false alarm. The chain a cross-instance abort
 * has to complete is: up to one full tick before the owner even looks (worst-case phase), then the
 * marked-row read, then `abortStream` → `lifecycle.finish` → which first awaits any in-flight parts
 * persist (a whole JSONB write for a long generation) and only then issues the terminal UPDATE.
 *
 * Budget that at ~2× the tick and a single p99 DB spike pushes the terminal write past the
 * deadline — and we would tell the user their agent is "still running and still billing" about a
 * stream that was successfully aborted a moment earlier. The wait costs nothing in the common case
 * (a stream this instance owns is aborted synchronously and never reaches here), so buy the
 * headroom.
 */
export const ABORT_SETTLE_TIMEOUT_MS = 4 * ABORT_WATCH_INTERVAL_MS;

/**
 * The same wait, but spent on a SEND rather than a Stop — a takeover blocks the user's message
 * from going out, so it is deliberately stingier. On expiry the send proceeds regardless (it is a
 * takeover, never a 409), so the cost of being wrong here is a logged warn, not a false alarm at
 * the user.
 */
export const TAKEOVER_SETTLE_TIMEOUT_MS = 2 * ABORT_WATCH_INTERVAL_MS;

/** How often the waiter re-reads the row while the budgets above tick down. */
export const ABORT_SETTLE_POLL_MS = 250;
