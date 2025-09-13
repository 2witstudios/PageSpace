"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiTasksRelations = exports.userAiSettingsRelations = exports.aiTasks = exports.userAiSettings = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const drizzle_orm_1 = require("drizzle-orm");
const cuid2_1 = require("@paralleldrive/cuid2");
const auth_1 = require("./auth");
exports.userAiSettings = (0, pg_core_1.pgTable)('user_ai_settings', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    userId: (0, pg_core_1.text)('userId').notNull().references(() => auth_1.users.id, { onDelete: 'cascade' }),
    provider: (0, pg_core_1.text)('provider').notNull(), // 'openai', 'anthropic', 'google', 'ollama'
    encryptedApiKey: (0, pg_core_1.text)('encryptedApiKey'),
    baseUrl: (0, pg_core_1.text)('baseUrl'),
    createdAt: (0, pg_core_1.timestamp)('createdAt', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: (0, pg_core_1.timestamp)('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => {
    return {
        userProviderUnique: (0, pg_core_1.unique)('user_provider_unique').on(table.userId, table.provider),
    };
});
exports.aiTasks = (0, pg_core_1.pgTable)('ai_tasks', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    userId: (0, pg_core_1.text)('userId').notNull().references(() => auth_1.users.id, { onDelete: 'cascade' }),
    conversationId: (0, pg_core_1.text)('conversationId'),
    messageId: (0, pg_core_1.text)('messageId'),
    parentTaskId: (0, pg_core_1.text)('parentTaskId'),
    title: (0, pg_core_1.text)('title').notNull(),
    description: (0, pg_core_1.text)('description'),
    status: (0, pg_core_1.text)('status', { enum: ['pending', 'in_progress', 'completed', 'blocked'] }).notNull().default('pending'),
    priority: (0, pg_core_1.text)('priority', { enum: ['low', 'medium', 'high'] }).notNull().default('medium'),
    position: (0, pg_core_1.integer)('position').default(1),
    metadata: (0, pg_core_1.jsonb)('metadata'),
    completedAt: (0, pg_core_1.timestamp)('completedAt', { mode: 'date' }),
    createdAt: (0, pg_core_1.timestamp)('createdAt', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: (0, pg_core_1.timestamp)('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
});
exports.userAiSettingsRelations = (0, drizzle_orm_1.relations)(exports.userAiSettings, ({ one }) => ({
    user: one(auth_1.users, {
        fields: [exports.userAiSettings.userId],
        references: [auth_1.users.id],
    }),
}));
exports.aiTasksRelations = (0, drizzle_orm_1.relations)(exports.aiTasks, ({ one, many }) => ({
    user: one(auth_1.users, {
        fields: [exports.aiTasks.userId],
        references: [auth_1.users.id],
    }),
    parent: one(exports.aiTasks, {
        fields: [exports.aiTasks.parentTaskId],
        references: [exports.aiTasks.id],
        relationName: 'parentChild'
    }),
    children: many(exports.aiTasks, {
        relationName: 'parentChild'
    }),
}));
