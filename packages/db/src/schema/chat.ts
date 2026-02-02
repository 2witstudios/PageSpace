import { pgTable, text, timestamp, jsonb, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { pages, drives } from './core';
import { files } from './storage';
import { createId } from '@paralleldrive/cuid2';

export const channelMessages = pgTable('channel_messages', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  content: text('content').notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  pageId: text('pageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // File attachment (optional)
  fileId: text('fileId').references(() => files.id, { onDelete: 'set null' }),
  // Attachment metadata: {originalName, size, mimeType, contentHash}
  attachmentMeta: jsonb('attachmentMeta').$type<{
    originalName: string;
    size: number;
    mimeType: string;
    contentHash: string;
  } | null>(),
}, (table) => {
    return {
        pageIdx: index('channel_messages_page_id_idx').on(table.pageId),
        fileIdx: index('channel_messages_file_id_idx').on(table.fileId),
    }
});

export const channelMessagesRelations = relations(channelMessages, ({ one, many }) => ({
    page: one(pages, {
        fields: [channelMessages.pageId],
        references: [pages.id],
    }),
    user: one(users, {
        fields: [channelMessages.userId],
        references: [users.id],
    }),
    file: one(files, {
        fields: [channelMessages.fileId],
        references: [files.id],
    }),
    reactions: many(channelMessageReactions),
}));

/**
 * Channel message reactions - emoji reactions on channel messages
 *
 * Each user can add one reaction per emoji per message.
 * Supports any Unicode emoji (stored as text).
 */
export const channelMessageReactions = pgTable('channel_message_reactions', {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    messageId: text('messageId').notNull().references(() => channelMessages.id, { onDelete: 'cascade' }),
    userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
    // One reaction per user per emoji per message
    uniqueReaction: uniqueIndex('unique_reaction_idx').on(table.messageId, table.userId, table.emoji),
    // Fast lookup by message
    messageIdx: index('reaction_message_idx').on(table.messageId),
}));

export const channelMessageReactionsRelations = relations(channelMessageReactions, ({ one }) => ({
    message: one(channelMessages, {
        fields: [channelMessageReactions.messageId],
        references: [channelMessages.id],
    }),
    user: one(users, {
        fields: [channelMessageReactions.userId],
        references: [users.id],
    }),
}));

