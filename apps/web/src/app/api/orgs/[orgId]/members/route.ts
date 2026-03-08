import { db, eq, and, orgMembers, organizations, users } from '@pagespace/db';
import { withOrgAuth, withOrgAdminAuth, type OrgRouteContext } from '@/lib/orgs/org-auth';
import { getOrgGuardrails, getOrgMemberCount, checkDomainAllowed } from '@/lib/orgs/guardrails';
import { canAddMember, type OrgBillingTier } from '@/lib/orgs/billing-plans';
import { adjustSeatsForMemberAdd } from '@/lib/orgs/seat-manager';
import { logger } from '@pagespace/lib';

// GET /api/orgs/[orgId]/members - List org members
export const GET = withOrgAuth<OrgRouteContext>(async (_user, _request, _context, orgId) => {
  const members = await db
    .select({
      id: orgMembers.id,
      userId: orgMembers.userId,
      role: orgMembers.role,
      invitedAt: orgMembers.invitedAt,
      acceptedAt: orgMembers.acceptedAt,
      user: {
        id: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
      },
    })
    .from(orgMembers)
    .innerJoin(users, eq(orgMembers.userId, users.id))
    .where(eq(orgMembers.orgId, orgId));

  return Response.json(members);
});

// POST /api/orgs/[orgId]/members - Add a member (admin only)
export const POST = withOrgAdminAuth<OrgRouteContext>(async (_user, request, _context, orgId) => {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { email, role = 'MEMBER' } = body as { email?: string; role?: string };

  if (!email || typeof email !== 'string') {
    return Response.json({ error: 'Email is required' }, { status: 400 });
  }

  if (!['ADMIN', 'MEMBER'].includes(role)) {
    return Response.json({ error: 'Role must be ADMIN or MEMBER' }, { status: 400 });
  }

  // Check plan member limits
  const [org] = await db
    .select({ billingTier: organizations.billingTier })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const currentMembers = await getOrgMemberCount(orgId);
  const tier = (org?.billingTier ?? 'free') as OrgBillingTier;

  if (!canAddMember(tier, currentMembers)) {
    return Response.json(
      { error: `Member limit reached for ${tier} plan. Upgrade to add more members.` },
      { status: 403 }
    );
  }

  // Check domain guardrails
  const guardrails = await getOrgGuardrails(orgId);
  if (guardrails) {
    const domainCheck = checkDomainAllowed(guardrails, email);
    if (!domainCheck.allowed) {
      return Response.json({ error: domainCheck.reason }, { status: 403 });
    }
  }

  // Find user by email
  const [targetUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!targetUser) {
    return Response.json({ error: 'User not found' }, { status: 404 });
  }

  // Check if already a member
  const [existing] = await db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, targetUser.id)))
    .limit(1);

  if (existing) {
    return Response.json({ error: 'User is already a member' }, { status: 409 });
  }

  // Insert member — the unique constraint on (orgId, userId) prevents duplicates
  // even if two requests race past the check above
  let member;
  try {
    const [inserted] = await db
      .insert(orgMembers)
      .values({
        orgId,
        userId: targetUser.id,
        role: role as 'ADMIN' | 'MEMBER',
        invitedBy: _user.id,
        acceptedAt: new Date(),
      })
      .returning();
    member = inserted;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '';
    if (message.includes('unique') || message.includes('duplicate')) {
      return Response.json({ error: 'User is already a member' }, { status: 409 });
    }
    throw err;
  }

  // Adjust seat count in billing (non-blocking: member add succeeds even if billing fails)
  const seatResult = await adjustSeatsForMemberAdd(orgId);
  if (!seatResult.success) {
    logger.child({ orgId }).warn('Seat adjustment failed after member add', { error: seatResult.error });
  }

  return Response.json(member, { status: 201 });
});
