import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db'
import { eq, and, desc } from '@pagespace/db/operators'
import { userPageViews } from '@pagespace/db/schema/page-views';
import { pages, drives } from '@pagespace/db/schema/core';
import { PageType } from '@pagespace/lib/utils/enums';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const AUTH_OPTIONS = { allow: ['session'] as const };

export type RecentPage = {
  id: string;
  title: string;
  type: PageType;
  driveId: string;
  driveName: string;
  viewedAt: string;
};

function toPageType(type: string): PageType | null {
  switch (type) {
    case 'FOLDER':
      return PageType.FOLDER;
    case 'DOCUMENT':
      return PageType.DOCUMENT;
    case 'CHANNEL':
      return PageType.CHANNEL;
    case 'AI_CHAT':
      return PageType.AI_CHAT;
    case 'CANVAS':
      return PageType.CANVAS;
    case 'FILE':
      return PageType.FILE;
    case 'SHEET':
      return PageType.SHEET;
    case 'TASK_LIST':
      return PageType.TASK_LIST;
    case 'CODE':
      return PageType.CODE;
    default:
      return null;
  }
}

export async function GET(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  auditRequest(req, { eventType: 'data.read', userId, resourceType: 'recents', resourceId: 'self' });

  const { searchParams } = new URL(req.url);
  const limitParam = searchParams.get('limit');
  const parsedLimit = Number.parseInt(limitParam ?? '8', 10);
  const safeLimit = Number.isNaN(parsedLimit) ? 8 : parsedLimit;
  const limit = Math.min(Math.max(safeLimit, 1), 50);
  // Optional drive scope. Filtering server-side prevents under-filling: a
  // user active across many drives would otherwise see only the handful of
  // this drive's pages that happen to fall in the global most-recent window.
  const driveId = searchParams.get('driveId') ?? undefined;

  try {
    let recents: RecentPage[];

    if (driveId) {
      const rows = await db
        .select({
          id: pages.id,
          title: pages.title,
          type: pages.type,
          driveId: pages.driveId,
          driveName: drives.name,
          viewedAt: userPageViews.viewedAt,
        })
        .from(userPageViews)
        .innerJoin(pages, eq(userPageViews.pageId, pages.id))
        .innerJoin(drives, eq(pages.driveId, drives.id))
        .where(
          and(
            eq(userPageViews.userId, userId),
            eq(pages.driveId, driveId),
            eq(pages.isTrashed, false),
            eq(drives.isTrashed, false),
          )
        )
        .orderBy(desc(userPageViews.viewedAt))
        .limit(limit * 2);

      recents = rows
        .filter(row => toPageType(row.type) !== null)
        .slice(0, limit)
        .map(row => ({
          id: row.id,
          title: row.title,
          type: toPageType(row.type)!,
          driveId: row.driveId,
          driveName: row.driveName,
          viewedAt: row.viewedAt.toISOString(),
        }));
    } else {
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
      recents = recentViews
        .filter(view => {
          if (!view.page) return false;
          if (view.page.isTrashed) return false;
          if (!view.page.drive) return false;
          if (view.page.drive.isTrashed) return false;
          if (!toPageType(view.page.type)) return false;
          return true;
        })
        .slice(0, limit)
        .map(view => ({
          id: view.page!.id,
          title: view.page!.title,
          type: toPageType(view.page!.type)!,
          driveId: view.page!.driveId,
          driveName: view.page!.drive!.name,
          viewedAt: view.viewedAt.toISOString(),
        }));
    }

    auditRequest(req, { eventType: 'data.read', userId: auth.userId, resourceType: 'recent', resourceId: 'self' });

    return NextResponse.json({ recents });
  } catch (error) {
    loggers.api.error('Error fetching recent pages:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch recent pages' }, { status: 500 });
  }
}
