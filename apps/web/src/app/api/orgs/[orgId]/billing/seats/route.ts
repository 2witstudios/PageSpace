import { NextResponse } from 'next/server';
import { z } from 'zod';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isBillingEnabled } from '@pagespace/lib/deployment-mode';
import { getSeatSummary, setSeatAutoAdd } from '@pagespace/lib/organizations/seat-service';
import { authorizeOrgRequest, orgsDisabledResponse, ORG_READ_AUTH, ORG_WRITE_AUTH } from '@/lib/orgs/org-route-auth';

type Context = { params: Promise<{ orgId: string }> };

const bodySchema = z.object({ autoAdd: z.boolean() }).strict();

/**
 * GET /api/orgs/[orgId]/billing/seats — seats held, seats purchased and the auto-add switch
 * (SEAT-3, SEAT-4). Owner and Admins only (SEAT-6); absent where billing is off. Counts, never
 * a price or a Stripe id.
 */
export async function GET(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'ADMIN', ORG_READ_AUTH);
  if (!gate.ok) return gate.response;
  if (!isBillingEnabled()) return orgsDisabledResponse();
  try {
    const { currentPeriodEnd, ...summary } = await getSeatSummary(orgId);
    return NextResponse.json({ seats: { ...summary, currentPeriodEnd: currentPeriodEnd?.toISOString() ?? null } });
  } catch (error) {
    loggers.api.error('Error reading organization seats:', error as Error, { orgId });
    return NextResponse.json({ error: 'Failed to read seats' }, { status: 500 });
  }
}

/**
 * PATCH /api/orgs/[orgId]/billing/seats — turn automatic seat purchase on or off (SEAT-4).
 * Owner only: it decides whether inviting can raise the bill, so an Admin cannot spend the
 * Owner's money by flipping it.
 */
export async function PATCH(request: Request, context: Context) {
  const { orgId } = await context.params;
  const gate = await authorizeOrgRequest(request, orgId, 'OWNER', ORG_WRITE_AUTH);
  if (!gate.ok) return gate.response;
  if (!isBillingEnabled()) return orgsDisabledResponse();
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body', issues: parsed.error.issues }, { status: 400 });
  }
  try {
    if (!(await setSeatAutoAdd(orgId, parsed.data.autoAdd, gate.userId))) {
      return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    }
    auditRequest(request, {
      eventType: 'data.write',
      userId: gate.userId,
      resourceType: 'organization',
      resourceId: orgId,
      details: { operation: 'set_seat_auto_add', autoAdd: parsed.data.autoAdd },
    });
    return NextResponse.json({ autoAdd: parsed.data.autoAdd });
  } catch (error) {
    loggers.api.error('Error updating seat auto-add:', error as Error, { orgId });
    return NextResponse.json({ error: 'Failed to update seats' }, { status: 500 });
  }
}
