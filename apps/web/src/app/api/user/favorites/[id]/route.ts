import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, favorites, eq, and } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const { id } = await context.params;

  try {
    const favorite = await db.query.favorites.findFirst({
      where: and(eq(favorites.id, id), eq(favorites.userId, userId)),
    });

    if (!favorite) {
      return NextResponse.json({ error: 'Favorite not found' }, { status: 404 });
    }

    await db.delete(favorites).where(and(eq(favorites.id, id), eq(favorites.userId, userId)));

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error deleting favorite:', error as Error);
    return NextResponse.json({ error: 'Failed to delete favorite' }, { status: 500 });
  }
}
