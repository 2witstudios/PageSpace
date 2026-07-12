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
