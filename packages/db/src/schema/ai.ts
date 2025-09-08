import { pgTable, text, timestamp, unique, integer, boolean, jsonb } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';

export const userAiSettings = pgTable('user_ai_settings', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(), // 'openai', 'anthropic', 'google', 'ollama'
  encryptedApiKey: text('encryptedApiKey'),
  baseUrl: text('baseUrl'),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    userProviderUnique: unique('user_provider_unique').on(table.userId, table.provider),
  }
});

export const aiTasks = pgTable('ai_tasks', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  conversationId: text('conversationId'),
  messageId: text('messageId'),
  parentTaskId: text('parentTaskId'),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status', { enum: ['pending', 'in_progress', 'completed', 'blocked'] }).notNull().default('pending'),
  priority: text('priority', { enum: ['low', 'medium', 'high'] }).notNull().default('medium'),
  position: integer('position').default(1),
  metadata: jsonb('metadata'),
  completedAt: timestamp('completedAt', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
});

export const userAiSettingsRelations = relations(userAiSettings, ({ one }) => ({
  user: one(users, {
    fields: [userAiSettings.userId],
    references: [users.id],
  }),
}));

export const aiTasksRelations = relations(aiTasks, ({ one, many }) => ({
  user: one(users, {
    fields: [aiTasks.userId],
    references: [users.id],
  }),
  parent: one(aiTasks, {
    fields: [aiTasks.parentTaskId],
    references: [aiTasks.id],
    relationName: 'parentChild'
  }),
  children: many(aiTasks, {
    relationName: 'parentChild'
  }),
}));