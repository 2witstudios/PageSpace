import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { withAdminAuth } from '@/lib/auth';
import { BETA_FEATURES } from '@pagespace/lib/services/beta-features';

type RouteContext = { params: Promise<{ userId: string }> };

const VALID_FEATURES = new Set<string>(Object.values(BETA_FEATURES));

/**
 * PATCH /api/admin/users/[userId]/beta-features
 * Grant or revoke a beta feature for a user.
 * Body: { feature: string, enabled: boolean }
 */
export const PATCH = withAdminAuth<RouteContext>(async (_adminUser, request, context) => {
  const { userId: targetUserId } = await context.params;
  const body = await request.json() as { feature?: string; enabled?: boolean };
  const { feature, enabled } = body;

  if (!feature || !VALID_FEATURES.has(feature)) {
    return NextResponse.json(
      { error: `Invalid feature. Must be one of: ${[...VALID_FEATURES].join(', ')}` },
      { status: 400 },
    );
  }

  if (typeof enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 400 });
  }

  const target = await db.query.users.findFirst({
    where: eq(users.id, targetUserId),
    columns: { id: true },
  });
  if (!target) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  if (enabled) {
    await db
      .update(users)
      .set({ betaFeatures: sql`array_append("betaFeatures", ${feature})` })
      .where(eq(users.id, targetUserId));
  } else {
    await db
      .update(users)
      .set({ betaFeatures: sql`array_remove("betaFeatures", ${feature})` })
      .where(eq(users.id, targetUserId));
  }

  const updated = await db.query.users.findFirst({
    where: eq(users.id, targetUserId),
    columns: { betaFeatures: true },
  });

  return NextResponse.json({ betaFeatures: updated?.betaFeatures ?? [] });
});
