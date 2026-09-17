import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { transferOwnership } from '@pagespace/lib/organizations/membership';
import { authorizeOrgRequest, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { transferOwnershipSchema } from '@/lib/orgs/org-schemas';

/**
 * POST /api/orgs/[orgId]/transfer-ownership — the Owner hands the org to another
 * member (ORG-1). organizations.ownerId and the OWNER row move in one transaction;
 * the previous Owner stays as an Admin.
 */
export async function POST(request: Request, context: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'OWNER', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const parsed = transferOwnershipSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 });
    }
    const result = await transferOwnership({ orgId, actorId: gate.userId, targetId: parsed.data.toUserId });
    if (!result.ok) {
      const error =
        result.reason === 'target_not_member'
          ? 'Ownership can only move to a member of this organization'
          : result.reason === 'already_owner'
            ? 'You already own this organization'
            : result.reason === 'not_found'
              ? 'Organization not found'
              : 'Only the Owner can transfer ownership';
      return NextResponse.json({ error, reason: result.reason }, { status: result.status });
    }
    auditRequest(request, {
      eventType: 'authz.role.assigned',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { operation: 'transfer_org_ownership', fromUserId: gate.userId, toUserId: parsed.data.toUserId },
    });
    return NextResponse.json({ ownerId: parsed.data.toUserId });
  } catch (error) {
    loggers.api.error('Error transferring organization ownership:', error as Error);
    return NextResponse.json({ error: 'Failed to transfer ownership' }, { status: 500 });
  }
}
