import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';

export const aiStreamSessions = pgTable('ai_stream_sessions', {
  messageId:      text('message_id').primaryKey(),
  channelId:      text('channel_id').notNull(),
  conversationId: text('conversation_id').notNull(),
  userId:         text('user_id').notNull(),
  displayName:    text('display_name').notNull().default('Someone'),
  browserSessionId: text('browser_session_id').notNull().default(''),
  status:         text('status', { enum: ['streaming', 'complete', 'aborted'] }).notNull().default('streaming'),
  startedAt:      timestamp('started_at', { mode: 'date' }).defaultNow().notNull(),
  completedAt:    timestamp('completed_at', { mode: 'date' }),
}, (table) => ({
  channelStatusIdx: index('ai_stream_sessions_channel_status_idx').on(table.channelId, table.status),
}));
