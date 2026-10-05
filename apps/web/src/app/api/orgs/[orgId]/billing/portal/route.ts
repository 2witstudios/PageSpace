import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isBillingEnabled } from '@pagespace/lib/deployment-mode';
import { authorizeOrgRequest, orgsDisabledResponse, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';
import { createOrgBillingPortalSession, OrgBillingError } from '@/lib/org-billing/org-subscription';

type Context = { params: Promise<{ orgId: string }> };

/** Where Stripe sends the Owner or Admin back to: the org settings hub (UI-1). */
function orgSettingsUrl(orgId: string): string {
  const base = (process.env.WEB_APP_URL ?? '').replace(/\/+$/, '');
  return `${base}/orgs/${encodeURIComponent(orgId)}/settings`;
}

/**
 * POST /api/orgs/[orgId]/billing/portal — a Stripe billing-portal session on the ORG's own
 * customer (SEAT-6: payment method, billing email, invoices), never the caller's personal
 * customer. Owner and Admins only; absent where billing is off (onprem, tenant). An org that
 * has not subscribed yet has no customer: 409, subscribe first.
 */
export async function POST(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  if (!isBillingEnabled()) return orgsDisabledResponse();
  try {
    const session = await createOrgBillingPortalSession(orgId, orgSettingsUrl(orgId));
    auditRequest(request, {
      eventType: 'data.read',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { operation: 'open_org_billing_portal' },
    });
    return NextResponse.json({ url: session.url });
  } catch (error) {
    if (error instanceof OrgBillingError) {
      if (error.code === 'org_not_found') return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
      if (error.code === 'no_billing_customer') {
        return NextResponse.json({ error: 'This organization has no billing account yet; subscribe first.', code: 'no_billing_customer' }, { status: 409 });
      }
    }
    loggers.api.error('Error opening organization billing portal:', error as Error, { orgId });
    return NextResponse.json({ error: 'Could not reach the billing provider; try again.' }, { status: 502 });
  }
}
