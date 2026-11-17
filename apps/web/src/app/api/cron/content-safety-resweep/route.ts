import { NextResponse } from 'next/server';
import { audit } from '@pagespace/lib/audit/audit-log';
import { listCasesDueForResweep, listUnfinishedGlobalCases } from '@pagespace/lib/content-safety/case-store';
import { MAX_RESWEEP_ATTEMPTS } from '@pagespace/lib/content-safety/takedown';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { validateSignedCronRequest } from '@/lib/auth/cron-auth';
import { executeTakedown, sweepPublicForUnfinishedCase } from '@/lib/content-safety/takedown-service';

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
 * A pass that completes is not repeated. One that fails alerts the abuse inbox
 * (the lib does that) and is retried on later ticks, at least 20 minutes apart,
 * up to MAX_RESWEEP_ATTEMPTS; after that the case is left `open` for a person
 * to resume. A failed case also makes this run answer 500.
 *
 * Unfinished takedowns (halted for evidence storage or an admin's decision, or left open by a failed step)
 * are never re-swept, but a publish in flight when their hash was blocked can still put a public copy back.
 * Every tick takes their public copies offline again, and nothing else (`sweepPublicIfUnfinished`).
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
      quietBefore: new Date(now - PRESIGN_WINDOW_MS),
      notOlderThan: new Date(now - LOOKBACK_MS),
      maxAttempts: MAX_RESWEEP_ATTEMPTS,
    });

    let swept = 0;
    // Another run held the case: this tick did nothing to it, and the case stays due.
    let inProgress = 0;
    const failed: string[] = [];
    for (const row of due) {
      try {
        const result = await executeTakedown({ action: 'resweep', caseId: row.id }, null);
        if (result.inProgress) inProgress += 1;
        else if (result.status === 'actioned') swept += 1;
        else failed.push(row.id);
      } catch (error) {
        failed.push(row.id);
        loggers.system.error('[Cron] Content-safety re-sweep failed for a case', error instanceof Error ? error : undefined, { caseId: row.id });
      }
    }

    const unfinished = await listUnfinishedGlobalCases({ notOlderThan: new Date(now - LOOKBACK_MS) });
    let unfinishedPublicDeleted = 0;
    for (const row of unfinished) {
      try {
        const result = await sweepPublicForUnfinishedCase(row.id);
        if (result.swept && 'error' in result) failed.push(row.id);
        else if (result.swept) unfinishedPublicDeleted += result.deleted;
      } catch (error) {
        failed.push(row.id);
        loggers.system.error('[Cron] Content-safety public sweep failed for an unfinished case', error instanceof Error ? error : undefined, { caseId: row.id });
      }
    }

    audit({
      eventType: 'data.write',
      resourceType: 'cron_job',
      resourceId: 'content_safety_resweep',
      details: { due: due.length, swept, failed: failed.length, inProgress, unfinished: unfinished.length, unfinishedPublicDeleted },
    });

    const unfinishedSummary = unfinished.length > 0 ? { unfinished: unfinished.length, unfinishedPublicDeleted } : {};
    if (failed.length > 0) {
      return NextResponse.json({ success: false, due: due.length, swept, ...unfinishedSummary, failedCaseIds: failed }, { status: 500 });
    }
    return NextResponse.json({ success: true, due: due.length, swept, ...(inProgress > 0 ? { inProgress } : {}), ...unfinishedSummary });
  } catch (error) {
    loggers.system.error('[Cron] Content-safety re-sweep failed', error instanceof Error ? error : undefined);
    return NextResponse.json({ success: false, error: 'Re-sweep failed' }, { status: 500 });
  }
}
