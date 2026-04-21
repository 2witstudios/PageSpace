import { db, sql } from '@pagespace/db';
import { appendEvent } from './appendEvent';

export type ReapStaleRunsInput = {
  staleThresholdSec?: number;
};

export type ReapStaleRunsResult = {
  reapedRunIds: string[];
};

const DEFAULT_STALE_THRESHOLD_SEC = 60;

export async function reapStaleRuns(
  input: ReapStaleRunsInput = {},
): Promise<ReapStaleRunsResult> {
  const thresholdSec = input.staleThresholdSec ?? DEFAULT_STALE_THRESHOLD_SEC;

  const result = await db.execute(
    sql`SELECT id FROM agent_runs
        WHERE status = 'streaming'
          AND "lastHeartbeatAt" < now() - (${thresholdSec} * interval '1 second')`,
  );

  const rows = result.rows as Array<{ id: string }>;
  const reapedRunIds: string[] = [];

  for (const { id: runId } of rows) {
    try {
      await appendEvent({
        runId,
        type: 'error',
        payload: {
          message: `agent-run reaper: worker heartbeat exceeded ${thresholdSec}s`,
        },
      });
      reapedRunIds.push(runId);
    } catch {
      // Skip: the run may have reached a terminal status between our SELECT
      // and the appendEvent (the worker's finish/error/aborted won the race),
      // in which case appendEvent throws TerminalRunError. Other transient
      // errors are also skipped so one bad run can't stall the reaper.
    }
  }

  return { reapedRunIds };
}
