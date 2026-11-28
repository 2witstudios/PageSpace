/**
 * The conversation rev apply rule — PURE (Agent-Session Single Source of Truth
 * epic, Phase 2 / plan PR 3; spec `docs/2.0-architecture/agent-sessions.md` §3
 * clause 3).
 *
 * No React, no sockets, no DB, no `fetch`. This module is the whole delivery
 * protocol reduced to one decision function, so the correctness argument can be
 * read (and exhaustively tested) without a socket in sight. `useConversationSubscription`
 * is the only IO wrapper around it.
 *
 * THE CONTRACT
 *
 * `conversations.rev` is bumped in the SAME transaction as every durable
 * message/conversation write and the post-write value rides on the event.
 * A subscriber holds that value as a per-conversation watermark. Then:
 *
 *   eventRev <= watermark      the write is already reflected in the cache — DROP.
 *                              (Redelivery, an own-write echo the surface already
 *                              applied, or an event that raced a snapshot that
 *                              already included it.)
 *   eventRev == watermark + 1  exactly the next write — APPLY, advance the watermark.
 *   eventRev >  watermark + 1  a gap: at least one event was never delivered
 *                              (transport is best-effort by design). The cache
 *                              cannot be patched into currency — REFETCH.
 *   truncated payload          the event carries an id-ref instead of the message
 *                              (over `MAX_INLINE_MESSAGE_BYTES`) — there is nothing
 *                              to apply — REFETCH. Unless it is already stale, in
 *                              which case DROP still wins: refetching to re-learn
 *                              something the cache already has is pure cost.
 *
 * TWO DEGENERATE REVS, both deliberate:
 *
 *  - `eventRev === 0` (UNVERSIONED_REV) means the emitter had NO conversations row
 *    to bump (legacy page conversations — see `ContentEmitOptions.skipDirectory` in
 *    `lib/websocket/conversation-events.ts`). A real post-write rev is always >= 1,
 *    because the write that produced the event bumped it. So 0 is "this event
 *    carries no watermark": apply it on its content alone (or refetch if truncated)
 *    and leave the watermark where it was. Comparing it numerically would drop every
 *    such event forever (0 <= any watermark).
 *
 *  - `watermark === null` means the subscriber has no proven baseline yet: an entry
 *    exists (subscribe-on-open guarantees that) but its load has not committed a rev.
 *    Nothing can be proven contiguous against "unknown", so a versioned event is a
 *    REFETCH — the one call that both applies the content and establishes the
 *    watermark. Unversioned events still apply, since they were never going to move
 *    a watermark anyway.
 */

/** A post-write rev of 0 means "the emitter had no row to version" — see the module docblock. */
export const UNVERSIONED_REV = 0;

/**
 * What a subscriber should do with one conversation event.
 *
 * - `drop`    — already reflected; do nothing (do NOT advance the watermark).
 * - `apply`   — write the event's payload into the cache, then advance the watermark
 *               with {@link nextWatermark}.
 * - `refetch` — re-read the conversation from the server; the response's own rev
 *               becomes the new watermark.
 */
export type ConversationApplyDecision = 'drop' | 'apply' | 'refetch';

/** The only two fields of an event this rule reads. */
export interface ConversationRevEvent {
  /** The post-write `conversations.rev` the emitter stamped on the event. */
  rev: number;
  /**
   * True when the event degraded to an id-level `messageRef` because the message
   * exceeded `MAX_INLINE_MESSAGE_BYTES`. There is no content to apply.
   */
  truncated?: boolean;
}

/**
 * The rule. Total, pure, and side-effect free: same inputs, same answer, always.
 *
 * @param event     the incoming event's rev + truncation flag
 * @param watermark the cache entry's current rev, or `null` when no load has
 *                  established one yet
 */
export const decideConversationApply = (
  event: ConversationRevEvent,
  watermark: number | null,
): ConversationApplyDecision => {
  // Not a number we can reason about (a hostile/rolling-deploy payload). Treat it
  // exactly like a gap: the server is the authority, so go ask it.
  if (!Number.isFinite(event.rev) || event.rev < 0) return 'refetch';

  // Unversioned emitter (no conversations row): the event carries content but no
  // watermark. Its content is still authoritative — apply it, or fetch it when the
  // payload was too big to ride along.
  if (event.rev === UNVERSIONED_REV) return event.truncated ? 'refetch' : 'apply';

  // No proven baseline: only a server read can establish one.
  if (watermark === null) return 'refetch';

  // Already reflected. Checked BEFORE truncation, so a redelivered giant message
  // costs nothing.
  if (event.rev <= watermark) return 'drop';

  // Contiguous — but only usable if the payload actually came along.
  if (event.rev === watermark + 1) return event.truncated ? 'refetch' : 'apply';

  // Gap.
  return 'refetch';
};

/**
 * The watermark after an `apply`. Monotonic by construction: an unversioned event
 * (rev 0) leaves the watermark untouched rather than resetting a real one to 0, and
 * a `null` baseline adopts nothing from an unversioned event (there is nothing to
 * adopt).
 *
 * Only call this for decisions that came back `apply`; a `refetch` takes its
 * watermark from the server response instead, and a `drop` moves nothing.
 */
export const nextWatermark = (current: number | null, appliedRev: number): number | null => {
  if (!Number.isFinite(appliedRev) || appliedRev <= UNVERSIONED_REV) return current;
  if (current === null) return appliedRev;
  return appliedRev > current ? appliedRev : current;
};
