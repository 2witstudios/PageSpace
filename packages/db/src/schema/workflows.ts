import { pgTable, text, timestamp, jsonb, boolean, integer, index, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { drives, pages } from './core';

export const workflowTriggerType = pgEnum('WorkflowTriggerType', ['cron', 'event']);

export type EventTrigger = {
  operation: string;
  resourceType: string;
};

export const workflows = pgTable('workflows', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  createdBy: text('createdBy').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  agentPageId: text('agentPageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  prompt: text('prompt').notNull(),
  contextPageIds: jsonb('contextPageIds').$type<string[]>().default([]),
  cronExpression: text('cronExpression'),
  timezone: text('timezone').notNull().default('UTC'),
  triggerType: workflowTriggerType('triggerType').notNull().default('cron'),
  eventTriggers: jsonb('eventTriggers').$type<EventTrigger[]>(),
  watchedFolderIds: jsonb('watchedFolderIds').$type<string[]>(),
  eventDebounceSecs: integer('eventDebounceSecs').default(30),

  instructionPageId: text('instructionPageId').references(() => pages.id, { onDelete: 'set null' }),

  isEnabled: boolean('isEnabled').default(true).notNull(),
  nextRunAt: timestamp('nextRunAt', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    driveIdx: index('workflows_drive_id_idx').on(table.driveId),
    createdByIdx: index('workflows_created_by_idx').on(table.createdBy),
    agentPageIdx: index('workflows_agent_page_id_idx').on(table.agentPageId),
    enabledNextRunIdx: index('workflows_enabled_next_run_idx').on(table.isEnabled, table.nextRunAt),
    enabledTriggerTypeIdx: index('workflows_enabled_trigger_type_idx').on(table.isEnabled, table.triggerType),
  };
});

export const workflowsRelations = relations(workflows, ({ one }) => ({
  drive: one(drives, {
    fields: [workflows.driveId],
    references: [drives.id],
  }),
  createdByUser: one(users, {
    fields: [workflows.createdBy],
    references: [users.id],
  }),
  agentPage: one(pages, {
    fields: [workflows.agentPageId],
    references: [pages.id],
  }),
  instructionPage: one(pages, {
    fields: [workflows.instructionPageId],
    references: [pages.id],
    relationName: 'workflowInstructionPage',
  }),
}));
