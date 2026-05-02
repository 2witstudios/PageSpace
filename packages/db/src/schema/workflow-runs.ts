import { pgTable, text, timestamp, integer, index, uniqueIndex, pgEnum } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { workflows } from './workflows';

export const workflowRunStatus = pgEnum('WorkflowRunStatus', [
  'running',
  'success',
  'error',
  'cancelled',
]);

export const workflowRunSourceTable = pgEnum('WorkflowRunSourceTable', [
  'taskTriggers',
  'calendarTriggers',
  'cron',
  'manual',
]);

/**
 * Workflow Runs
 *
 * Canonical per-fire audit table for every workflow execution. One row is
 * inserted at execute-start (status='running') and updated at execute-end
 * (status='success'|'error'|'cancelled', endedAt, durationMs, error,
 * conversationId).
 *
 * `sourceTable` identifies the originating trigger surface so we can join
 * back to the row that fired this execution. For cron / manual fires there
 * is no per-fire row in another table, so `sourceId` is null.
 *
 * Stuck-run sweepers operate on this table only — trigger tables no longer
 * carry per-fire state.
 */
export const workflowRuns = pgTable('workflow_runs', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  workflowId: text('workflowId').notNull().references(() => workflows.id, { onDelete: 'cascade' }),

  sourceTable: workflowRunSourceTable('sourceTable').notNull(),
  sourceId: text('sourceId'),

  triggerAt: timestamp('triggerAt', { mode: 'date', withTimezone: true }),
  startedAt: timestamp('startedAt', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp('endedAt', { mode: 'date', withTimezone: true }),

  status: workflowRunStatus('status').notNull().default('running'),
  error: text('error'),
  durationMs: integer('durationMs'),
  conversationId: text('conversationId'),
}, (table) => {
  return {
    workflowStartedAtIdx: index('workflow_runs_workflow_started_at_idx').on(table.workflowId, table.startedAt),
    sourceLookupIdx: index('workflow_runs_source_lookup_idx').on(table.sourceTable, table.sourceId, table.status),
    stuckRunIdx: index('workflow_runs_stuck_run_idx').on(table.status, table.startedAt),
    // Atomic claim guard: at most one in-flight (status='running') run per workflow.
    // Concurrent executors INSERT ON CONFLICT DO NOTHING; the loser sees zero rows
    // returned and bails. Once the run finishes (status flips to success/error/
    // cancelled), the partial index releases and a fresh run can claim.
    runningClaimIdx: uniqueIndex('workflow_runs_running_claim_idx').on(table.workflowId).where(sql`${table.status} = 'running'`),
  };
});

export const workflowRunsRelations = relations(workflowRuns, ({ one }) => ({
  workflow: one(workflows, {
    fields: [workflowRuns.workflowId],
    references: [workflows.id],
  }),
}));

export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;
