import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getContentCase } from '@pagespace/lib/content-safety/case-store';
import {
  closeReportedCase,
  getReportedCase,
  listCaseReports,
  listReportedCases,
  ReportedCaseChangedError,
  ReportedCaseNotFoundError,
} from '@pagespace/lib/content-safety/report-store';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { withAdminAuth } from '@/lib/auth';
import { toReportedCaseSummary, toReportSummary } from '@/lib/content/report-summary';
import { parseBoundedIntParam } from '@/lib/utils/query-params';

/**
 * GET /api/admin/content/reports[?limit=&offset=] — the review queue: cases opened by reports, CSAM first.
 * GET /api/admin/content/reports?id=<caseId> — one case with its reports (the link in a report alert).
 * GET /api/admin/content/reports?id=<caseId>&reportsBefore=<reportId>[&reportsLimit=] — that case's reports older
 *   than the last one shown, newest first, so no report past the first page is out of reach.
 *
 * Metadata and the reporters' own words only. The text is returned as stored;
 * the console renders it as inert text.
 */
const REPORT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const GET = withAdminAuth(async (adminUser, request) => {
  try {
    const params = new URL(request.url).searchParams;

    const id = params.get('id');
    const before = params.get('reportsBefore');
    if (id && before !== null) {
      if (!REPORT_ID.test(before)) return NextResponse.json({ error: 'Invalid report cursor' }, { status: 400 });
      const limit = parseBoundedIntParam(params.get('reportsLimit'), { defaultValue: 50, min: 1, max: 100 });
      const row = await getContentCase(id);
      auditRequest(request, {
        eventType: 'content.case.read',
        userId: adminUser.id,
        resourceType: 'content_case',
        resourceId: id,
        details: { source: 'admin', action: 'view_reports_page', found: row !== null },
      });
      if (!row) return NextResponse.json({ error: 'Case not found' }, { status: 404 });
      const reports = await listCaseReports(id, { beforeId: before, limit });
      return NextResponse.json({ reports: reports.map(toReportSummary), limit });
    }
    if (id) {
      const withReports = await getReportedCase(id);
      auditRequest(request, {
        eventType: 'content.case.read',
        userId: adminUser.id,
        resourceType: 'content_case',
        resourceId: id,
        details: { source: 'admin', action: 'view_reports', found: withReports !== null },
      });
      if (!withReports) return NextResponse.json({ error: 'Case not found' }, { status: 404 });
      return NextResponse.json({ cases: [toReportedCaseSummary(withReports)] });
    }

    const limit = parseBoundedIntParam(params.get('limit'), { defaultValue: 50, min: 1, max: 200 });
    const offset = parseBoundedIntParam(params.get('offset'), { defaultValue: 0, min: 0, max: 100000 });
    const rows = await listReportedCases({ limit, offset });
    auditRequest(request, {
      eventType: 'content.case.read',
      userId: adminUser.id,
      resourceType: 'content_case',
      resourceId: 'reports',
      details: { source: 'admin', action: 'list_reports', count: rows.length },
    });
    return NextResponse.json({ cases: rows.map(toReportedCaseSummary), limit, offset });
  } catch (error) {
    loggers.api.error('Error listing content reports', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to list reports' }, { status: 500 });
  }
});

const closeSchema = z.object({
  caseId: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  outcome: z.enum(['dismissed', 'actioned']),
  // The report count the admin was shown: a report that arrived since refuses the close.
  expectedReportCount: z.number().int().min(1).max(1_000_000),
  note: z.string().trim().max(1000).optional(),
});

/**
 * POST /api/admin/content/reports — close a case under review.
 * `actioned`: staff took action (a takedown runs as its own case, from the Take down tab).
 * `dismissed`: no violation. The next report on the same target opens a new case.
 */
export const POST = withAdminAuth(async (adminUser, request) => {
  const parsed = closeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors }, { status: 400 });
  }
  const { caseId, outcome, expectedReportCount, note } = parsed.data;
  try {
    const row = await closeReportedCase({ caseId, outcome, actorUserId: adminUser.id, expectedReportCount, note: note || undefined });
    auditRequest(request, {
      eventType: 'content.report.resolved',
      userId: adminUser.id,
      resourceType: 'content_case',
      resourceId: caseId,
      details: { outcome },
    });
    return NextResponse.json({ caseId: row.id, status: row.status });
  } catch (error) {
    if (error instanceof ReportedCaseChangedError) {
      return NextResponse.json({ error: 'New reports arrived on this case. Refresh and review them first.' }, { status: 409 });
    }
    if (error instanceof ReportedCaseNotFoundError) {
      return NextResponse.json({ error: 'That case is not waiting for review' }, { status: 404 });
    }
    loggers.api.error('Error closing a reported case', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to update the case' }, { status: 500 });
  }
});
