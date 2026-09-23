import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { listOrgDriveDirectory } from '@pagespace/lib/permissions/org-drive-directory';
import { authorizeOrgRequest, ORG_READ_AUTH } from '@/lib/orgs/org-route-auth';

/**
 * GET /api/orgs/[orgId]/drives — the org Drives directory (DRV-6): every drive of the org the caller
 * may see there, with its visibility, whether they joined it, their open join request, and its lead.
 * The only place a Restricted drive is discovered before joining. Any org member; a non-member gets
 * 404 from the org gate.
 */
export async function GET(request: Request, context: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'MEMBER', ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const drives = await listOrgDriveDirectory(orgId, gate.userId);
    // The gate admitted a member; a null here means they left between the two reads.
    if (drives === null) return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    auditRequest(request, {
      eventType: 'data.read',
      userId: gate.userId,
      resourceType: 'organization_drives',
      resourceId: orgId,
      details: { operation: 'list_org_drive_directory', count: drives.length },
    });
    return NextResponse.json({ drives });
  } catch (error) {
    loggers.api.error('Error listing the organization drive directory:', error as Error);
    return NextResponse.json({ error: 'Failed to list drives' }, { status: 500 });
  }
}
