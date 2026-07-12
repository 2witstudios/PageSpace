import { STREAM_MAX_LIFETIME_MS } from '@/lib/ai/core/stream-horizons';

/**
 * Liveness and takeover decisions for server-owned streams.
 *
 * Pure functions — no DB, no I/O. The callers (the takeover guard on both chat routes,
 * and GET /api/ai/chat/active-streams) supply the rows and the clock.
 *
 * WHY LIVENESS IS A HEARTBEAT AND NOT A STATUS
 *
 * `ai_stream_sessions.status` cannot be trusted on its own. The terminal write
 * that flips it off `'streaming'` is fire-and-forget (see `stream-lifecycle.ts`)
 * and dies with the process, so a crashed or redeployed generation leaves a row
 * that says `'streaming'` forever. Anything that *blocks* on such a row (a 409
 * on concurrent send, say) would lock the user out of their own conversation.
 * So we carry `lastHeartbeatAt`, written on a dedicated interval by the generation
 * itself, and treat a row with a stale heartbeat as dead.
 *
 * Liveness gates only what may be driven TERMINAL. It must never gate an abort — see
 * `decideStreamTakeover` below.
 */

/**
 * A row is live if it has beaten recently.
 *
 * The heartbeat is written on a fixed interval by the generation itself (see
 * HEARTBEAT_INTERVAL_MS in stream-lifecycle.ts) — deliberately NOT off the
 * parts checkpoint. A stream sitting in a long tool call (sandbox exec, deep
 * research, a slow MCP tool) pushes no parts at all for minutes, so a
 * checkpoint-driven heartbeat would declare a perfectly healthy stream dead: it
 * would vanish from `/active-streams` (no client could attach to it) and the next
 * send would fail to stop it.
 *
 * The window below is several missed beats wide, so an ordinary GC pause or a slow
 * DB write never trips it, while a crashed process stops being served as a phantom
 * "streaming" ghost within a couple of minutes.
 */
export const STREAM_HEARTBEAT_STALE_MS = 2 * 60 * 1000;

export interface StreamLivenessRow {
  messageId: string;
  lastHeartbeatAt: Date | null;
  startedAt: Date;
}

/**
 * Did this row stop beating because the CAP stopped it, rather than because its process died?
 *
 * The lifecycle caps the heartbeat at `startedAt + STREAM_MAX_LIFETIME_MS` — deliberately, as a
 * backstop against a leaked interval (see MAX_HEARTBEAT_MS there). The GENERATION has no such cap:
 * a long tool loop or a deep-research run can still be going at T+61min. So a silent heartbeat past
 * the cap is the EXPECTED state of a perfectly healthy stream, and driving such a row terminal
 * would write `status='aborted', parts=[]` over a stream that is still generating — hiding it from
 * every subscriber, destroying its only crash-recovery snapshot, and leaving it calling write tools
 * and billing.
 *
 * BUT "IS IT OLD?" IS THE WRONG QUESTION, and asking it that way is a trap I fell into: it makes
 * every row older than the cap unreconcilable, INCLUDING one whose process crashed at minute five
 * and which nobody looked at for an hour. That row is definitively dead, yet it would sit at
 * 'streaming' forever — poisoning every future Stop on its conversation with a false "may still be
 * running", and every future send with a warn. A permanent ghost. Trading a rare harm (a live >1h
 * stream terminal-written) for a common one (any crash, plus an hour) is a bad trade.
 *
 * The right question is WHERE the beat stopped, and the row already tells us:
 *
 *   - A stream still alive at the cap beat right UP TO it   → lastHeartbeatAt ≈ startedAt + cap.
 *   - A stream that crashed at minute five stopped there    → lastHeartbeatAt ≈ startedAt + 5min.
 *
 * So a beat that reached the cap is ambiguous (the silence is by design; we cannot prove death, so
 * we do not touch it), while a beat that stopped short of it is proof the process died — at any
 * age. One margin of slack, so the final beat before the cap is not mistaken for an early death.
 */
export const heartbeatStoppedAtCap = (
  row: StreamLivenessRow,
  staleAfterMs: number = STREAM_HEARTBEAT_STALE_MS,
): boolean => {
  const beat = row.lastHeartbeatAt ?? row.startedAt;
  const beatAge = beat.getTime() - row.startedAt.getTime();
  return beatAge >= STREAM_MAX_LIFETIME_MS - staleAfterMs;
};

