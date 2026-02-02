import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, userPageViews, eq, desc } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['session'] as const };

export type RecentPage = {
  id: string;
  title: string;
  type: string;
  driveId: string;
  driveName: string;
  viewedAt: string;
};

export async function GET(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const { searchParams } = new URL(req.url);
  const limitParam = searchParams.get('limit');
  const limit = Math.min(Math.max(parseInt(limitParam || '8', 10), 1), 50);

  try {
    const recentViews = await db.query.userPageViews.findMany({
      where: eq(userPageViews.userId, userId),
      orderBy: [desc(userPageViews.viewedAt)],
      limit: limit * 2, // Fetch extra in case some pages are trashed
      with: {
        page: {
          columns: {
            id: true,
            title: true,
            type: true,
            driveId: true,
            isTrashed: true,
          },
          with: {
            drive: {
              columns: {
                id: true,
                name: true,
                isTrashed: true,
              },
            },
          },
        },
      },
    });

    // Filter out trashed pages and drives, then limit
    const recents: RecentPage[] = recentViews
      .filter(view => {
        if (!view.page) return false;
        if (view.page.isTrashed) return false;
        if (!view.page.drive) return false;
        if (view.page.drive.isTrashed) return false;
        return true;
      })
      .slice(0, limit)
      .map(view => ({
        id: view.page!.id,
        title: view.page!.title,
        type: view.page!.type,
        driveId: view.page!.driveId,
        driveName: view.page!.drive!.name,
        viewedAt: view.viewedAt.toISOString(),
      }));

    return NextResponse.json({ recents });
  } catch (error) {
    loggers.api.error('Error fetching recent pages:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch recent pages' }, { status: 500 });
  }
}
