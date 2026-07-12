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
      .filter((r) => aborted.has(r.messageId) || !isStreamRowLive(r, now, staleAfterMs))
      .map((r) => r.messageId),
  };
};
