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

/**
 * A deterministic step: direct invocation of an allowlisted pageSpaceTools
 * entry with stored args — no LLM involved. Leaf values in `args` may be a
 * `{ $payload: 'dot.path' }` reference resolved from the trigger payload at
 * run time (value slots only; toolName and arg shape are fixed config).
 */
export type WorkflowToolStep = {
  kind: 'tool';
  toolName: string;
  args: Record<string, unknown>;
};

/** An AI step — today's whole-workflow behavior, as one step in a chain. */
export type WorkflowAiStep = {
  kind: 'ai';
  prompt: string;
  agentPageId?: string;
};

export type WorkflowStep = WorkflowToolStep | WorkflowAiStep;

export const workflows = pgTable('workflows', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  createdBy: text('createdBy').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  // Nullable since deterministic-only workflows have no agent. Legacy rows
  // (steps null) always have it set; an ai step without its own agentPageId
  // falls back to this column.
  agentPageId: text('agentPageId').references(() => pages.id, { onDelete: 'cascade' }),
  // '' sentinel for step-based workflows; the real prompt lives in ai steps.
  prompt: text('prompt').notNull(),
  // Null = legacy single-AI-prompt workflow; the executor synthesizes
  // [{ kind: 'ai', prompt, agentPageId }] via resolveSteps(). Never backfilled.
  steps: jsonb('steps').$type<WorkflowStep[]>(),
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
