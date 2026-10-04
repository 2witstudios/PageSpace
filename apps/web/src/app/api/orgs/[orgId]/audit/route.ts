import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { parseOrgAuditFilter } from '@pagespace/lib/audit/org-audit-query-core';
import { queryOrgAuditEvents } from '@pagespace/lib/audit/org-audit-query';
import { authorizeOrgRequest, ORG_READ_AUTH } from '@/lib/orgs/org-route-auth';
import { orgAuditFilterInput } from '@/lib/orgs/org-audit-filter';

type Context = { params: Promise<{ orgId: string }> };

/**
 * GET /api/orgs/[orgId]/audit (Spec AUD-1, AUD-3) — the org's audit log, newest first, filtered by
 * `type` or `category`, `driveId`, `from`/`to` (ISO times), paged by `before` (the previous page's
 * `nextCursor`). Owner and Admins only; a member gets 403 and a non-member the 404 of an org that does not
 * exist. Rows are always this org's: the org in the path is the only org the query can read.
 */
export async function GET(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const parsed = parseOrgAuditFilter(orgAuditFilterInput(new URL(request.url)));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const page = await queryOrgAuditEvents(orgId, parsed.filter);
    auditRequest(request, { eventType: 'data.read', userId: gate.userId, resourceType: 'organization_audit_log', resourceId: orgId, details: { count: page.entries.length } });
    return NextResponse.json(page);
  } catch (error) {
    loggers.api.error('Error reading organization audit log:', error as Error);
    return NextResponse.json({ error: 'Failed to read the audit log' }, { status: 500 });
  }
}
