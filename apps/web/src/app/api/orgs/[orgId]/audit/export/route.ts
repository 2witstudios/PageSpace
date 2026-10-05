import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { parseOrgAuditFilter } from '@pagespace/lib/audit/org-audit-query-core';
import { exportOrgAuditCsv } from '@pagespace/lib/audit/org-audit-query';
import { authorizeOrgRequest, ORG_READ_AUTH } from '@/lib/orgs/org-route-auth';
import { orgAuditFilterInput } from '@/lib/orgs/org-audit-filter';

type Context = { params: Promise<{ orgId: string }> };

/**
 * GET /api/orgs/[orgId]/audit/export (Spec AUD-3) — the org's audit log as CSV, with the same filters as
 * the log (paging aside). Streamed in chunks read by keyset, capped per file; every field is quoted per
 * RFC 4180 and neutralized against spreadsheet formulas. Owner and Admins only. The export is itself
 * audited (data.export).
 */
export async function GET(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const parsed = parseOrgAuditFilter({ ...orgAuditFilterInput(new URL(request.url)), limit: null, before: null });
    if (!parsed.ok) return NextResponse.json({ error: parsed.error, code: 'invalid_request' }, { status: 400 });
    const limit = await checkDistributedRateLimit(`org_audit_export:${orgId}:${gate.userId}`, DISTRIBUTED_RATE_LIMITS.EMAIL_RESEND);
    if (!limit.allowed) {
      return NextResponse.json({ error: 'Too many exports. Please try again later.', code: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(limit.retryAfter ?? 900) } });
    }
    const { limit: _limit, before: _before, ...filter } = parsed.filter;
    auditRequest(request, { eventType: 'data.export', userId: gate.userId, resourceType: 'organization_audit_log', resourceId: orgId, details: { orgId, eventTypes: filter.eventTypes.length, driveId: filter.driveId } });

    const chunks = exportOrgAuditCsv(orgId, filter);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await chunks.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(next.value));
        } catch (error) {
          loggers.api.error('Organization audit export failed mid-stream:', error as Error);
          controller.error(error);
        }
      },
      async cancel() {
        await chunks.return(undefined);
      },
    });
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="org-audit-${stamp}.csv"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    loggers.api.error('Error exporting organization audit log:', error as Error);
    return NextResponse.json({ error: 'Failed to export the audit log', code: 'internal_error' }, { status: 500 });
  }
}
