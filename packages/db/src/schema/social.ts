import { pgTable, text, timestamp, boolean, pgEnum, index, unique } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
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
  isRead: boolean('isRead').default(false).notNull(),
  readAt: timestamp('readAt', { mode: 'date' }),
  isEdited: boolean('isEdited').default(false).notNull(),
  editedAt: timestamp('editedAt', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
  return {
    conversationIdx: index('direct_messages_conversation_id_idx').on(table.conversationId),
    senderIdx: index('direct_messages_sender_id_idx').on(table.senderId),
    createdAtIdx: index('direct_messages_created_at_idx').on(table.createdAt),
    // Composite index for fetching messages in a conversation
    conversationCreatedIdx: index('direct_messages_conversation_created_idx').on(table.conversationId, table.createdAt),
    // Index for unread messages
    conversationIsReadIdx: index('direct_messages_conversation_is_read_idx').on(table.conversationId, table.isRead),
  }
});

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

export const directMessagesRelations = relations(directMessages, ({ one }) => ({
  conversation: one(dmConversations, {
    fields: [directMessages.conversationId],
    references: [dmConversations.id],
  }),
  sender: one(users, {
    fields: [directMessages.senderId],
    references: [users.id],
  }),
}));