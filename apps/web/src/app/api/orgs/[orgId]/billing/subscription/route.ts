import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isBillingEnabled } from '@pagespace/lib/deployment-mode';
import { authorizeOrgRequest, billingUnavailableResponse, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { OrgBillingError, orgSubscriptionSummary, provisionOrgSubscription } from '@/lib/org-billing/org-subscription';

/**
 * POST /api/orgs/[orgId]/billing/subscription — make sure the org has its own Stripe
 * customer and Business subscription (SEAT-1, SEAT-8, A-8) and say how to pay for it.
 * Owner and Admins only (SEAT-6). There is no trial ([D-OW-30]): a new subscription waits
 * on its first invoice, and `payment` carries that invoice's client secret for the
 * client's card confirmation (Stripe Payment Element). The same call re-subscribes a
 * lapsed org (a new subscription after the old one ended) and hands a past_due or unpaid
 * org the secret for what it owes; paying lifts the lapse through the webhook with no
 * other step (review 3+4 P1-1). Idempotent: an org already subscribed gets its
 * subscription back. Absent where billing is off (onprem, tenant).
 */
export async function POST(request: Request, context: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  if (!isBillingEnabled()) return billingUnavailableResponse();
  try {
    const { result, payment } = await provisionOrgSubscription(orgId);
    auditRequest(request, {
      eventType: 'data.write',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { operation: 'provision_org_subscription', outcome: result.kind, status: result.linkage.status, paymentStep: payment.kind },
    });
    return NextResponse.json(
      { subscription: orgSubscriptionSummary(result.linkage), payment },
      { status: result.kind === 'existing' ? 200 : 201 },
    );
  } catch (error) {
    if (error instanceof OrgBillingError) {
      if (error.code === 'org_not_found') return NextResponse.json({ error: 'Organization not found', code: 'org_not_found' }, { status: 404 });
      if (error.code === 'prices_not_configured') {
        loggers.api.error('Org billing prices are not configured', error);
        return NextResponse.json({ error: 'Organization billing is not available', code: 'billing_unavailable' }, { status: 503 });
      }
    }
    loggers.api.error('Error provisioning organization subscription:', error as Error, { orgId });
    return NextResponse.json(
      { error: 'Could not reach the billing provider; try again.', code: 'billing_provider_unreachable' },
      { status: 502 },
    );
  }
}
