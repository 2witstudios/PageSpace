import { pgTable, text, timestamp, integer, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const conversationCompactions = pgTable(
  'conversation_compactions',
  {
    conversationId: text('conversation_id').primaryKey(),
    source: text('source').notNull(),
    pageId: text('page_id'),
    summary: text('summary').notNull().default(''),
    summaryTokens: integer('summary_tokens').notNull().default(0),
    compactedUpToMessageId: text('compacted_up_to_message_id'),
    compactedUpToCreatedAt: timestamp('compacted_up_to_created_at', { mode: 'date' }),
    summaryVersion: integer('summary_version').notNull().default(1),
    summarizerModel: text('summarizer_model'),
    lastCompactedAt: timestamp('last_compacted_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    pageIdIdx: index('conversation_compactions_page_id_idx').on(table.pageId),
    sourceCheck: check(
      'conversation_compactions_source_chk',
      sql`${table.source} IN ('page', 'global')`
    ),
  })
);

export type SelectConversationCompaction = typeof conversationCompactions.$inferSelect;
export type InsertConversationCompaction = typeof conversationCompactions.$inferInsert;
