import { NextResponse } from 'next/server';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { reconcileMessageUnification } from '@/lib/repositories/message-unification-reconcile';

/**
 * Cron endpoint that compares the two legs of the message-table dual-write —
 * `chat_messages` (legacy) and `messages` (unified) — for recently-active
 * page conversations, and logs at ERROR level when they disagree.
 *
 * The second half of epic #2161's rule for a forced copy: a drift-guard TEST
 * proves the writers touch both legs, this proves the rows actually landed.
 * See `@/lib/repositories/message-unification-reconcile` for what is compared
 * and — just as importantly — what is deliberately excluded (global
 * conversations have only one leg; conversations older than the window are
 * the backfill's job, not a drift signal).
 *
 * READ-ONLY. It never repairs: the repair is
 * `scripts/backfill-unify-messages.ts`, which is reviewable and resumable,
 * and silent self-healing here would erase the evidence of whichever writer
 * caused the drift.
 *
 * A 200 with `diverged > 0` is NOT success — the HTTP status reports whether
 * the CHECK ran, and the payload reports what it found. Alerting reads the
 * error-level log line, not the status code.
 *
 * Authentication: HMAC-signed request with X-Cron-Timestamp, X-Cron-Nonce,
 * X-Cron-Signature headers (same gate as every other cron route).
 */
export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) {
    return authError;
  }

  try {
    const run = await reconcileMessageUnification();

    console.log(
      `[Cron] Message unification reconcile: checked ${run.checked}, diverged ${run.diverged}, missing rows ${run.missingRows}, window ${run.windowHours}h${run.capped ? ' (CAPPED — more conversations may diverge beyond the scan cap)' : ''}`,
    );

    audit({
      eventType: 'data.read',
      resourceType: 'cron_job',
      resourceId: 'reconcile_message_unification',
      details: {
        checked: run.checked,
        diverged: run.diverged,
        missingRows: run.missingRows,
        windowHours: run.windowHours,
        capped: run.capped,
      },
    });

    return NextResponse.json({
      success: true,
      checked: run.checked,
      diverged: run.diverged,
      missingRows: run.missingRows,
      samples: run.samples,
      windowHours: run.windowHours,
      capped: run.capped,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    loggers.system.error('[Cron] Error reconciling message unification', error as Error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
