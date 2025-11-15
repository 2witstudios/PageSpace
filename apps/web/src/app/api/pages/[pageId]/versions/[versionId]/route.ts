import { NextResponse } from 'next/server';
import { canUserViewPage } from '@pagespace/lib/server';
import { db, pageVersions, eq } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };

/**
 * GET /api/pages/[pageId]/versions/[versionId]
 * Get a specific version of a page with full content for comparison
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ pageId: string; versionId: string }> }
) {
  const { pageId, versionId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    // Check view permission
    const canView = await canUserViewPage(userId, pageId);
    if (!canView) {
      return NextResponse.json(
        { error: 'Permission denied', details: 'View permission required' },
        { status: 403 }
      );
    }

    // Fetch the specific version
    const version = await db.query.pageVersions.findFirst({
      where: eq(pageVersions.id, versionId),
      with: {
        createdByUser: {
          columns: {
            id: true,
            name: true,
            image: true,
          },
        },
      },
    });

    if (!version) {
      return NextResponse.json(
        { error: 'Version not found' },
        { status: 404 }
      );
    }

    // Verify this version belongs to the requested page
    if (version.pageId !== pageId) {
      return NextResponse.json(
        { error: 'Version does not belong to this page' },
        { status: 400 }
      );
    }

    return NextResponse.json({
      id: version.id,
      versionNumber: version.versionNumber,
      title: version.title,
      content: version.content,
      contentSize: version.contentSize,
      isAiGenerated: version.isAiGenerated,
      changeSummary: version.changeSummary,
      changeType: version.changeType,
      createdAt: version.createdAt,
      createdBy: version.createdByUser ? {
        id: version.createdByUser.id,
        name: version.createdByUser.name,
        image: version.createdByUser.image,
      } : null,
    });
  } catch (error) {
    loggers.api.error('Error fetching page version:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch version' },
      { status: 500 }
    );
  }
}
