/**
 * The decisions behind a CROSS-INSTANCE stream abort.
 *
 * Pure functions — no DB, no timers, no I/O. The shells (`stream-abort-mark.ts`,
 * `stream-abort-watcher.ts`) supply the rows and the clock, exactly as `stream-takeover.ts`
 * supplies them to `stream-liveness.ts`.
 *
 * WHY THIS MODULE EXISTS
 *
 * The abort registry is an in-memory Map, and prod runs multiple web instances. An abort that
 * load-balances to an instance which does not own the stream can find nothing to abort — and
 * because streams are server-owned and disconnect-immune, cancelling the client's fetch stops
 * NOTHING. So the receiving instance records its intent on the stream's row
 * (`ai_stream_sessions.abort_requested_at`) and the OWNING instance consumes it.
 *
 * That makes two judgements load-bearing, and both live here:
 *
 *   1. WHICH marked rows may this instance act on? (`decideWatcherActions`)
 *   2. Did the abort actually WORK, and if not, is the stream really still running?
 *      (`decideAbortOutcome`)
 *
 * Getting (1) wrong is a security bug: aborting a row we do not own is a remote kill switch for
 * another user's generation. Getting (2) wrong is a credibility bug: telling a user their agent
 * is "still running and still billing" when it is already dead is the kind of false alarm that
 * teaches people to ignore the alarm that matters.
 */

import { isStreamRowLive, STREAM_HEARTBEAT_STALE_MS, type StreamLivenessRow } from '@/lib/ai/core/stream-liveness';

/**
 * The outcome a caller reports to the client.
 *
 * - `aborted`     — the generation is stopped. Proven, not assumed.
 * - `not_found`   — there was no in-flight stream to stop. A BENIGN race (Stop pressed a beat
 *                   after the stream ended). The client must stay SILENT: this fires often, and a
 *                   toast here trains users to ignore the one below.
 * - `unconfirmed` — a stream was found, an abort was requested, and it is STILL RUNNING. Still
 *                   calling write tools. Still billing. This is the only code that may ever
 *                   surface to the user.
 */
export type AbortCode = 'aborted' | 'not_found' | 'unconfirmed';

/** A stream this process owns — i.e. one whose AbortController is in this instance's registry. */
export interface LocalStreamEntry {
  messageId: string;
  streamId: string;
  userId: string;
}

/** A row someone has asked us to abort (`abort_requested_at IS NOT NULL AND status='streaming'`). */
export interface MarkedStreamRow {
  messageId: string;
  streamId: string | null;
  /** The stream's OWNER, read from our own DB row. Never a claim from a caller. */
  userId: string;
}

export interface WatcherActions {
  /** Aborts to perform locally, each as the owner named by the row itself. */
  abort: { messageId: string; streamId: string; userId: string }[];
  /** messageIds whose mark can never be actioned and must be cleared, or it is re-read forever. */
  clear: string[];
  /** Should be impossible. Loud rather than silent — see below. */
  corrupt: { messageId: string; localUserId: string; rowUserId: string }[];
}

/**
 * Decide what this instance may do about the rows currently marked for abort.
 *
 * THE AUTHORIZATION STORY, in full, because this is the highest-risk code in the change:
 *
 * The mark itself carries no identity. It cannot be forged, because the only thing that writes it
 * is an UPDATE whose WHERE clause carries the requesting user's id (`markAbortRequested`), so a
 * user can only ever mark a row they already own. There is no message on a wire, no payload to
 * trust, and nothing an attacker can hand us.
 *
 * This function then re-authorizes anyway, against our OWN view of the world:
 *
 *   - A row we have no local entry for is IGNORED — never cleared. Clearing another instance's
 *     mark would consume the request without performing the abort, and the user's Stop would
 *     silently do nothing. That is the original bug, reintroduced.
 *   - A row whose `streamId` does not match our live entry's is a mark for a PREVIOUS generation
 *     (the row is reused via onConflictDoUpdate). It must never stop the current one. The insert
 *     also resets `abort_requested_at`, but a cleared column is a promise the next edit can
 *     silently break, so the epoch is checked here too — belt and braces.
 *   - A row whose owner disagrees with our entry's owner is refused outright. It should be
 *     impossible (messageId is a per-request cuid2 PK, inserted by the same route that made the
 *     registry entry), and if it ever happens, an abort would stop the WRONG USER's generation.
 */
