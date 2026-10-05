import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getOrgPoolSplit } from '@pagespace/lib/services/drive-wallet-service';
import { authorizeOrgRequest, ORG_READ_AUTH } from '@/lib/orgs/org-route-auth';

/**
 * GET /api/orgs/[orgId]/pool — the org pool and where it goes: available, unallocated, seats and every
 * drive wallet (read model, D-OW-38 "pool split"; SPEND-10; UI-7). Owner and Admins only:
 * SPEND-9 keeps the pool from every consumer.
 */
export async function GET(request: Request, context: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  try {
    const read = await getOrgPoolSplit(orgId);
    auditRequest(request, {
      eventType: 'data.read',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { operation: 'read_org_pool_split', driveWallets: read.driveWallets.length },
    });
    return NextResponse.json(read);
  } catch (error) {
    loggers.api.error('Error reading the organization pool:', error as Error);
    return NextResponse.json({ error: 'Failed to load the credits pool', code: 'internal_error' }, { status: 500 });
  }
}
