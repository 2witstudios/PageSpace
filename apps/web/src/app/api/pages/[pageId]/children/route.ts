import { NextResponse } from 'next/server';
import { pages, taskItems, db, and, eq, asc, isNotNull } from '@pagespace/db';
import { canUserViewPage, loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { jsonResponse } from '@pagespace/lib/api-utils';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false } as const;

export async function GET(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;

  // Support both Bearer tokens (desktop) and cookies (web)
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const canView = await canUserViewPage(auth.userId, pageId);
  if (!canView) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  try {
    const children = await db.query.pages.findMany({
      where: and(
        eq(pages.parentId, pageId),
        eq(pages.isTrashed, false)
      ),
      orderBy: [asc(pages.position)],
    });

    // Get task-linked page IDs to mark them
    const taskLinkedPageIds = await db.selectDistinct({ pageId: taskItems.pageId })
      .from(taskItems)
      .where(isNotNull(taskItems.pageId));
    const taskLinkedSet = new Set(taskLinkedPageIds.map(t => t.pageId));

    // Add isTaskLinked flag to each child
    const childrenWithTaskInfo = children.map(child => ({
      ...child,
      isTaskLinked: taskLinkedSet.has(child.id),
    }));

    return jsonResponse(childrenWithTaskInfo);
  } catch (error) {
    loggers.api.error(`Error fetching children for page ${pageId}:`, error as Error);
    return NextResponse.json({ error: 'Failed to fetch page children' }, { status: 500 });
  }
}