export const decideWatcherActions = ({
  localStreams,
  markedRows,
}: {
  localStreams: readonly LocalStreamEntry[];
  markedRows: readonly MarkedStreamRow[];
}): WatcherActions => {
  const byMessageId = new Map(localStreams.map((s) => [s.messageId, s]));
  const actions: WatcherActions = { abort: [], clear: [], corrupt: [] };

  for (const row of markedRows) {
    const localEntry = byMessageId.get(row.messageId);

    // Not ours. Leave the mark exactly where it is — its owner has not read it yet.
    if (!localEntry) continue;

    // A mark for a generation that has already been superseded. Unactionable: clear it, or the
    // watcher re-reads it on every tick for the life of the row.
    if (row.streamId !== localEntry.streamId) {
      actions.clear.push(row.messageId);
      continue;
    }

    if (row.userId !== localEntry.userId) {
      actions.corrupt.push({
        messageId: row.messageId,
        localUserId: localEntry.userId,
        rowUserId: row.userId,
      });
      continue;
    }

    // Abort as the owner named by the DB row. `abortStream`'s IDOR guard then re-checks this
    // against the registry entry, so the two must agree for anything to happen.
    actions.abort.push({
      messageId: row.messageId,
      streamId: localEntry.streamId,
      userId: row.userId,
    });
  }

  return actions;
};

/** A row as it stands after we waited for the abort to land. */
export interface SettleRow extends StreamLivenessRow {
  status: 'streaming' | 'complete' | 'aborted';
}

export interface AbortOutcome {
  /** Streams proven stopped. */
  aborted: string[];
  /** Streams whose OWNER IS GONE — the caller must drive these rows terminal itself. */
  reconcile: string[];
  /** Streams genuinely still generating on an instance that did not consume the mark. */
  stillLive: string[];
  code: AbortCode;
}

/**
 * Did the abort work?
 *
 * The naive version of this — "did the row go terminal within the timeout, yes or no" — is WRONG,
 * and would produce the worst possible failure: a "your agent is still running and still billing"
 * warning about a generation that is already dead.
 *
 * The reason is that the owning instance can CRASH. Its stream dies with it, but nothing then
 * consumes the mark and nothing writes the terminal status, so the row sits at 'streaming'
 * forever and every wait on it times out. A timeout therefore does not mean "still running" — it
 * means "nobody told us it stopped", and those are very different claims.
 *
 * The heartbeat already distinguishes them, which is exactly what `stream-liveness.ts` is for.
 * So compose with it rather than inventing a second notion of liveness:
 *
 *   - terminal status          → stopped. Proven.
 *   - streaming, heartbeat DEAD → the owner is gone; the stream died with it. Report it stopped,
 *                                 and hand the row back to be driven terminal — precisely what
 *                                 `decideStreamTakeover().reconcile` already licenses for a stale
 *                                 row. No alarm: nothing is running.
 *   - streaming, heartbeat LIVE → it really is still generating somewhere. ALARM.
 *   - no row at all             → a stream with no row cannot be running. Stopped.
 *
 * A batch verdict is pessimistic: one still-live stream is still burning the user's credits, and
 * must not be masked by the siblings that did stop.
 */
export const decideAbortOutcome = ({
  requested,
  rows,
  now,
  staleAfterMs = STREAM_HEARTBEAT_STALE_MS,
}: {
  /** messageIds we asked to be aborted. Empty means we found nothing to stop. */
  requested: readonly string[];
  /** The rows as they stand now. A requested id with no row here has no row at all. */
  rows: readonly SettleRow[];
  now: number;
  staleAfterMs?: number;
}): AbortOutcome => {
  const byMessageId = new Map(rows.map((r) => [r.messageId, r]));
  const outcome: AbortOutcome = { aborted: [], reconcile: [], stillLive: [], code: 'not_found' };

  for (const messageId of requested) {
    const row = byMessageId.get(messageId);

    if (!row || row.status !== 'streaming') {
      outcome.aborted.push(messageId);
      continue;
    }

    if (!isStreamRowLive(row, now, staleAfterMs)) {
      outcome.aborted.push(messageId);
      outcome.reconcile.push(messageId);
      continue;
    }

    outcome.stillLive.push(messageId);
  }

  outcome.code = outcome.stillLive.length > 0
    ? 'unconfirmed'
    : outcome.aborted.length > 0
      ? 'aborted'
      : 'not_found';

  return outcome;
};
