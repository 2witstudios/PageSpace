import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isBillingEnabled } from '@pagespace/lib/deployment-mode';
import { authorizeOrgRequest, orgsDisabledResponse, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { ensureOrgBusinessSubscription, OrgBillingError, orgSubscriptionSummary } from '@/lib/org-billing/org-subscription';

/**
 * POST /api/orgs/[orgId]/billing/subscription — make sure the org has its own Stripe
 * customer and Business subscription (SEAT-1, SEAT-8, A-8). Owner and Admins only
 * (SEAT-6). Idempotent: an org already subscribed gets its subscription back and
 * Stripe is not called; an org whose creation-time trial could not start (Stripe was
 * unreachable) is provisioned here. Absent where billing is off (onprem, tenant).
 */
export async function POST(request: Request, context: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  if (!isBillingEnabled()) return orgsDisabledResponse();
  try {
    const result = await ensureOrgBusinessSubscription(orgId);
    auditRequest(request, {
      eventType: 'data.write',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { operation: 'provision_org_subscription', outcome: result.kind, status: result.linkage.status },
    });
    return NextResponse.json({ subscription: orgSubscriptionSummary(result.linkage) }, { status: result.kind === 'existing' ? 200 : 201 });
  } catch (error) {
    if (error instanceof OrgBillingError) {
      if (error.code === 'org_not_found') return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
      if (error.code === 'prices_not_configured') {
        loggers.api.error('Org billing prices are not configured', error);
        return NextResponse.json({ error: 'Organization billing is not available' }, { status: 503 });
      }
    }
    loggers.api.error('Error provisioning organization subscription:', error as Error, { orgId });
    return NextResponse.json(
      { error: 'Could not reach the billing provider; try again.' },
      { status: 502 },
    );
  }
}
