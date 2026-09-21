/**
 * An unstarted run (a terminal credit refusal, or a gate that failed past its
 * retry window) is recorded as ONE error row per occurrence, under real
 * concurrency. The gate runs before the claim, so two overlapping cron ticks
 * that both refuse never reach the running-claim index that used to turn the
 * loser into a claimConflict, and workflow_runs' only unique index covers
 * status='running'. A mocked DB cannot show that two concurrent transactions
 * serialize, so this runs against real Postgres.
 *
 * Requires DATABASE_URL → a running Postgres with migrations applied
 * (scripts/test-with-db.sh, port 5433). FAILS LOUDLY when no DB is reachable — a
 * silent skip would be a green, zero-assertion pass. Local runs without Docker
 * opt out explicitly with ALLOW_SKIP_DB_TESTS=1.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { workflows } from '@pagespace/db/schema/workflows';
import { workflowRuns } from '@pagespace/db/schema/workflow-runs';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { recordUnstartedRunOnce, type UnstartedRunRow } from '../record-unstarted-run';

let dbAvailable = false;

async function createWorkflow(): Promise<string> {
  const owner = await factories.createUser();
  const drive = await factories.createDrive(owner.id);
  const [workflow] = await db
    .insert(workflows)
    .values({ id: createId(), driveId: drive.id, createdBy: owner.id, name: 'refused', prompt: 'p', timezone: 'UTC' })
    .returning({ id: workflows.id });
  return workflow.id;
}

/**
 * Force the race instead of hoping for it: hold a lock that blocks every
 * INSERT into workflow_runs (reads still pass) until all `writers` backends are
 * waiting on a lock, then release it. Without serialization each writer has
 * already read "no row" by then, so every one of them inserts. The lock is held
 * for milliseconds, far below the 5s lock_timeout other suites' inserts wait
 * under.
 */
