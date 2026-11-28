import { NextResponse } from 'next/server';
import type { ContentCaseStatus } from '@pagespace/db/schema/content-safety';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getContentCase, listContentCases } from '@pagespace/lib/content-safety/case-store';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { withAdminAuth } from '@/lib/auth';
import { toCaseSummary } from '@/lib/content/case-summary';
import { parseBoundedIntParam } from '@/lib/utils/query-params';

const STATUSES: readonly ContentCaseStatus[] = ['reported', 'open', 'awaiting_evidence', 'actioned', 'dismissed'];

/**
 * GET /api/admin/content/cases[?status=&limit=&offset=] — the case list, newest first, with step progress.
 * GET /api/admin/content/cases?id=<caseId> — one case (the link in an alert email lands here).
 */
export const GET = withAdminAuth(async (adminUser, request) => {
  try {
    const params = new URL(request.url).searchParams;

    const id = params.get('id');
    if (id) {
      const row = await getContentCase(id);
      auditRequest(request, {
        eventType: 'content.case.read',
        userId: adminUser.id,
        resourceType: 'content_case',
        resourceId: id,
        details: { source: 'admin', action: 'view_case', found: row !== null },
      });
      if (!row) return NextResponse.json({ error: 'Case not found' }, { status: 404 });
      return NextResponse.json({ cases: [toCaseSummary(row)] });
    }

    const statusParam = params.get('status');
    const status = STATUSES.find((s) => s === statusParam);
    if (statusParam && statusParam !== 'all' && !status) {
      return NextResponse.json({ error: 'Unknown status' }, { status: 400 });
    }
    const limit = parseBoundedIntParam(params.get('limit'), { defaultValue: 50, min: 1, max: 200 });
    const offset = parseBoundedIntParam(params.get('offset'), { defaultValue: 0, min: 0, max: 100000 });

    const rows = await listContentCases({ status, limit, offset });
    auditRequest(request, {
      eventType: 'content.case.read',
      userId: adminUser.id,
      resourceType: 'content_case',
      resourceId: 'list',
      details: { source: 'admin', action: 'list_cases', status: status ?? 'all', count: rows.length },
    });
    return NextResponse.json({ cases: rows.map(toCaseSummary), limit, offset });
  } catch (error) {
    loggers.api.error('Error listing content cases', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to list cases' }, { status: 500 });
  }
});
