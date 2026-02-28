import { db, eq, and, orgMembers, users } from '@pagespace/db';
import { withOrgAuth, withOrgAdminAuth, type OrgRouteContext } from '@/lib/orgs/org-auth';
import { getOrgGuardrails, checkDomainAllowed } from '@/lib/orgs/guardrails';

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
  const body = await request.json();
  const { email, role = 'MEMBER' } = body;

  if (!email) {
    return Response.json({ error: 'Email is required' }, { status: 400 });
  }

  if (!['ADMIN', 'MEMBER'].includes(role)) {
    return Response.json({ error: 'Role must be ADMIN or MEMBER' }, { status: 400 });
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

  const [member] = await db
    .insert(orgMembers)
    .values({
      orgId,
      userId: targetUser.id,
      role: role as 'ADMIN' | 'MEMBER',
      invitedBy: _user.id,
      acceptedAt: new Date(),
    })
    .returning();

  return Response.json(member, { status: 201 });
});
