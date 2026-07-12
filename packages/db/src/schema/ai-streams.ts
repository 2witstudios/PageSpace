import { pgTable, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

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
  // not written per-token). Lets a client restore mid-stream content after
  // the originator's process dies, without depending on the live multicast.
  parts:          jsonb('parts').$type<unknown[]>().notNull().default([]),
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
