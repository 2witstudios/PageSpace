import { db, eq, organizations, orgMembers } from '@pagespace/db';
import { verifyAuth } from '@/lib/auth/auth';
import { validateCSRF } from '@/lib/auth/csrf-validation';
import { NextResponse } from 'next/server';
import { createId } from '@paralleldrive/cuid2';

// GET /api/orgs - List orgs the user belongs to
export async function GET(request: Request) {
  const user = await verifyAuth(request);
  if (!user) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  const memberships = await db
    .select({
      orgId: orgMembers.orgId,
      role: orgMembers.role,
      org: {
        id: organizations.id,
        name: organizations.name,
        slug: organizations.slug,
        billingTier: organizations.billingTier,
        createdAt: organizations.createdAt,
      },
    })
    .from(orgMembers)
    .innerJoin(organizations, eq(orgMembers.orgId, organizations.id))
    .where(eq(orgMembers.userId, user.id));

  return Response.json(memberships);
}

// POST /api/orgs - Create a new organization
export async function POST(request: Request) {
  const user = await verifyAuth(request);
  if (!user) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  // CSRF protection for state-changing operation
  if (user.authTransport === 'cookie') {
    const csrfError = await validateCSRF(request);
    if (csrfError) return csrfError;
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { name, slug } = body as { name?: string; slug?: string };

  if (!name || !slug || typeof name !== 'string' || typeof slug !== 'string') {
    return NextResponse.json({ error: 'Name and slug are required' }, { status: 400 });
  }

  if (name.length > 100) {
    return NextResponse.json({ error: 'Name must be 100 characters or fewer' }, { status: 400 });
  }

  if (slug.length > 63) {
    return NextResponse.json({ error: 'Slug must be 63 characters or fewer' }, { status: 400 });
  }

  const slugRegex = /^[a-z0-9-]+$/;
  if (!slugRegex.test(slug)) {
    return NextResponse.json(
      { error: 'Slug must contain only lowercase letters, numbers, and hyphens' },
      { status: 400 }
    );
  }

  // Check slug uniqueness
  const [existing] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, slug))
    .limit(1);

  if (existing) {
    return NextResponse.json({ error: 'Organization slug already taken' }, { status: 409 });
  }

  const orgId = createId();

  await db.transaction(async (tx) => {
    await tx.insert(organizations).values({
      id: orgId,
      name,
      slug,
      ownerId: user.id,
    });

    // Add owner as OWNER member
    await tx.insert(orgMembers).values({
      orgId,
      userId: user.id,
      role: 'OWNER',
      acceptedAt: new Date(),
    });
  });

  const [org] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      billingTier: organizations.billingTier,
      createdAt: organizations.createdAt,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  return Response.json(org, { status: 201 });
}
