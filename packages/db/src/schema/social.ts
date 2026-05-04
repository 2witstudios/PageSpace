import { pgTable, text, timestamp, boolean, jsonb, integer, pgEnum, index, unique, uniqueIndex, primaryKey, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { files, type AttachmentMeta } from './storage';
import { createId } from '@paralleldrive/cuid2';

// Connection status enum
export const connectionStatus = pgEnum('ConnectionStatus', ['PENDING', 'ACCEPTED', 'BLOCKED']);

// User connections (bidirectional relationships)
export const connections = pgTable('connections', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  user1Id: text('user1Id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  user2Id: text('user2Id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: connectionStatus('status').default('PENDING').notNull(),
  requestedBy: text('requestedBy').notNull().references(() => users.id, { onDelete: 'cascade' }),
  requestMessage: text('requestMessage'),
  requestedAt: timestamp('requestedAt', { mode: 'date' }).defaultNow().notNull(),
  acceptedAt: timestamp('acceptedAt', { mode: 'date' }),
  blockedBy: text('blockedBy').references(() => users.id, { onDelete: 'set null' }),
  blockedAt: timestamp('blockedAt', { mode: 'date' }),
}, (table) => {
  return {
    // Ensure unique connection between two users (bidirectional)
    userPairKey: unique('connections_user_pair_key').on(table.user1Id, table.user2Id),
    user1Idx: index('connections_user1_id_idx').on(table.user1Id),
    user2Idx: index('connections_user2_id_idx').on(table.user2Id),
    statusIdx: index('connections_status_idx').on(table.status),
    // Index for quick lookup of all connections for a user
    user1StatusIdx: index('connections_user1_status_idx').on(table.user1Id, table.status),
    user2StatusIdx: index('connections_user2_status_idx').on(table.user2Id, table.status),
  }
});

// Direct message conversations
export const dmConversations = pgTable('dm_conversations', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  participant1Id: text('participant1Id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  participant2Id: text('participant2Id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  lastMessageAt: timestamp('lastMessageAt', { mode: 'date' }),
  lastMessagePreview: text('lastMessagePreview'),
  participant1LastRead: timestamp('participant1LastRead', { mode: 'date' }),
  participant2LastRead: timestamp('participant2LastRead', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    // Ensure unique conversation between two users
    participantPairKey: unique('dm_conversations_participant_pair_key').on(table.participant1Id, table.participant2Id),
    participant1Idx: index('dm_conversations_participant1_id_idx').on(table.participant1Id),
    participant2Idx: index('dm_conversations_participant2_id_idx').on(table.participant2Id),
    lastMessageIdx: index('dm_conversations_last_message_at_idx').on(table.lastMessageAt),
    // Composite indexes for efficient queries
    participant1LastMessageIdx: index('dm_conversations_participant1_last_message_idx').on(table.participant1Id, table.lastMessageAt),
    participant2LastMessageIdx: index('dm_conversations_participant2_last_message_idx').on(table.participant2Id, table.lastMessageAt),
  }
});

// Direct messages
export const directMessages = pgTable('direct_messages', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  conversationId: text('conversationId').notNull().references(() => dmConversations.id, { onDelete: 'cascade' }),
  senderId: text('senderId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  fileId: text('fileId').references(() => files.id, { onDelete: 'set null' }),
  attachmentMeta: jsonb('attachmentMeta').$type<AttachmentMeta | null>(),
  isRead: boolean('isRead').default(false).notNull(),
  readAt: timestamp('readAt', { mode: 'date' }),
  isEdited: boolean('isEdited').default(false).notNull(),
  editedAt: timestamp('editedAt', { mode: 'date' }),
  isActive: boolean('isActive').default(true).notNull(),
  deletedAt: timestamp('deletedAt', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  // Threading: parentId points at the thread root (top-level DM). Replies are
  // exactly one level deep, so a parent must itself have parentId IS NULL.
  parentId: text('parentId').references((): AnyPgColumn => directMessages.id, { onDelete: 'cascade' }),
  replyCount: integer('replyCount').default(0).notNull(),
  lastReplyAt: timestamp('lastReplyAt', { mode: 'date' }),
  // When "Also send to DM" mirrors a thread reply to the top-level conversation,
  // the top-level copy carries mirroredFromId pointing at the thread reply's id.
  mirroredFromId: text('mirroredFromId').references((): AnyPgColumn => directMessages.id, { onDelete: 'set null' }),
}, (table) => {
  return {
    conversationIdx: index('direct_messages_conversation_id_idx').on(table.conversationId),
    senderIdx: index('direct_messages_sender_id_idx').on(table.senderId),
    createdAtIdx: index('direct_messages_created_at_idx').on(table.createdAt),
    fileIdx: index('direct_messages_file_id_idx').on(table.fileId),
    // Serves the conversation list query filtered by isActive — keeping isActive in the
    // index lets the planner skip a heap fetch when soft-deleted messages must be excluded.
    conversationActiveCreatedIdx: index('direct_messages_conversation_active_created_idx').on(table.conversationId, table.isActive, table.createdAt),
    // Serves the retention job that permanently purges soft-deleted DMs.
    inactiveDeletedAtIdx: index('direct_messages_inactive_deleted_at_idx').on(table.isActive, table.deletedAt),
    // Composite index for fetching messages in a conversation (kept for queries that don't filter isActive)
    conversationCreatedIdx: index('direct_messages_conversation_created_idx').on(table.conversationId, table.createdAt),
    // Index for unread messages
    conversationIsReadIdx: index('direct_messages_conversation_is_read_idx').on(table.conversationId, table.isRead),
    // Composite index for efficient unread count queries (conversationId, senderId, isRead)
    unreadCountIdx: index('direct_messages_unread_count_idx').on(table.conversationId, table.senderId, table.isRead),
    parentCreatedIdx: index('direct_messages_parent_created_idx').on(table.parentId, table.createdAt),
  }
});

/**
 * DM message reactions - emoji reactions on direct messages.
 *
 * Mirrors channelMessageReactions in shape and constraints: each user can add
 * one reaction per emoji per message; supports any Unicode emoji (text).
 */
export const dmMessageReactions = pgTable('dm_message_reactions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  messageId: text('messageId').notNull().references(() => directMessages.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  emoji: text('emoji').notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  uniqueReaction: uniqueIndex('dm_unique_reaction_idx').on(table.messageId, table.userId, table.emoji),
  messageIdx: index('dm_reaction_message_idx').on(table.messageId),
}));

