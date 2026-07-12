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
  lastHeartbeatAt: timestamp('last_heartbeat_at', { mode: 'date' }).defaultNow().notNull(),
  completedAt:    timestamp('completed_at', { mode: 'date' }),
}, (table) => ({
  channelStatusIdx: index('ai_stream_sessions_channel_status_idx').on(table.channelId, table.status),
  // Per-conversation in-flight lookup for the takeover guard in POST /api/ai/chat.
  conversationStatusIdx: index('ai_stream_sessions_conversation_status_idx').on(table.conversationId, table.status),
}));
