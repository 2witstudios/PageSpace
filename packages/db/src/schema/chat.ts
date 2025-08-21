import { pgTable, text, timestamp, jsonb, boolean, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { pages, drives } from './core';
import { createId } from '@paralleldrive/cuid2';

export const channelMessages = pgTable('channel_messages', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  content: text('content').notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  pageId: text('pageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
}, (table) => {
    return {
        pageIdx: index('channel_messages_page_id_idx').on(table.pageId),
    }
});

export const channelMessagesRelations = relations(channelMessages, ({ one }) => ({
    page: one(pages, {
        fields: [channelMessages.pageId],
        references: [pages.id],
    }),
    user: one(users, {
        fields: [channelMessages.userId],
        references: [users.id],
    }),
}));

