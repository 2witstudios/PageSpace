import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, favorites, pages, drives, eq, and, desc, asc } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };
const AUTH_OPTIONS_READ = { allow: ['session'] as const };

export type FavoriteItem = {
  id: string;
  itemType: 'page' | 'drive';
  position: number;
  createdAt: string;
  page?: {
    id: string;
    title: string;
    type: string;
    driveId: string;
    driveName: string;
  };
  drive?: {
    id: string;
    name: string;
  };
};

export async function GET(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  try {
    const userFavorites = await db.query.favorites.findMany({
      where: eq(favorites.userId, userId),
      orderBy: [asc(favorites.position), desc(favorites.createdAt)],
      with: {
        page: {
          columns: {
            id: true,
            title: true,
            type: true,
            driveId: true,
          },
          with: {
            drive: {
              columns: {
                id: true,
                name: true,
              },
            },
          },
        },
        drive: {
          columns: {
            id: true,
            name: true,
          },
        },
      },
    });

    const items: FavoriteItem[] = userFavorites
      .filter(fav => {
        // Filter out favorites where the referenced item no longer exists
        if (fav.itemType === 'page' && !fav.page) return false;
        if (fav.itemType === 'drive' && !fav.drive) return false;
        return true;
      })
      .map(fav => ({
        id: fav.id,
        itemType: fav.itemType,
        position: fav.position,
        createdAt: fav.createdAt.toISOString(),
        ...(fav.itemType === 'page' && fav.page
          ? {
              page: {
                id: fav.page.id,
                title: fav.page.title,
                type: fav.page.type,
                driveId: fav.page.driveId,
                driveName: fav.page.drive?.name ?? '',
              },
            }
          : {}),
        ...(fav.itemType === 'drive' && fav.drive
          ? {
              drive: {
                id: fav.drive.id,
                name: fav.drive.name,
              },
            }
          : {}),
      }));

    return NextResponse.json({ favorites: items });
  } catch (error) {
    loggers.api.error('Error fetching favorites:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch favorites' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  try {
    const body = await req.json();
    const { itemType, itemId } = body as { itemType: 'page' | 'drive'; itemId: string };

    if (!itemType || !itemId) {
      return NextResponse.json({ error: 'itemType and itemId are required' }, { status: 400 });
    }

    if (itemType !== 'page' && itemType !== 'drive') {
      return NextResponse.json({ error: 'itemType must be "page" or "drive"' }, { status: 400 });
    }

    // Check if already favorited
    const existing = await db.query.favorites.findFirst({
      where: and(
        eq(favorites.userId, userId),
        itemType === 'page' ? eq(favorites.pageId, itemId) : eq(favorites.driveId, itemId)
      ),
    });

    if (existing) {
      return NextResponse.json({ error: 'Already favorited' }, { status: 409 });
    }

    // Get max position for ordering
    const maxPositionResult = await db.query.favorites.findFirst({
      where: eq(favorites.userId, userId),
      orderBy: desc(favorites.position),
      columns: { position: true },
    });
    const nextPosition = (maxPositionResult?.position ?? -1) + 1;

    // Verify the item exists
    if (itemType === 'page') {
      const page = await db.query.pages.findFirst({
        where: eq(pages.id, itemId),
        columns: { id: true },
      });
      if (!page) {
        return NextResponse.json({ error: 'Page not found' }, { status: 404 });
      }
    } else {
      const drive = await db.query.drives.findFirst({
        where: eq(drives.id, itemId),
        columns: { id: true },
      });
      if (!drive) {
        return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
      }
    }

    const [newFavorite] = await db
      .insert(favorites)
      .values({
        userId,
        itemType,
        pageId: itemType === 'page' ? itemId : null,
        driveId: itemType === 'drive' ? itemId : null,
        position: nextPosition,
      })
      .returning();

    return NextResponse.json({ favorite: newFavorite }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error adding favorite:', error as Error);
    return NextResponse.json({ error: 'Failed to add favorite' }, { status: 500 });
  }
}
