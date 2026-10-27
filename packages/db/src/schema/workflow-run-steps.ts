import { pgTable, text, timestamp, integer, index, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { workflowRuns } from './workflow-runs';

export const workflowRunStepStatus = pgEnum('WorkflowRunStepStatus', [
  'running',
  'success',
  'error',
  'skipped',
]);

/**
 * Workflow Run Steps
 *
 * Per-step audit rows for step-based workflow executions (append-only; one
 * row inserted as each step starts, updated when it settles). Steps execute
 * sequentially and fail-fast: a failure at step N marks N 'error' and all
 * later steps 'skipped', and the parent workflow_runs row goes to 'error'.
 *
 * Legacy runs (workflows.steps null) execute their synthesized single AI
 * step without rows here — absence of rows means "pre-steps run", not
 * "zero steps ran".
 */
export const workflowRunSteps = pgTable('workflow_run_steps', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  runId: text('runId').notNull().references(() => workflowRuns.id, { onDelete: 'cascade' }),

  position: integer('position').notNull(),
  kind: text('kind').notNull(),
  toolName: text('toolName'),

  status: workflowRunStepStatus('status').notNull().default('running'),
  error: text('error'),
  durationMs: integer('durationMs'),

  startedAt: timestamp('startedAt', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp('endedAt', { mode: 'date', withTimezone: true }),
}, (table) => {
  return {
    runPositionIdx: index('workflow_run_steps_run_position_idx').on(table.runId, table.position),
  };
});

export const workflowRunStepsRelations = relations(workflowRunSteps, ({ one }) => ({
  run: one(workflowRuns, {
    fields: [workflowRunSteps.runId],
    references: [workflowRuns.id],
  }),
}));

export type WorkflowRunStep = typeof workflowRunSteps.$inferSelect;
export type NewWorkflowRunStep = typeof workflowRunSteps.$inferInsert;