async function raceWriters<T>(writers: number, start: () => Promise<T>[]): Promise<T[]> {
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE workflow_runs IN SHARE ROW EXCLUSIVE MODE');
    let settled = false;
    const running = Promise.all(start()).finally(() => {
      settled = true;
    });
    // Writers that finish without ever blocking had nothing to race over.
    for (let waited = 0; !settled; waited += 20) {
      // pg_stat_activity is snapshotted once per transaction; the blocker polls
      // from inside its own, so clear the snapshot to see the writers arrive.
      await blocker.query('SELECT pg_stat_clear_snapshot()');
      const { rows } = await blocker.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND (wait_event = 'advisory' OR query ILIKE '%workflow_runs%')`,
      );
      if (Number(rows[0].n) >= writers) break;
      // Stay well under the app pool's 5s lock_timeout.
      if (waited > 3_000) throw new Error(`only ${rows[0].n}/${writers} writers reached the lock`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await blocker.query('COMMIT');
    return await running;
  } finally {
    blocker.release();
  }
}

async function runRows(workflowId: string) {
  return db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, workflowId));
}

describe('recordUnstartedRunOnce — one error row per occurrence', () => {
  beforeAll(async () => {
    try {
      await db.select().from(pages).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('record-unstarted-run.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  it('given overlapping ticks that both refuse the same cron slot, should write ONE error row and hand both the same run id', async () => {
    if (!dbAvailable) return;
    const workflowId = await createWorkflow();
    const row: UnstartedRunRow = {
      workflowId,
      sourceTable: 'cron',
      sourceId: null,
      triggerAt: new Date('2026-09-20T09:00:00.000Z'),
      durationMs: 1,
      error: 'AI credit gate denied: out_of_credits',
    };

    const ids = await raceWriters(6, () => Array.from({ length: 6 }, () => recordUnstartedRunOnce(row)));

    const rows = await runRows(workflowId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'error', error: 'AI credit gate denied: out_of_credits' });
    expect(new Set(ids)).toEqual(new Set([rows[0].id]));
  });

  it('given the same trigger refused for two DIFFERENT occurrences, should record both', async () => {
    if (!dbAvailable) return;
    const workflowId = await createWorkflow();
    const base = { workflowId, sourceTable: 'taskTriggers' as const, sourceId: 'trg_1', durationMs: 1, error: 'x' };

    await recordUnstartedRunOnce({ ...base, triggerAt: new Date('2026-09-20T09:00:00.000Z') });
    await recordUnstartedRunOnce({ ...base, triggerAt: new Date('2026-09-21T09:00:00.000Z') });

    expect(await runRows(workflowId)).toHaveLength(2);
  });

  it('given an occurrence that is still running, should not add an error row beside it', async () => {
    if (!dbAvailable) return;
    const workflowId = await createWorkflow();
    const triggerAt = new Date('2026-09-20T09:00:00.000Z');
    await db.insert(workflowRuns).values({ workflowId, sourceTable: 'calendarTriggers', sourceId: 'ct_1', triggerAt, status: 'running' });

    await recordUnstartedRunOnce({ workflowId, sourceTable: 'calendarTriggers', sourceId: 'ct_1', triggerAt, durationMs: 1, error: 'x' });

    expect((await runRows(workflowId)).map((r) => r.status)).toEqual(['running']);
  });

  it('given two triggers of one workflow due at the same instant, should record each trigger', async () => {
    if (!dbAvailable) return;
    const workflowId = await createWorkflow();
    const at = { workflowId, sourceTable: 'taskTriggers' as const, triggerAt: new Date('2026-09-20T09:00:00.000Z'), durationMs: 1, error: 'x' };

    await recordUnstartedRunOnce({ ...at, sourceId: 'trg_a' });
    await recordUnstartedRunOnce({ ...at, sourceId: 'trg_b' });

    expect(await runRows(workflowId)).toHaveLength(2);
  });

  it('given two sources of one workflow sharing an id and occurrence time, should record each source', async () => {
    if (!dbAvailable) return;
    const workflowId = await createWorkflow();
    const shared = { workflowId, sourceId: 'shared_1', triggerAt: new Date('2026-09-20T09:00:00.000Z'), durationMs: 1, error: 'x' };

    await recordUnstartedRunOnce({ ...shared, sourceTable: 'calendarTriggers' });
    await recordUnstartedRunOnce({ ...shared, sourceTable: 'taskTriggers' });

    expect(await runRows(workflowId)).toHaveLength(2);
  });

  it('given an occurrence whose earlier run SUCCEEDED (a slot retried at the same time), should record the refusal as its own row, never hand back the success run id', async () => {
    if (!dbAvailable) return;
    const workflowId = await createWorkflow();
    const triggerAt = new Date('2026-09-20T09:00:00.000Z');
    const [ran] = await db
      .insert(workflowRuns)
      .values({ workflowId, sourceTable: 'cron', sourceId: null, triggerAt, status: 'success', endedAt: triggerAt })
      .returning({ id: workflowRuns.id });

    const runId = await recordUnstartedRunOnce({ workflowId, sourceTable: 'cron', sourceId: null, triggerAt, durationMs: 1, error: 'refused' });

    const rows = await runRows(workflowId);
    expect(rows.map((r) => r.status).sort()).toEqual(['error', 'success']);
    expect(runId).toBe(rows.find((r) => r.status === 'error')?.id);
    expect(runId).not.toBe(ran.id);
  });

  it('given a fire with no occurrence time (manual), should record every attempt', async () => {
    if (!dbAvailable) return;
    const workflowId = await createWorkflow();
    const row: UnstartedRunRow = { workflowId, sourceTable: 'manual', sourceId: null, triggerAt: null, durationMs: 1, error: 'x' };

    await recordUnstartedRunOnce(row);
    await recordUnstartedRunOnce(row);

    expect(await runRows(workflowId)).toHaveLength(2);
  });
});
