import { withOrgAdminAuth, type OrgRouteContext } from '@/lib/orgs/org-auth';
import { updateSeatCount, getActiveOrgSubscription } from '@/lib/orgs/seat-manager';
import { getOrgMemberCount } from '@/lib/orgs/guardrails';

// GET /api/orgs/[orgId]/billing/seats - Get seat info
export const GET = withOrgAdminAuth<OrgRouteContext>(async (_user, _request, _context, orgId) => {
  const subscription = await getActiveOrgSubscription(orgId);
  const memberCount = await getOrgMemberCount(orgId);

  return Response.json({
    currentSeats: subscription?.quantity ?? memberCount,
    activeMembers: memberCount,
    hasSubscription: !!subscription,
    gracePeriodEnd: subscription?.gracePeriodEnd ?? null,
  });
});

// PUT /api/orgs/[orgId]/billing/seats - Manually update seat count
export const PUT = withOrgAdminAuth<OrgRouteContext>(async (_user, request, _context, orgId) => {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { quantity } = body as { quantity?: number };

  if (typeof quantity !== 'number' || quantity < 1) {
    return Response.json({ error: 'quantity must be a positive number' }, { status: 400 });
  }

  const result = await updateSeatCount(orgId, quantity);

  if (!result.success) {
    return Response.json({ error: result.error }, { status: 400 });
  }

  return Response.json({
    success: true,
    newQuantity: result.newQuantity,
    prorated: result.prorated,
  });
});