/**
 * Followers of a DM thread root. Auto-populated when a user posts in the
 * thread (parent author + every replier). Cascades on root delete.
 */
export const dmThreadFollowers = pgTable('dm_thread_followers', {
  rootMessageId: text('rootMessageId').notNull().references(() => directMessages.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.rootMessageId, table.userId] }),
  userIdx: index('dm_thread_followers_user_id_idx').on(table.userId),
}));

// Relations
export const connectionsRelations = relations(connections, ({ one }) => ({
  user1: one(users, {
    fields: [connections.user1Id],
    references: [users.id],
    relationName: 'ConnectionUser1',
  }),
  user2: one(users, {
    fields: [connections.user2Id],
    references: [users.id],
    relationName: 'ConnectionUser2',
  }),
  requester: one(users, {
    fields: [connections.requestedBy],
    references: [users.id],
    relationName: 'ConnectionRequester',
  }),
  blocker: one(users, {
    fields: [connections.blockedBy],
    references: [users.id],
    relationName: 'ConnectionBlocker',
  }),
}));

export const dmConversationsRelations = relations(dmConversations, ({ one, many }) => ({
  participant1: one(users, {
    fields: [dmConversations.participant1Id],
    references: [users.id],
    relationName: 'ConversationParticipant1',
  }),
  participant2: one(users, {
    fields: [dmConversations.participant2Id],
    references: [users.id],
    relationName: 'ConversationParticipant2',
  }),
  messages: many(directMessages),
}));

export const directMessagesRelations = relations(directMessages, ({ one, many }) => ({
  conversation: one(dmConversations, {
    fields: [directMessages.conversationId],
    references: [dmConversations.id],
  }),
  sender: one(users, {
    fields: [directMessages.senderId],
    references: [users.id],
  }),
  file: one(files, {
    fields: [directMessages.fileId],
    references: [files.id],
  }),
  reactions: many(dmMessageReactions),
}));

export const dmMessageReactionsRelations = relations(dmMessageReactions, ({ one }) => ({
  message: one(directMessages, {
    fields: [dmMessageReactions.messageId],
    references: [directMessages.id],
  }),
  user: one(users, {
    fields: [dmMessageReactions.userId],
    references: [users.id],
  }),
}));

export const dmThreadFollowersRelations = relations(dmThreadFollowers, ({ one }) => ({
  rootMessage: one(directMessages, {
    fields: [dmThreadFollowers.rootMessageId],
    references: [directMessages.id],
  }),
  user: one(users, {
    fields: [dmThreadFollowers.userId],
    references: [users.id],
  }),
}));
