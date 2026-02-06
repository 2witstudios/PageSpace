import { pgTable, text, timestamp, jsonb, integer, index, unique } from 'drizzle-orm/pg-core';
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
 * Task Status Configs - Custom status definitions per task list
 *
 * Each task list can define its own set of statuses. Every status belongs to
 * a "group" that maps to system-level behavior:
 * - todo: Task not yet started (maps to legacy "pending")
 * - in_progress: Work is underway (maps to legacy "in_progress", "blocked")
 * - done: Task is finished (maps to legacy "completed")
 *
 * Default statuses (pending, in_progress, blocked, completed) are auto-created
 * when a task list is first initialized. Users can then add, rename, reorder,
 * or remove statuses as needed.
 */
export const taskStatusConfigs = pgTable('task_status_configs', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  taskListId: text('taskListId').notNull().references(() => taskLists.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  color: text('color').notNull(),
  group: text('group', { enum: ['todo', 'in_progress', 'done'] }).notNull(),
  position: integer('position').notNull().default(0),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    taskListIdx: index('task_status_configs_task_list_id_idx').on(table.taskListId),
    slugUnique: unique('task_status_configs_task_list_slug').on(table.taskListId, table.slug),
  };
});

/**
 * Task Items - Individual tasks within a task list
 * For page-based task lists, each task has a linked document page (pageId)
 * For conversation-based task lists, description field is used instead
 *
 * Assignment (legacy single-assignee fields kept for backward compatibility):
 * - assigneeId: Human user assignment (references users.id) [DEPRECATED: use taskAssignees]
 * - assigneeAgentId: AI agent assignment (references pages.id where type='AI_CHAT') [DEPRECATED: use taskAssignees]
 *
 * Status: References a taskStatusConfigs.slug for this task's task list.
 * Default value 'pending' works with auto-created default status configs.
 */
export const taskItems = pgTable('task_items', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  taskListId: text('taskListId').notNull().references(() => taskLists.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  assigneeId: text('assigneeId').references(() => users.id, { onDelete: 'set null' }),
  assigneeAgentId: text('assigneeAgentId').references(() => pages.id, { onDelete: 'set null' }),
  pageId: text('pageId').references(() => pages.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').notNull().default('pending'),
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
    assigneeAgentIdx: index('task_items_assignee_agent_id_idx').on(table.assigneeAgentId),
    pageIdx: index('task_items_page_id_idx').on(table.pageId),
  };
});

/**
 * Task Assignees - Junction table for multiple assignees per task
 *
 * Supports both human users and AI agents as assignees.
 * Each row represents one assignment: either userId OR agentPageId is set (not both).
 *
 * The legacy assigneeId/assigneeAgentId fields on taskItems are kept in sync
 * with the first user/agent assignee for backward compatibility.
 */
export const taskAssignees = pgTable('task_assignees', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  taskId: text('taskId').notNull().references(() => taskItems.id, { onDelete: 'cascade' }),
  userId: text('userId').references(() => users.id, { onDelete: 'cascade' }),
  agentPageId: text('agentPageId').references(() => pages.id, { onDelete: 'cascade' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
  return {
    taskIdx: index('task_assignees_task_id_idx').on(table.taskId),
    userIdx: index('task_assignees_user_id_idx').on(table.userId),
    agentIdx: index('task_assignees_agent_page_id_idx').on(table.agentPageId),
    uniqueUserAssignment: unique('task_assignees_task_user').on(table.taskId, table.userId),
    uniqueAgentAssignment: unique('task_assignees_task_agent').on(table.taskId, table.agentPageId),
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
  statusConfigs: many(taskStatusConfigs),
}));

export const taskStatusConfigsRelations = relations(taskStatusConfigs, ({ one }) => ({
  taskList: one(taskLists, {
    fields: [taskStatusConfigs.taskListId],
    references: [taskLists.id],
  }),
}));

export const taskItemsRelations = relations(taskItems, ({ one, many }) => ({
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
  assigneeAgent: one(pages, {
    fields: [taskItems.assigneeAgentId],
    references: [pages.id],
    relationName: 'assignedAgent',
  }),
  page: one(pages, {
    fields: [taskItems.pageId],
    references: [pages.id],
    relationName: 'taskPage',
  }),
  assignees: many(taskAssignees),
}));

export const taskAssigneesRelations = relations(taskAssignees, ({ one }) => ({
  task: one(taskItems, {
    fields: [taskAssignees.taskId],
    references: [taskItems.id],
  }),
  user: one(users, {
    fields: [taskAssignees.userId],
    references: [users.id],
  }),
  agentPage: one(pages, {
    fields: [taskAssignees.agentPageId],
    references: [pages.id],
  }),
}));

/**
 * Default status configurations for new task lists.
 * These are auto-created when a task list is first initialized.
 */
export const DEFAULT_TASK_STATUSES = [
  { slug: 'pending', name: 'To Do', color: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300', group: 'todo' as const, position: 0 },
  { slug: 'in_progress', name: 'In Progress', color: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300', group: 'in_progress' as const, position: 1 },
  { slug: 'blocked', name: 'Blocked', color: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300', group: 'in_progress' as const, position: 2 },
  { slug: 'completed', name: 'Done', color: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300', group: 'done' as const, position: 3 },
];