/**
 * The backstop. Nothing may be un-reapable FOREVER.
 *
 * `heartbeatStoppedAtCap` deliberately refuses to judge a row whose beat ran to the cap — it cannot
 * tell a healthy long generation from a process that crashed in the last minutes before the cap.
 * That protects the live one, but it leaves the crashed one at `status='streaming'` with nothing in
 * the system able to reap it. A single permanent ghost is not a cosmetic wart: the abort path's
 * batch verdict is pessimistic, so ONE such row makes every future Stop on its conversation report
 * "may still be running" (about generations that stopped perfectly), and makes every future send
 * pay the takeover's wait and log a warn. Forever.
 *
 * So there is an outer horizon, and past it we judge anyway. It is set well beyond the point where
 * the rest of the system has already given up on the stream: the abort registry evicts its entry at
 * STREAM_MAX_LIFETIME_MS, and so does the multicast registry — meaning a generation still running
 * out here can no longer be stopped, joined, or watched by anyone. Its row claiming 'streaming' in
 * perpetuity is a worse lie than declaring it over, and this is the only thing that converges.
 */
const RECONCILE_BACKSTOP_MS = 2 * STREAM_MAX_LIFETIME_MS;

export const isBeyondReconcileBackstop = (row: StreamLivenessRow, now: number): boolean =>
  now - row.startedAt.getTime() > RECONCILE_BACKSTOP_MS;

/**
 * May this row be driven TERMINAL on the strength of its heartbeat alone?
 *
 * The one predicate both terminal writers share (`decideStreamTakeover` and `decideAbortOutcome`),
 * so they cannot drift apart on the one write that is unforgiving in both directions: reap a live
 * stream and you erase it mid-flight; fail to reap a dead one and it haunts its conversation.
 */
export const isProvablyDead = (
  row: StreamLivenessRow,
  now: number,
  staleAfterMs: number = STREAM_HEARTBEAT_STALE_MS,
): boolean => {
  if (isStreamRowLive(row, now, staleAfterMs)) return false;
  // Its beat stopped short of the cap: a dead process, at any age.
  if (!heartbeatStoppedAtCap(row, staleAfterMs)) return true;
  // Its beat ran to the cap, so it is ambiguous — until the outer horizon, where we judge anyway.
  return isBeyondReconcileBackstop(row, now);
};

export const isStreamRowLive = (
  row: StreamLivenessRow,
  now: number,
  staleAfterMs: number = STREAM_HEARTBEAT_STALE_MS,
): boolean => {
  // The column is NOT NULL DEFAULT now(), so this fallback is defensive only — it exists
  // so a caller that projects the column loosely (or a future nullable variant) degrades
  // to "aged from startedAt" rather than to a crash on `null.getTime()`.
  const beat = row.lastHeartbeatAt ?? row.startedAt;
  return now - beat.getTime() < staleAfterMs;
};

export interface StreamTakeoverDecision {
  /**
   * Streams to attempt to abort. This is EVERY row, live-looking or not.
   *
   * Aborting is free for a messageId the in-process registry doesn't know
   * (`abortStreamByMessageId` returns `{aborted:false}` — it does not throw), while
   * *skipping* the abort for a row we misjudged as dead leaves a real generation
   * running and starts a second one alongside it. The asymmetry is total, so we
   * never let a liveness guess gate the abort.
   */
  abort: string[];
  /**
   * Rows to drive terminal. ONLY the rows we can prove are finished: the ones the
   * abort registry actually stopped, plus the ones whose heartbeat says the process
   * that owned them is gone.
   *
   * A row we could NOT abort and that still looks alive is deliberately left alone.
   * Writing `status='aborted', parts=[]` over a still-generating stream would be a
   * lie with teeth: it hides the stream from `/active-streams` (so no client can
   * attach to it) and destroys the parts snapshot that is its only crash-recovery
   * copy — while the generation keeps running, keeps calling tools, and keeps
   * billing.
   */
  reconcile: string[];
}

/**
 * TAKEOVER, NOT 409.
 *
 * A second send on a conversation that already has an in-flight stream must end with
 * exactly one generation running — but rejecting the send is the wrong way to get
 * there. It would self-lock the conversation behind any row whose terminal write
 * never landed (see above). So instead: try to abort everything in flight, drive
 * terminal what we provably stopped or that is provably dead, and proceed.
 *
 * Call this AFTER attempting the aborts, so the outcome of each abort is known.
 */
export const decideStreamTakeover = ({
  rows,
  abortedMessageIds,
  now,
  staleAfterMs = STREAM_HEARTBEAT_STALE_MS,
}: {
  rows: StreamLivenessRow[];
  /** messageIds the in-process abort registry reported it actually aborted. */
  abortedMessageIds?: readonly string[];
  now: number;
  staleAfterMs?: number;
}): StreamTakeoverDecision => {
  const aborted = new Set(abortedMessageIds ?? []);
  return {
    abort: rows.map((r) => r.messageId),
    reconcile: rows
      .filter((r) => (
        // We stopped it. Proven finished, whatever its heartbeat says.
        aborted.has(r.messageId)
        // Or its heartbeat proves the process is gone. See isProvablyDead — the single predicate
        // both terminal writers share, so they cannot drift apart on this one unforgiving write.
        || isProvablyDead(r, now, staleAfterMs)
      ))
      .map((r) => r.messageId),
  };
};
