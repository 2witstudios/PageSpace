import { db } from '@pagespace/db/db';
import { and, eq, sql } from '@pagespace/db/operators';
import { workflowRuns, type NewWorkflowRun } from '@pagespace/db/schema/workflow-runs';

export type UnstartedRunRow = Pick<NewWorkflowRun, 'workflowId' | 'sourceTable' | 'sourceId' | 'triggerAt' | 'durationMs' | 'error'>;

/**
 * Record a run that never started (a terminal credit refusal, or a gate that
 * failed past its retry window) as ONE error row per occurrence, and return
 * that row's id.
 *
 * The credit gate runs before the running claim, so two overlapping ticks that
 * both refuse the same occurrence never meet the running-claim index, and
 * workflow_runs has no other unique index. Each writer instead takes a
 * transaction-scoped advisory lock keyed on the occurrence, then inserts only
 * if the occurrence has NO run row yet (the same NOT EXISTS the calendar
 * discovery uses): the second writer waits, sees the first row and returns its
 * id. An occurrence that already ran, or is running, gets no error row beside
 * it.
 *
 * A fire with no occurrence time (manual) has no identity to dedupe on, so
 * every attempt is recorded.
 */
export async function recordUnstartedRunOnce(row: UnstartedRunRow): Promise<string | undefined> {
  const values = { ...row, status: 'error' as const, endedAt: new Date() };
  const { triggerAt } = row;
  if (!triggerAt) {
    const [inserted] = await db.insert(workflowRuns).values(values).returning({ id: workflowRuns.id });
    return inserted?.id;
  }

  const occurrenceKey = [row.workflowId, row.sourceTable, row.sourceId ?? '', triggerAt.toISOString()].join('|');
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`workflow_unstarted_run|${occurrenceKey}`}, 0))`);
    const [existing] = await tx
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.workflowId, row.workflowId),
          eq(workflowRuns.sourceTable, row.sourceTable),
          sql`${workflowRuns.sourceId} IS NOT DISTINCT FROM ${row.sourceId ?? null}`,
          eq(workflowRuns.triggerAt, triggerAt),
        ),
      )
      .limit(1);
    if (existing) return existing.id;
    const [inserted] = await tx.insert(workflowRuns).values(values).returning({ id: workflowRuns.id });
    return inserted?.id;
  });
}
