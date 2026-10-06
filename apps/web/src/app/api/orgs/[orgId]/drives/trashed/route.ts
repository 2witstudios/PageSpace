import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { listOrgTrashedDrives } from '@pagespace/lib/permissions/org-read-models';
import { authorizeOrgRequest, ORG_READ_AUTH } from '@/lib/orgs/org-route-auth';

/**
 * GET /api/orgs/[orgId]/drives/trashed — the org's trashed drives, Private ones included (read model, D-OW-38; UI-7). Owner and Admins only: the
 * settings pages that show it are theirs, and a plain Member sees no org settings (UI-11).
 */
export async function GET(request: Request, context: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const drives = await listOrgTrashedDrives(orgId);
    auditRequest(request, {
      eventType: 'data.read',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { operation: 'list_org_trashed_drives', count: drives.length },
    });
    return NextResponse.json({ drives });
  } catch (error) {
    loggers.api.error("Error reading the organization's trashed drives:", error as Error);
    return NextResponse.json({ error: "Failed to load the trashed drives", code: 'internal_error' }, { status: 500 });
  }
}
