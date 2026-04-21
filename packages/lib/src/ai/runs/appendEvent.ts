// The only supported write path to agent_run_events and the only place that
// assigns `seq`. Direct INSERTs bypass the advisory lock and will race.
import { db, sql } from '@pagespace/db';
import type { RunEventType } from './types';

export type AppendEventInput = {
  runId: string;
  type: RunEventType;
  payload: unknown;
};

export type AppendEventResult = {
  seq: number;
};

export class TerminalRunError extends Error {
  constructor(runId: string, status: string) {
    super(`appendEvent: runId "${runId}" is already terminal (status=${status})`);
    this.name = 'TerminalRunError';
  }
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'aborted']);

export async function appendEvent(input: AppendEventInput): Promise<AppendEventResult> {
  const { runId, type, payload } = input;
  const payloadJson = JSON.stringify(payload);

  let assignedSeq = 0;

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${runId}, 0))`,
    );

    const row = await tx.execute(
      sql`SELECT "lastSeq" AS last_seq, status FROM agent_runs WHERE id = ${runId} LIMIT 1`,
    );
    const existing = row.rows[0] as { last_seq: number; status: string } | undefined;
    if (!existing) {
      throw new Error(`appendEvent: runId "${runId}" does not exist`);
    }
    if (TERMINAL_STATUSES.has(existing.status)) {
      throw new TerminalRunError(runId, existing.status);
    }

    assignedSeq = existing.last_seq + 1;

    await tx.execute(
      sql`INSERT INTO agent_run_events ("runId", seq, type, payload)
          VALUES (${runId}, ${assignedSeq}, ${type}, ${payloadJson}::jsonb)`,
    );

    const nextStatus = nextStatusFor(type, existing.status);
    const errorMessage = type === 'error' ? (payload as { message?: string }).message ?? null : null;

    if (type === 'finish' || type === 'aborted') {
      await tx.execute(
        sql`UPDATE agent_runs
            SET "lastSeq" = ${assignedSeq},
                "lastHeartbeatAt" = now(),
                status = ${nextStatus},
                "completedAt" = now()
            WHERE id = ${runId}`,
      );
    } else if (type === 'error') {
      await tx.execute(
        sql`UPDATE agent_runs
            SET "lastSeq" = ${assignedSeq},
                "lastHeartbeatAt" = now(),
                status = ${nextStatus},
                "completedAt" = now(),
                "errorMessage" = ${errorMessage}
            WHERE id = ${runId}`,
      );
    } else {
      await tx.execute(
        sql`UPDATE agent_runs
            SET "lastSeq" = ${assignedSeq},
                "lastHeartbeatAt" = now(),
                status = ${nextStatus}
            WHERE id = ${runId}`,
      );
    }

    await tx.execute(
      sql`SELECT pg_notify(
        'agent_run_events',
        json_build_object('runId', ${runId}::text, 'seq', ${assignedSeq}::int, 'type', ${type}::text)::text
      )`,
    );
  });

  return { seq: assignedSeq };
}

function nextStatusFor(type: RunEventType, current: string): string {
  if (type === 'finish') return 'completed';
  if (type === 'error') return 'failed';
  if (type === 'aborted') return 'aborted';
  if (current === 'pending') return 'streaming';
  return current;
}
