"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.messagesRelations = exports.conversationsRelations = exports.messages = exports.conversations = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const drizzle_orm_1 = require("drizzle-orm");
const auth_1 = require("./auth");
const cuid2_1 = require("@paralleldrive/cuid2");
/**
 * Unified conversations table for all chat types
 * Supports global, page-specific, and drive-specific conversations
 */
exports.conversations = (0, pg_core_1.pgTable)('conversations', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    userId: (0, pg_core_1.text)('userId').notNull().references(() => auth_1.users.id, { onDelete: 'cascade' }),
    title: (0, pg_core_1.text)('title'), // Auto-generated from first message or user-defined
    type: (0, pg_core_1.text)('type').notNull(), // 'global' | 'page' | 'drive'
    contextId: (0, pg_core_1.text)('contextId'), // null for global, pageId for page chats, driveId for drive chats
    lastMessageAt: (0, pg_core_1.timestamp)('lastMessageAt', { mode: 'date' }),
    createdAt: (0, pg_core_1.timestamp)('createdAt', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: (0, pg_core_1.timestamp)('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
    isActive: (0, pg_core_1.boolean)('isActive').default(true).notNull(),
}, (table) => ({
    userIdx: (0, pg_core_1.index)('conversations_user_id_idx').on(table.userId),
    userTypeIdx: (0, pg_core_1.index)('conversations_user_id_type_idx').on(table.userId, table.type),
    userLastMessageIdx: (0, pg_core_1.index)('conversations_user_id_last_message_at_idx').on(table.userId, table.lastMessageAt),
    contextIdx: (0, pg_core_1.index)('conversations_context_id_idx').on(table.contextId),
}));
/**
 * Unified messages table for all conversation types
 */
exports.messages = (0, pg_core_1.pgTable)('messages', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    conversationId: (0, pg_core_1.text)('conversationId').notNull().references(() => exports.conversations.id, { onDelete: 'cascade' }),
    userId: (0, pg_core_1.text)('userId').notNull().references(() => auth_1.users.id, { onDelete: 'cascade' }),
    role: (0, pg_core_1.text)('role').notNull(), // 'user' | 'assistant'
    messageType: (0, pg_core_1.text)('messageType', { enum: ['standard', 'todo_list'] }).default('standard').notNull(),
    content: (0, pg_core_1.text)('content').notNull(),
    toolCalls: (0, pg_core_1.jsonb)('toolCalls'),
    toolResults: (0, pg_core_1.jsonb)('toolResults'),
    createdAt: (0, pg_core_1.timestamp)('createdAt', { mode: 'date' }).defaultNow().notNull(),
    isActive: (0, pg_core_1.boolean)('isActive').default(true).notNull(),
    agentRole: (0, pg_core_1.text)('agentRole').default('PARTNER').notNull(),
    editedAt: (0, pg_core_1.timestamp)('editedAt', { mode: 'date' }),
}, (table) => ({
    conversationIdx: (0, pg_core_1.index)('messages_conversation_id_idx').on(table.conversationId),
    conversationCreatedAtIdx: (0, pg_core_1.index)('messages_conversation_id_created_at_idx').on(table.conversationId, table.createdAt),
    userIdx: (0, pg_core_1.index)('messages_user_id_idx').on(table.userId),
}));
// Relations
exports.conversationsRelations = (0, drizzle_orm_1.relations)(exports.conversations, ({ one, many }) => ({
    user: one(auth_1.users, {
        fields: [exports.conversations.userId],
        references: [auth_1.users.id],
    }),
    messages: many(exports.messages),
}));
exports.messagesRelations = (0, drizzle_orm_1.relations)(exports.messages, ({ one }) => ({
    conversation: one(exports.conversations, {
        fields: [exports.messages.conversationId],
        references: [exports.conversations.id],
    }),
    user: one(auth_1.users, {
        fields: [exports.messages.userId],
        references: [auth_1.users.id],
    }),
}));
