import { pgTable, text, timestamp, boolean, index, unique, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { taskItems } from './tasks';
import { workflows } from './workflows';

export const taskTriggerType = pgEnum('TaskTriggerType', ['due_date', 'completion']);

/**
 * Task Triggers
 *
 * The "when" half of a task-driven workflow. Pairs a taskItem with the
 * workflows row that holds the execution payload (prompt, agent, context).
 * The cron task-triggers poller picks rows where isEnabled = true,
 * nextRunAt <= NOW() and lastFiredAt IS NULL; completion fires resolve
 * the matching row in fireCompletionTrigger.
 */
export const taskTriggers = pgTable('task_triggers', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  workflowId: text('workflowId').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  taskItemId: text('taskItemId').notNull().references(() => taskItems.id, { onDelete: 'cascade' }),

  triggerType: taskTriggerType('triggerType').notNull(),

  nextRunAt: timestamp('nextRunAt', { mode: 'date' }),
  lastFiredAt: timestamp('lastFiredAt', { mode: 'date' }),
  lastFireError: text('lastFireError'),
  isEnabled: boolean('isEnabled').default(true).notNull(),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    workflowIdx: index('task_triggers_workflow_id_idx').on(table.workflowId),
    taskItemIdx: index('task_triggers_task_item_id_idx').on(table.taskItemId),
    enabledNextRunIdx: index('task_triggers_enabled_next_run_idx').on(table.isEnabled, table.nextRunAt),
    taskItemTriggerTypeKey: unique('task_triggers_task_item_trigger_type_key').on(table.taskItemId, table.triggerType),
  };
});

export const taskTriggersRelations = relations(taskTriggers, ({ one }) => ({
  workflow: one(workflows, {
    fields: [taskTriggers.workflowId],
    references: [workflows.id],
  }),
  taskItem: one(taskItems, {
    fields: [taskTriggers.taskItemId],
    references: [taskItems.id],
  }),
}));

export type TaskTrigger = typeof taskTriggers.$inferSelect;
export type NewTaskTrigger = typeof taskTriggers.$inferInsert;
