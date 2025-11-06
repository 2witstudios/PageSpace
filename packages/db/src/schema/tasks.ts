import { pgTable, text, timestamp, jsonb, real, index, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { pages } from './core';
import { users } from './auth';
import { createId } from '@paralleldrive/cuid2';

// Task status enum
export const taskStatus = pgEnum('TaskStatus', [
  'pending',
  'in_progress',
  'completed',
  'blocked',
  'cancelled'
]);

// Task priority enum
export const taskPriority = pgEnum('TaskPriority', [
  'low',
  'medium',
  'high',
  'urgent'
]);

// Task dependency type enum
export const taskDependencyType = pgEnum('TaskDependencyType', [
  'blocks',
  'blocked_by',
  'relates_to'
]);

// Task metadata table - stores task-specific data linked to pages
export const taskMetadata = pgTable('task_metadata', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  pageId: text('pageId')
    .notNull()
    .references(() => pages.id, { onDelete: 'cascade' })
    .unique(),

  // Assignment
  assigneeId: text('assigneeId').references(() => users.id, { onDelete: 'set null' }),
  assignerId: text('assignerId')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),

  // Status & Priority
  status: taskStatus('status').default('pending').notNull(),
  priority: taskPriority('priority').default('medium').notNull(),

  // Dates
  dueDate: timestamp('dueDate', { mode: 'date' }),
  startDate: timestamp('startDate', { mode: 'date' }),
  completedAt: timestamp('completedAt', { mode: 'date' }),

  // Time Tracking (optional)
  estimatedHours: real('estimatedHours'),
  actualHours: real('actualHours'),

  // Additional metadata
  labels: jsonb('labels').$type<string[]>().default([]),
  customFields: jsonb('customFields').$type<Record<string, unknown>>().default({}),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' })
    .notNull()
    .$onUpdate(() => new Date()),
}, (table) => {
  return {
    pageIdx: index('task_metadata_page_id_idx').on(table.pageId),
    assigneeIdx: index('task_metadata_assignee_id_idx').on(table.assigneeId),
    assignerIdx: index('task_metadata_assigner_id_idx').on(table.assignerId),
    statusIdx: index('task_metadata_status_idx').on(table.status),
    dueDateIdx: index('task_metadata_due_date_idx').on(table.dueDate),
    priorityIdx: index('task_metadata_priority_idx').on(table.priority),
    statusPriorityIdx: index('task_metadata_status_priority_idx').on(table.status, table.priority),
  };
});

// Task dependencies table - tracks relationships between tasks
export const taskDependencies = pgTable('task_dependencies', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  taskId: text('taskId')
    .notNull()
    .references(() => pages.id, { onDelete: 'cascade' }),
  dependsOnTaskId: text('dependsOnTaskId')
    .notNull()
    .references(() => pages.id, { onDelete: 'cascade' }),
  dependencyType: taskDependencyType('dependencyType').default('blocks').notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
  return {
    taskIdx: index('task_dependencies_task_id_idx').on(table.taskId),
    dependsOnIdx: index('task_dependencies_depends_on_task_id_idx').on(table.dependsOnTaskId),
    taskDependsOnIdx: index('task_dependencies_task_id_depends_on_task_id_idx').on(
      table.taskId,
      table.dependsOnTaskId
    ),
  };
});

// Relations
export const taskMetadataRelations = relations(taskMetadata, ({ one }) => ({
  page: one(pages, {
    fields: [taskMetadata.pageId],
    references: [pages.id],
  }),
  assignee: one(users, {
    fields: [taskMetadata.assigneeId],
    references: [users.id],
    relationName: 'TaskAssignee',
  }),
  assigner: one(users, {
    fields: [taskMetadata.assignerId],
    references: [users.id],
    relationName: 'TaskAssigner',
  }),
}));

export const taskDependenciesRelations = relations(taskDependencies, ({ one }) => ({
  task: one(pages, {
    fields: [taskDependencies.taskId],
    references: [pages.id],
    relationName: 'DependentTask',
  }),
  dependsOnTask: one(pages, {
    fields: [taskDependencies.dependsOnTaskId],
    references: [pages.id],
    relationName: 'DependsOnTask',
  }),
}));
