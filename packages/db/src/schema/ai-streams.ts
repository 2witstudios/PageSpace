import { pgTable, text, timestamp, jsonb, integer, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core';

export const aiStreamSessions = pgTable('ai_stream_sessions', {
  messageId:      text('message_id').primaryKey(),
  channelId:      text('channel_id').notNull(),
  conversationId: text('conversation_id').notNull(),
  // The stream's OWNER. The authz anchor for every abort: a Stop may only ever stop the
  // caller's own streams, and this column — not any client-supplied claim — is what says so.
  userId:         text('user_id').notNull(),
  displayName:    text('display_name').notNull().default('Someone'),
  browserSessionId: text('browser_session_id').notNull().default(''),
  status:         text('status', { enum: ['streaming', 'complete', 'aborted'] }).notNull().default('streaming'),
  // Periodic snapshot of the accumulated UIMessagePart[] buffer (debounced,
  // not written per-token, and — as of the time-based checkpoint cadence —
  // merged/capped rather than raw: see rawPartsCount below for why the two
  // diverge). Lets a client restore mid-stream content after the originator's
  // process dies, without depending on the live multicast.
  parts:          jsonb('parts').$type<unknown[]>().notNull().default([]),
  // How many RAW parts (one per pushed chunk — every text delta, every tool-call state
  // transition) were reflected in this checkpoint, BEFORE `parts` above was merged and
  // capped for storage. `parts.length` alone cannot answer this: mergeConsecutiveTextParts
  // folds many raw text-delta chunks into one entry, so the merged array is always <= the
  // true raw count.
  //
  // This is NOT redundant with `parts` — it is the one thing a client needs that the
  // merged snapshot cannot provide. `streamMulticastRegistry`'s live buffer (the thing a
  // rejoining client's SSE join replays) is always raw, one entry per pushed chunk. A
  // client that seeds its store from `parts` (already-merged, cheap to render) and then
  // joins the live replay must skip exactly the number of RAW frames already reflected in
  // that seed, or it re-applies chunks whose content is already rendered — text is
  // additive-concat with no idempotency, so under-skipping duplicates visible text.
  // `parts.length` used to be a safe proxy for this (the old checkpoint persisted the raw
  // buffer verbatim), but merging broke that equivalence. See
  // apps/web/src/hooks/useChannelStreamSocket.ts's skipReplayCount usage.
  //
  // Additive with a default, and a client on an old build simply falls back to
  // `parts.length` (correct there since old rows had no merging) — safe across a rolling
  // deploy in both directions.
  rawPartsCount:  integer('raw_parts_count').notNull().default(0),
  startedAt:      timestamp('started_at', { mode: 'date' }).defaultNow().notNull(),
  // Written on a dedicated interval by the generation (and also refreshed by each parts
  // checkpoint). It CANNOT ride the checkpoint alone: a stream inside a long tool call
  // pushes no parts for minutes, and a checkpoint-driven heartbeat would declare it dead.
  // `status` alone cannot establish liveness either: the terminal write is fire-and-forget
  // and dies with the process, so a crashed generation leaves a row that claims
  // 'streaming' forever. A row whose heartbeat is stale is dead — it must never block a
  // new send, and must never be served to a client as an active stream.
  //
  // ROLLOUT NOTE — this column makes liveness heartbeat-authoritative, and OLD workers do not
  // beat. During a deploy, a stream started by a pre-heartbeat worker gets `now()` from the
  // DEFAULT once and never refreshes it, so ~2 minutes later this code calls it dead: it drops
  // out of /active-streams, and a takeover drives its row terminal while it is still generating.
  //
  // Deliberately not gated behind a two-phase flag, because the blast radius is smaller than the
  // flag would be:
  //   - No content is lost. The assistant message is persisted through the normal
  //     message-persistence path, not through this table — `parts` here is only a mid-stream
  //     crash-recovery snapshot, and the old worker's own terminal write corrects `status` when
  //     it finishes.
  //   - The worst case is a concurrent generation on that conversation, which is EXACTLY what
  //     master does today (master has no takeover at all). So an old-worker conversation simply
  //     behaves as it does now until its worker drains.
  //   - The window is one rolling-deploy drain, and streams are minutes long.
  //
  // It is still a window. Deploy with a rolling strategy that lets old machines finish their
  // in-flight streams (Fly does this by default); do not hard-cut all workers at once.
  lastHeartbeatAt: timestamp('last_heartbeat_at', { mode: 'date' }).defaultNow().notNull(),
  completedAt:    timestamp('completed_at', { mode: 'date' }),

  // The abort registry's key for this generation, minted server-side and handed to the client
  // in the `X-Stream-Id` response header. Persisted because the registry is IN-PROCESS: without
  // this column, a streamId names a stream only on the one instance that owns it, and a Stop
  // that load-balances anywhere else cannot even resolve which row the client means.
  //
  // It is also the EPOCH. `abortRequestedAt` is cleared when a row is re-registered, but a
  // cleared column is a promise that some future edit to that INSERT can silently break — so the
  // watcher additionally refuses to abort unless the marked row's streamId matches the local
  // registry entry's. A mark written against attempt N can then never stop attempt N+1.
  streamId:       text('stream_id'),

  // The cross-instance abort mailbox, and the whole reason this file changed.
  //
  // Streams are server-owned and disconnect-immune, so the ONLY thing that stops a generation is
  // an explicit server-side abort — but the abort registry is an in-memory Map, and prod runs
  // multiple web instances. A Stop that lands on an instance which does not own the stream used
  // to be a guaranteed no-op: the agent kept generating, kept calling write tools, and kept
  // billing, while the UI flipped back to Send.
  //
  // So the receiving instance writes its intent HERE, and the owning instance — which polls its
  // own in-flight rows — consumes it and aborts locally.
  //
  // SECURITY: this column is a request, not a capability. The only writer is an UPDATE whose
  // WHERE clause carries the caller's user_id (see `markAbortRequested`), so a user can only ever
  // mark their OWN stream. There is no message to forge and no payload to trust; the owner
  // re-reads `user_id` from its own row before aborting. Do not add a marking helper that omits
  // the user_id predicate — that would hand a remote kill switch for other users' streams to
  // anyone holding a messageId. (The one deliberate exception, `markAbortRequestedAsOwner`, is
  // the takeover path, and it is documented at its definition.)
  abortRequestedAt: timestamp('abort_requested_at', { mode: 'date' }),
}, (table) => ({
  channelStatusIdx: index('ai_stream_sessions_channel_status_idx').on(table.channelId, table.status),
  // Per-conversation in-flight lookup for the takeover guard in POST /api/ai/chat.
  conversationStatusIdx: index('ai_stream_sessions_conversation_status_idx').on(table.conversationId, table.status),
  // Unique, not merely indexed: a streamId names exactly one generation, and the abort UPDATE
  // resolves a row BY it. If two rows could share one, a single Stop would mark both. Existing
  // rows are all NULL, and Postgres treats NULLs as distinct, so this is safe to add in place.
  streamIdIdx: uniqueIndex('ai_stream_sessions_stream_id_idx').on(table.streamId),
}));

/**
 * Pre-generation abort intents.
 *
 * Closes the pre-INSERT preflight window (#2028 item 1). `createStreamLifecycle` runs at the END
 * of a route's preflight — after auth, permissions, message persistence, and context assembly
 * (0.5-3s). A Stop pressed during that window finds no `ai_stream_sessions` row to mark, no
 * registry entry to abort, and silently does nothing. The generation then starts a moment later
 * and runs to completion: write tools, billing, the lot.
 *
 * This table records a durable "stop whatever of MINE starts on this conversation" intent,
 * keyed by (conversation_id, user_id). `createStreamLifecycle` consumes it at INSERT time and,
 * if present, aborts the stream immediately rather than letting it generate.
 *
 * SECURITY: same model as `ai_stream_sessions.abort_requested_at`. A row here can only be written
 * by a Stop that has already authenticated as `user_id`, and it can only be consumed by
 * `createStreamLifecycle`, which receives `userId` from the authenticated route. There is no
 * forgeable payload — the composite PK (conversation_id, user_id) IS the authorization.
 */
export const aiPendingAbortIntents = pgTable('ai_pending_abort_intents', {
  conversationId: text('conversation_id').notNull(),
  userId:         text('user_id').notNull(),
  createdAt:      timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.conversationId, table.userId] }),
}));
