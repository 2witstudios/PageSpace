import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';

export const aiStreamSessions = pgTable('ai_stream_sessions', {
  messageId:      text('message_id').primaryKey(),
  channelId:      text('channel_id').notNull(),
  conversationId: text('conversation_id').notNull(),
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
}, (table) => ({
  channelStatusIdx: index('ai_stream_sessions_channel_status_idx').on(table.channelId, table.status),
  // Per-conversation in-flight lookup for the takeover guard in POST /api/ai/chat.
  conversationStatusIdx: index('ai_stream_sessions_conversation_status_idx').on(table.conversationId, table.status),
}));
