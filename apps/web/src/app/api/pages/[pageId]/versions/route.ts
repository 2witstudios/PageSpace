import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { canUserViewPage, canUserEditPage } from '@pagespace/lib/server';
import { getPageVersions, restorePageVersion } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/socket-utils';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };

const restoreSchema = z.object({
  versionNumber: z.number().int().positive(),
});

/**
 * GET /api/pages/[pageId]/versions
 * Retrieve version history for a page
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  const { pageId } = await context.params;
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

    // Get query params for pagination
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50');

    // Fetch version history
    const versions = await getPageVersions(pageId, Math.min(limit, 100));

    return NextResponse.json({
      pageId,
      versions: versions.map(v => ({
        id: v.id,
        versionNumber: v.versionNumber,
        title: v.title,
        contentSize: v.contentSize,
        isAiGenerated: v.isAiGenerated,
        changeSummary: v.changeSummary,
        changeType: v.changeType,
        createdAt: v.createdAt,
        createdBy: v.createdByUser ? {
          id: v.createdByUser.id,
          name: v.createdByUser.name,
          image: v.createdByUser.image,
        } : null,
        auditEvent: v.auditEvent ? {
          actionType: v.auditEvent.actionType,
          description: v.auditEvent.description,
          reason: v.auditEvent.reason,
        } : null,
      })),
      total: versions.length,
    });
  } catch (error) {
    loggers.api.error('Error fetching page versions:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch version history' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/pages/[pageId]/versions
 * Restore a page to a previous version
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  const { pageId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;

  try {
    // Check edit permission
    const canEdit = await canUserEditPage(userId, pageId);
    if (!canEdit) {
      return NextResponse.json(
        { error: 'Permission denied', details: 'Edit permission required to restore versions' },
        { status: 403 }
      );
    }

    // Validate request body
    const body = await request.json();
    const { versionNumber } = restoreSchema.parse(body);

    // Restore the version
    const restoredPage = await restorePageVersion(pageId, versionNumber, userId);

    // Broadcast page update event
    if (restoredPage.driveId) {
      await broadcastPageEvent(
        {
          driveId: restoredPage.driveId,
          pageId: restoredPage.id,
          eventType: 'updated',
          socketId: request.headers.get('X-Socket-ID') || undefined,
          title: restoredPage.title,
          parentId: restoredPage.parentId,
        }
      );
    }

    loggers.api.info('Page version restored', {
      pageId,
      versionNumber,
      userId,
    });

    return NextResponse.json({
      success: true,
      message: `Page restored to version ${versionNumber}`,
      page: {
        id: restoredPage.id,
        title: restoredPage.title,
        content: restoredPage.content,
        updatedAt: restoredPage.updatedAt,
      },
    });
  } catch (error) {
    loggers.api.error('Error restoring page version:', error as Error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Validation failed', issues: error.issues },
        { status: 400 }
      );
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes('not found')) {
      return NextResponse.json(
        { error: errorMessage },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to restore version' },
      { status: 500 }
    );
  }
}
