import { NextResponse } from 'next/server';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { readBackfillCursor } from '@pagespace/lib/content-safety/backfill-store';
import { DEFAULT_READINESS_DAYS, assessEnforceReadiness } from '@pagespace/lib/content-safety/readiness';
import { countOpenScanFlaggedCases, countShadowOutcomesSince } from '@pagespace/lib/content-safety/scan-store';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { withAdminAuth } from '@/lib/auth';
import { fetchWebScanEnvironment } from '@/lib/content/web-readiness';

/**
 * GET /api/admin/content/readiness?days=14 — what still blocks CONTENT_SCAN_MODE=enforce.
 *
 * The web app's scan environment (booleans), the backfill's progress, shadow-mode
 * verdict counts for the last `days` days and the flagged cases still under
 * review. Counts and booleans only. It decides nothing: enforce stays an
 * environment change.
 */
export const GET = withAdminAuth(async (adminUser, request) => {
  try {
    const days = Math.min(Math.max(1, Number(new URL(request.url).searchParams.get('days')) || DEFAULT_READINESS_DAYS), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const [environment, backfill, shadow, openFlaggedCases] = await Promise.all([
      fetchWebScanEnvironment(adminUser.id),
      readBackfillCursor(),
      countShadowOutcomesSince(since),
      countOpenScanFlaggedCases(),
    ]);
    const report = assessEnforceReadiness({ environment, backfill, shadow: { days, counts: shadow }, openFlaggedCases });
    auditRequest(request, {
      eventType: 'content.case.read',
      userId: adminUser.id,
      resourceType: 'content_scans',
      resourceId: 'readiness',
      details: { source: 'admin', action: 'enforce_readiness', ready: report.ready },
    });
    return NextResponse.json({ ...report, days });
  } catch (error) {
    loggers.api.error('Error assessing enforce readiness', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to assess enforce readiness' }, { status: 500 });
  }
});
