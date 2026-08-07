import { NextResponse } from 'next/server';
import { audit } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { reconcileMessageUnification } from '@/lib/repositories/message-unification-reconcile';

/**
 * Cron endpoint that checks the LEGACY message table is still FROZEN.
 *
 * Since Phase 4 PR 14 `messages` is the sole write target and `chat_messages`
 * takes no INSERT or UPDATE from anywhere. This asks the database whether that
 * is actually true, for recently-active page conversations: every legacy row
 * must still have an identical `messages` twin. A legacy row without one means
 * a writer PR 14 missed is still live — invisible to every reader, and a
 * blocker for PR 15's DROP TABLE. It logs at ERROR level.
 *
 * The second half of epic #2161's rule for a forced copy: a drift-guard TEST
 * proves no writer names the legacy table, this proves no ROWS appeared in it.
 * See `@/lib/repositories/message-unification-reconcile` for the exact
 * fingerprint compared and what is deliberately excluded (global conversations
 * never had a legacy leg; legacy DELETEs are legitimate and stay invisible).
 *
 * READ-ONLY. It never repairs: silent self-healing here would erase the
 * evidence of whichever writer caused the drift, and the repair for a live
 * legacy writer is to DELETE THE WRITER, not to copy its rows across.
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
      `[Cron] Message unification reconcile: checked ${run.checked}, diverged ${run.diverged}, unmirrored legacy rows ${run.unmirroredRows}, window ${run.windowHours}h${run.capped ? ' (CAPPED — more conversations may diverge beyond the scan cap)' : ''}`,
    );

    audit({
      eventType: 'data.read',
      resourceType: 'cron_job',
      resourceId: 'reconcile_message_unification',
      details: {
        checked: run.checked,
        diverged: run.diverged,
        unmirroredRows: run.unmirroredRows,
        windowHours: run.windowHours,
        capped: run.capped,
      },
    });

    return NextResponse.json({
      success: true,
      checked: run.checked,
      diverged: run.diverged,
      unmirroredRows: run.unmirroredRows,
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
