import { NextResponse } from 'next/server';
import { audit } from '@pagespace/lib/audit/audit-log';
import { listCasesDueForResweep } from '@pagespace/lib/content-safety/case-store';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { executeTakedown } from '@/lib/content-safety/takedown-service';

/**
 * Cron endpoint: pass over storage once more for every recently finished
 * global takedown.
 *
 * A presigned PUT issued before a hash was blocked stays valid until its TTL
 * runs out (15 minutes), so bytes can land at `files/<hash>/original` AFTER the
 * takedown deleted that key. Nothing can serve them — the hash is blocked, so
 * every reader answers 410 and upload-complete refuses — but they would sit in
 * the bucket. Once the TTL window has closed, each case gets one more
 * preserve-and-delete pass.
 *
 * A case is swept once: the pass leaves a `resweep` marker in its steps.
 *
 * Authentication: HMAC-signed request with X-Cron-Timestamp, X-Cron-Nonce, X-Cron-Signature.
 */

/** Longest presigned PUT TTL, plus slack. */
const PRESIGN_WINDOW_MS = 20 * 60 * 1000;
/** How far back to look. A case older than this that was never swept is left to an admin. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export async function GET(request: Request) {
  const authError = validateSignedCronRequest(request);
  if (authError) return authError;

  try {
    const now = Date.now();
    const due = await listCasesDueForResweep({
      actionedBefore: new Date(now - PRESIGN_WINDOW_MS),
      actionedAfter: new Date(now - LOOKBACK_MS),
    });

    let swept = 0;
    const failed: string[] = [];
    for (const row of due) {
      try {
        const result = await executeTakedown({ action: 'resweep', caseId: row.id }, null);
        if (result.status === 'actioned') swept += 1;
        else failed.push(row.id);
      } catch (error) {
        failed.push(row.id);
        loggers.system.error('[Cron] Content-safety re-sweep failed for a case', error instanceof Error ? error : undefined, { caseId: row.id });
      }
    }

    audit({
      eventType: 'data.write',
      resourceType: 'cron_job',
      resourceId: 'content_safety_resweep',
      details: { due: due.length, swept, failed: failed.length },
    });

    if (failed.length > 0) {
      return NextResponse.json({ success: false, due: due.length, swept, failedCaseIds: failed }, { status: 500 });
    }
    return NextResponse.json({ success: true, due: due.length, swept });
  } catch (error) {
    loggers.system.error('[Cron] Content-safety re-sweep failed', error instanceof Error ? error : undefined);
    return NextResponse.json({ success: false, error: 'Re-sweep failed' }, { status: 500 });
  }
}
