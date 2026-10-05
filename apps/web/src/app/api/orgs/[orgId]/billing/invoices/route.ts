import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isBillingEnabled } from '@pagespace/lib/deployment-mode';
import { authorizeOrgRequest, orgsDisabledResponse, ORG_READ_AUTH } from '@/lib/orgs/org-route-auth';
import { listOrgInvoices, OrgBillingError } from '@/lib/org-billing/org-subscription';
import { parseBoundedIntParam } from '@/lib/utils/query-params';

type Context = { params: Promise<{ orgId: string }> };

/** A Stripe invoice id, as `starting_after` takes it. Anything else is refused before Stripe sees it. */
const INVOICE_ID = /^in_[A-Za-z0-9]{1,250}$/;

/**
 * GET /api/orgs/[orgId]/billing/invoices — one page of the ORG's invoices, newest first
 * (SEAT-6), from the org's own Stripe customer, never the caller's. Owner and Admins only;
 * absent where billing is off (onprem, tenant). Query: `limit` (1-100, default 10) and
 * `starting_after` (an invoice id, for the next page).
 */
export async function GET(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  if (!isBillingEnabled()) return orgsDisabledResponse();
  const { searchParams } = new URL(request.url);
  const limit = parseBoundedIntParam(searchParams.get('limit'), { defaultValue: 10, min: 1, max: 100 });
  const startingAfter = searchParams.get('starting_after') || undefined;
  if (startingAfter !== undefined && !INVOICE_ID.test(startingAfter)) {
    return NextResponse.json({ error: 'Invalid starting_after' }, { status: 400 });
  }
  try {
    const page = await listOrgInvoices(orgId, { limit, startingAfter });
    auditRequest(request, {
      eventType: 'data.read',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { operation: 'list_org_invoices', count: page.invoices.length },
    });
    return NextResponse.json(page);
  } catch (error) {
    if (error instanceof OrgBillingError && error.code === 'org_not_found') {
      return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    }
    loggers.api.error('Error listing organization invoices:', error as Error, { orgId });
    return NextResponse.json({ error: 'Could not reach the billing provider; try again.' }, { status: 502 });
  }
}
