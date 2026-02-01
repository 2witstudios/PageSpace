import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, favorites, eq, and, inArray } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

export async function PATCH(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  try {
    const body = await req.json();
    const { orderedIds } = body as { orderedIds: string[] };

    if (!Array.isArray(orderedIds)) {
      return NextResponse.json({ error: 'orderedIds must be an array' }, { status: 400 });
    }

    // Verify all favorites belong to this user
    const userFavorites = await db.query.favorites.findMany({
      where: and(eq(favorites.userId, userId), inArray(favorites.id, orderedIds)),
      columns: { id: true },
    });

    const userFavoriteIds = new Set(userFavorites.map(f => f.id));
    const invalidIds = orderedIds.filter(id => !userFavoriteIds.has(id));

    if (invalidIds.length > 0) {
      return NextResponse.json({ error: 'Some favorite IDs do not belong to this user' }, { status: 403 });
    }

    // Update positions in a transaction
    await db.transaction(async tx => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx
          .update(favorites)
          .set({ position: i })
          .where(and(eq(favorites.id, orderedIds[i]), eq(favorites.userId, userId)));
      }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error reordering favorites:', error as Error);
    return NextResponse.json({ error: 'Failed to reorder favorites' }, { status: 500 });
  }
}
