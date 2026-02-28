import { db, eq, organizations } from '@pagespace/db';
import { withOrgAuth, withOrgAdminAuth, type OrgRouteContext } from '@/lib/orgs/org-auth';

// GET /api/orgs/[orgId] - Get org details
export const GET = withOrgAuth<OrgRouteContext>(async (_user, _request, _context, orgId) => {
  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) {
    return Response.json({ error: 'Organization not found' }, { status: 404 });
  }

  return Response.json(org);
});

// PATCH /api/orgs/[orgId] - Update org details (admin only)
export const PATCH = withOrgAdminAuth<OrgRouteContext>(async (_user, request, _context, orgId) => {
  const body = await request.json();
  const { name } = body;

  if (!name) {
    return Response.json({ error: 'Name is required' }, { status: 400 });
  }

  await db
    .update(organizations)
    .set({ name })
    .where(eq(organizations.id, orgId));

  const [updated] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  return Response.json(updated);
});
