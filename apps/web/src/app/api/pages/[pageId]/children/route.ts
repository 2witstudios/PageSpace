import { NextResponse } from 'next/server';
import { pages, db, and, eq, asc } from '@pagespace/db';
import { canUserViewPage, loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { jsonResponse } from '@pagespace/lib/api-utils';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: false } as const;

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
    return jsonResponse(children);
  } catch (error) {
    loggers.api.error(`Error fetching children for page ${pageId}:`, error as Error);
    return NextResponse.json({ error: 'Failed to fetch page children' }, { status: 500 });
  }
}