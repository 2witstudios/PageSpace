import { pgTable, text, timestamp, jsonb, integer, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { pages } from './core';
import { createId } from '@paralleldrive/cuid2';

/**
 * Task Lists - Container for tasks
 * Can be linked to a TASK_LIST page (pageId) OR used as AI ephemeral lists (conversationId)
 */
export const taskLists = pgTable('task_lists', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  pageId: text('pageId').references(() => pages.id, { onDelete: 'cascade' }),
  conversationId: text('conversationId'),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status', { enum: ['pending', 'in_progress', 'completed'] }).notNull().default('pending'),
  metadata: jsonb('metadata'),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    pageIdx: index('task_lists_page_id_idx').on(table.pageId),
    conversationIdx: index('task_lists_conversation_id_idx').on(table.conversationId),
    userIdx: index('task_lists_user_id_idx').on(table.userId),
  };
});

/**
 * Task Items - Individual tasks within a task list
 */
export const taskItems = pgTable('task_items', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  taskListId: text('taskListId').notNull().references(() => taskLists.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  assigneeId: text('assigneeId').references(() => users.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status', { enum: ['pending', 'in_progress', 'completed', 'blocked'] }).notNull().default('pending'),
  priority: text('priority', { enum: ['low', 'medium', 'high'] }).notNull().default('medium'),
  position: integer('position').notNull().default(0),
  dueDate: timestamp('dueDate', { mode: 'date' }),
  metadata: jsonb('metadata'),
  completedAt: timestamp('completedAt', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    taskListIdx: index('task_items_task_list_id_idx').on(table.taskListId),
    taskListStatusIdx: index('task_items_task_list_status_idx').on(table.taskListId, table.status),
    assigneeIdx: index('task_items_assignee_id_idx').on(table.assigneeId),
  };
});

// Relations
// Note: The reverse relation (pages.taskList) would cause circular dependency,
// so pages → taskLists lookups are handled through direct queries:
// const taskList = await db.query.taskLists.findFirst({ where: eq(taskLists.pageId, pageId) });
export const taskListsRelations = relations(taskLists, ({ one, many }) => ({
  user: one(users, {
    fields: [taskLists.userId],
    references: [users.id],
  }),
  page: one(pages, {
    fields: [taskLists.pageId],
    references: [pages.id],
  }),
  items: many(taskItems),
}));

export const taskItemsRelations = relations(taskItems, ({ one }) => ({
  taskList: one(taskLists, {
    fields: [taskItems.taskListId],
    references: [taskLists.id],
  }),
  user: one(users, {
    fields: [taskItems.userId],
    references: [users.id],
    relationName: 'creator',
  }),
  assignee: one(users, {
    fields: [taskItems.assigneeId],
    references: [users.id],
    relationName: 'assignee',
  }),
}));
