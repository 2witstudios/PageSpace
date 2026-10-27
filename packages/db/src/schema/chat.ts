import { pgTable, text, timestamp, jsonb, boolean, integer, index, uniqueIndex, primaryKey, check, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { users } from './auth';
import { pages, drives } from './core';
import { files, type AttachmentMeta } from './storage';
import { createId } from '@paralleldrive/cuid2';

/**
 * Universal Commands execution feedback (UX spec §7): set on an agent reply
 * when the triggering message carried a slash command, so the channel renders
 * the "Using /foo" / "Skipped /foo — {reason}" indicator.
 */
export interface ChannelCommandExecution {
  label: string;
  status: 'used' | 'skipped';
  reason?: 'page_trashed' | 'no_access' | 'not_found' | 'disabled';
  entryPageTitle?: string;
}

/**
 * AI sender metadata: set when a channel message is posted by a non-human
 * sender — an AI tool, or an incoming page webhook ('webhook', see
 * page-webhooks.ts; senderName carries the resolved display name, i.e. the
 * payload's username override or the webhook's configured name).
 */
export interface ChannelMessageAiMeta {
  senderType: 'global_assistant' | 'agent' | 'webhook';
  senderName: string;
  agentPageId?: string;
  /** One entry per resolved command in the triggering message, in document order. */
  commandExecution?: ChannelCommandExecution[];
}

export const channelMessages = pgTable('channel_messages', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  content: text('content').notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  pageId: text('pageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // File attachment (optional)
  fileId: text('fileId').references(() => files.id, { onDelete: 'set null' }),
  attachmentMeta: jsonb('attachmentMeta').$type<AttachmentMeta | null>(),
  // Soft-delete flag for rollback support (matches the `messages` pattern)
  isActive: boolean('isActive').default(true).notNull(),
  editedAt: timestamp('editedAt', { mode: 'date' }),
  // AI sender metadata: set when message is posted by an AI tool
  aiMeta: jsonb('aiMeta').$type<ChannelMessageAiMeta | null>(),
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
    attachments: many(channelMessageAttachments),
    reactions: many(channelMessageReactions),
    mirroredFrom: one(channelMessages, {
        fields: [channelMessages.mirroredFromId],
        references: [channelMessages.id],
        relationName: 'mirroredFrom',
    }),
}));

/**
 * Attachments carried by a channel message — the N side of a message that can
 * hold several files (a batch of photos sent together renders as one message
 * with one gallery, rather than N messages).
 *
 * Mirrors `direct_message_attachments` on the DM side, the same way
 * channelMessageReactions mirrors dmMessageReactions. A single polymorphic
 * table across both surfaces was rejected: it could not carry a real FK to two
 * different parents, which would trade the free ON DELETE cascade below for
 * permanent orphan sweeping.
 *
 * `fileId` is SET NULL rather than CASCADE so a hard file delete leaves the row
 * (and its `attachmentMeta`) behind: the message keeps rendering, one tile
 * short, exactly as the legacy single-attachment columns behave today.
 *
 * There is deliberately NO `CHECK (fileId IS NOT NULL OR attachmentMeta IS NOT
 * NULL)`. A legacy row can carry a fileId with a null `attachmentMeta` (the
 * channel route never validated the pair), and the backfill copies it as-is —
 * so such a check would be satisfied only by the fileId. Deleting that file
 * then performs the SET NULL as an UPDATE, which re-evaluates the CHECK, fails
 * it, and aborts the DELETE on `files`. Guarding against a degenerate empty row
 * is not worth making file deletion fail; `getAttachments` already ignores an
 * attachment with no fileId to render.
 */
export const channelMessageAttachments = pgTable('channel_message_attachments', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  messageId: text('messageId').notNull().references(() => channelMessages.id, { onDelete: 'cascade' }),
  fileId: text('fileId').references(() => files.id, { onDelete: 'set null' }),
  // Nullable, mirroring the legacy channel_messages.attachmentMeta it is
  // backfilled from — a legacy row may carry a fileId with no meta, and the
  // backfill must not invent one. attachment-utils already falls back to the
  // joined files row for mimeType/size.
  attachmentMeta: jsonb('attachmentMeta').$type<AttachmentMeta | null>(),
  // Display order, client-supplied. Also the cardinality cap: the CHECK below
  // plus the unique (messageId, position) index cap a message at
  // MAX_MESSAGE_ATTACHMENTS files with no trigger and no counter column.
  position: integer('position').notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  messagePositionIdx: uniqueIndex('channel_message_attachments_message_position_idx').on(table.messageId, table.position),
  fileIdx: index('channel_message_attachments_file_id_idx').on(table.fileId),
  positionRange: check('channel_message_attachments_position_range', sql`${table.position} >= 0 AND ${table.position} < 10`),
}));

export const channelMessageAttachmentsRelations = relations(channelMessageAttachments, ({ one }) => ({
  message: one(channelMessages, {
    fields: [channelMessageAttachments.messageId],
    references: [channelMessages.id],
  }),
  file: one(files, {
    fields: [channelMessageAttachments.fileId],
    references: [files.id],
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

