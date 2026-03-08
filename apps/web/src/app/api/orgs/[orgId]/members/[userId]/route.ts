import { db, eq, and, orgMembers } from '@pagespace/db';
import { withOrgAdminAuth, type OrgMemberRouteContext } from '@/lib/orgs/org-auth';
import { isOrgOwner } from '@/lib/orgs/guardrails';
import { adjustSeatsForMemberRemove } from '@/lib/orgs/seat-manager';

// PATCH /api/orgs/[orgId]/members/[userId] - Update member role
export const PATCH = withOrgAdminAuth<OrgMemberRouteContext>(async (_user, request, context, orgId) => {
  const { userId } = await context.params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { role } = body as { role?: string };

  if (!role || !['ADMIN', 'MEMBER'].includes(role)) {
    return Response.json({ error: 'Role must be ADMIN or MEMBER' }, { status: 400 });
  }

  // Cannot change the owner's role
  const ownerCheck = await isOrgOwner(userId, orgId);
  if (ownerCheck) {
    return Response.json({ error: 'Cannot change the organization owner\'s role' }, { status: 403 });
  }

  const [updated] = await db
    .update(orgMembers)
    .set({ role })
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .returning();

  if (!updated) {
    return Response.json({ error: 'Member not found' }, { status: 404 });
  }

  return Response.json(updated);
});

// DELETE /api/orgs/[orgId]/members/[userId] - Remove member
export const DELETE = withOrgAdminAuth<OrgMemberRouteContext>(async (_user, _request, context, orgId) => {
  const { userId } = await context.params;

  // Cannot remove the owner
  const ownerCheck = await isOrgOwner(userId, orgId);
  if (ownerCheck) {
    return Response.json({ error: 'Cannot remove the organization owner' }, { status: 403 });
  }

  const [deleted] = await db
    .delete(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
    .returning();

  if (!deleted) {
    return Response.json({ error: 'Member not found' }, { status: 404 });
  }

  // Adjust seat count (grace period before billing decrease)
  await adjustSeatsForMemberRemove(orgId);

  return Response.json({ success: true });
});
