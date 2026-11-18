import { NextResponse } from 'next/server';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { countScanVerdicts } from '@pagespace/lib/content-safety/scan-store';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { withAdminAuth } from '@/lib/auth';

/**
 * GET /api/admin/content/scans — publish-gate verdict counts, by mode and outcome.
 *
 * Counts of the latest verdict per content hash (`content_scans`), so shadow
 * mode can be measured before enforce is turned on. Counts only: no hash, file
 * or score leaves this route.
 */
export const GET = withAdminAuth(async (adminUser, request) => {
  try {
    const counts = await countScanVerdicts();
    auditRequest(request, {
      eventType: 'content.case.read',
      userId: adminUser.id,
      resourceType: 'content_scans',
      resourceId: 'counts',
      details: { source: 'admin', action: 'count_scan_verdicts' },
    });
    return NextResponse.json({ counts });
  } catch (error) {
    loggers.api.error('Error counting scan verdicts', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to count scan verdicts' }, { status: 500 });
  }
});
