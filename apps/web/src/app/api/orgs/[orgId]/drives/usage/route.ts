import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { listOrgDriveUsage } from '@pagespace/lib/permissions/org-read-models';
import { authorizeOrgRequest, ORG_READ_AUTH } from '@/lib/orgs/org-route-auth';

/**
 * GET /api/orgs/[orgId]/drives/usage — people, guests and storage per org drive (read model, D-OW-38; UI-7). Owner and Admins only: the
 * settings pages that show it are theirs, and a plain Member sees no org settings (UI-11).
 */
export async function GET(request: Request, context: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const usage = await listOrgDriveUsage(orgId);
    auditRequest(request, {
      eventType: 'data.read',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { operation: 'list_org_drive_usage', count: usage.length },
    });
    return NextResponse.json({ usage });
  } catch (error) {
    loggers.api.error('Error reading people, guests and storage per org drive:', error as Error);
    return NextResponse.json({ error: 'Failed to load people, guests and storage per org drive', code: 'internal_error' }, { status: 500 });
  }
}
