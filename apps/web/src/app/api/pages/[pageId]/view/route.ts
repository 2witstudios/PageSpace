import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { userPageViews } from '@pagespace/db/schema/page-views';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { jsonResponse } from '@pagespace/lib/utils/api-utils';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

// POST /api/pages/[pageId]/view - Record that the user has viewed this page
export async function POST(
  req: Request,
  { params }: { params: Promise<{ pageId: string }> }
) {
  const { pageId } = await params;
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    // Verify the page exists
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      columns: { id: true, driveId: true },
    });

    if (!page) {
      return NextResponse.json({ error: 'Page not found' }, { status: 404 });
    }

    // Verify user has permission to view this page
    const canView = await canUserViewPage(userId, pageId);
    if (!canView) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Upsert the page view record
    await db
      .insert(userPageViews)
      .values({
        userId,
        pageId,
        viewedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [userPageViews.userId, userPageViews.pageId],
        set: {
          viewedAt: new Date(),
        },
      });

    auditRequest(req, { eventType: 'data.write', userId, resourceType: 'page_view', resourceId: pageId, details: { action: 'record_page_view' } });

    return jsonResponse({ success: true });
  } catch (error) {
    loggers.api.error('Error recording page view:', error as Error);
    return NextResponse.json({ error: 'Failed to record page view' }, { status: 500 });
  }
}
