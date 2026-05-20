import { pgTable, text, timestamp, jsonb, boolean, integer, index, uniqueIndex, primaryKey, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { pages, drives } from './core';
import { files, type AttachmentMeta } from './storage';
import { createId } from '@paralleldrive/cuid2';

export const channelMessages = pgTable('channel_messages', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  content: text('content').notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  pageId: text('pageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // File attachment (optional)
  fileId: text('fileId').references(() => files.id, { onDelete: 'set null' }),
  attachmentMeta: jsonb('attachmentMeta').$type<AttachmentMeta | null>(),
  // Soft-delete flag for rollback support (matches messages/chatMessages pattern)
  isActive: boolean('isActive').default(true).notNull(),
  editedAt: timestamp('editedAt', { mode: 'date' }),
  // AI sender metadata: set when message is posted by an AI tool
  aiMeta: jsonb('aiMeta').$type<{
    senderType: 'global_assistant' | 'agent';
    senderName: string;
    agentPageId?: string;
  } | null>(),
  // Threading: parentId points at the thread root (top-level message). Replies are
  // exactly one level deep, so a parent must itself have parentId IS NULL.
  parentId: text('parentId').references((): AnyPgColumn => channelMessages.id, { onDelete: 'cascade' }),
  replyCount: integer('replyCount').default(0).notNull(),
  lastReplyAt: timestamp('lastReplyAt', { mode: 'date' }),
  // When "Also send to channel" mirrors a thread reply to the top-level stream,
  // the top-level copy carries mirroredFromId pointing at the thread reply's id.
  mirroredFromId: text('mirroredFromId').references((): AnyPgColumn => channelMessages.id, { onDelete: 'set null' }),
  // Inline quote reply: top-level message embedding another in the same channel.
  // Orthogonal to threading — quoted messages are top-level (parentId IS NULL) and
  // live in the main feed. onDelete: 'set null' so a quote-reply outlives a hard
  // delete of its source; soft-deletes leave the FK intact for tombstone rendering.
  quotedMessageId: text('quotedMessageId').references((): AnyPgColumn => channelMessages.id, { onDelete: 'set null' }),
}, (table) => {
    return {
        pageIdx: index('channel_messages_page_id_idx').on(table.pageId),
        fileIdx: index('channel_messages_file_id_idx').on(table.fileId),
        parentCreatedIdx: index('channel_messages_parent_created_idx').on(table.parentId, table.createdAt),
        quotedIdx: index('channel_messages_quoted_id_idx').on(table.quotedMessageId),
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
    mirroredFrom: one(channelMessages, {
        fields: [channelMessages.mirroredFromId],
        references: [channelMessages.id],
        relationName: 'mirroredFrom',
    }),
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

/**
 * Followers of a channel thread root. Auto-populated when a user posts in the
 * thread (parent author + every replier). Cascades on root delete so orphans
 * cannot accumulate.
 */
export const channelThreadFollowers = pgTable('channel_thread_followers', {
    rootMessageId: text('rootMessageId').notNull().references(() => channelMessages.id, { onDelete: 'cascade' }),
    userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
    pk: primaryKey({ columns: [table.rootMessageId, table.userId] }),
    userIdx: index('channel_thread_followers_user_id_idx').on(table.userId),
}));

export const channelThreadFollowersRelations = relations(channelThreadFollowers, ({ one }) => ({
    rootMessage: one(channelMessages, {
        fields: [channelThreadFollowers.rootMessageId],
        references: [channelMessages.id],
    }),
    user: one(users, {
        fields: [channelThreadFollowers.userId],
        references: [users.id],
    }),
}));

// Channel read status - tracks when users last read channel messages (watermark-based)
export const channelReadStatus = pgTable('channel_read_status', {
    userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
    channelId: text('channelId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
    lastReadAt: timestamp('lastReadAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
    pk: primaryKey({ columns: [table.userId, table.channelId] }),
    userIdx: index('channel_read_status_user_id_idx').on(table.userId),
    channelIdx: index('channel_read_status_channel_id_idx').on(table.channelId),
}));

export const channelReadStatusRelations = relations(channelReadStatus, ({ one }) => ({
    user: one(users, {
        fields: [channelReadStatus.userId],
        references: [users.id],
    }),
    channel: one(pages, {
        fields: [channelReadStatus.channelId],
        references: [pages.id],
    }),
}));

