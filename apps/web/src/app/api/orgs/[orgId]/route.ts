import { db, eq, organizations } from '@pagespace/db';
import { withOrgAuth, withOrgAdminAuth, type OrgRouteContext } from '@/lib/orgs/org-auth';

// GET /api/orgs/[orgId] - Get org details (safe columns only)
export const GET = withOrgAuth<OrgRouteContext>(async (_user, _request, _context, orgId) => {
  const [org] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      billingTier: organizations.billingTier,
      createdAt: organizations.createdAt,
      updatedAt: organizations.updatedAt,
    })
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
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { name } = body;

  if (!name || typeof name !== 'string') {
    return Response.json({ error: 'Name is required' }, { status: 400 });
  }

  if (name.length > 100) {
    return Response.json({ error: 'Name must be 100 characters or fewer' }, { status: 400 });
  }

  await db
    .update(organizations)
    .set({ name })
    .where(eq(organizations.id, orgId));

  const [updated] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      billingTier: organizations.billingTier,
      createdAt: organizations.createdAt,
      updatedAt: organizations.updatedAt,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  return Response.json(updated);
});
