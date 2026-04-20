import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getBatchPagePermissions } from '@pagespace/lib/server';
import { loggers, auditRequest } from '@pagespace/lib/server';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

/**
 * Batch Permission Check API
 *
 * POST /api/permissions/batch
 *
 * Efficiently check permissions for multiple pages at once, eliminating N+1
 * query problems in search and bulk operations.
 *
 * Request body:
 * {
 *   pageIds: string[]  // Array of page IDs to check
 * }
 *
 * Response:
 * {
 *   permissions: {
 *     [pageId: string]: {
 *       canView: boolean;
 *       canEdit: boolean;
 *       canShare: boolean;
 *       canDelete: boolean;
 *     }
 *   },
 *   stats: { total, accessible, denied, processingTimeMs }
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const body = await request.json();
    const { pageIds } = body;

    if (!Array.isArray(pageIds)) {
      return NextResponse.json(
        { error: 'pageIds must be an array' },
        { status: 400 }
      );
    }

    if (pageIds.length === 0) {
      return NextResponse.json({
        permissions: {},
        stats: { total: 0, accessible: 0, cacheHits: 0 }
      });
    }

    if (pageIds.length > 100) {
      return NextResponse.json(
        { error: 'Maximum 100 page IDs allowed per request' },
        { status: 400 }
      );
    }

    if (!pageIds.every(id => typeof id === 'string' && id.length > 0)) {
      return NextResponse.json(
        { error: 'All pageIds must be non-empty strings' },
        { status: 400 }
      );
    }

    const startTime = Date.now();

    const permissionsMap = await getBatchPagePermissions(userId, pageIds);

    const endTime = Date.now();
    const duration = endTime - startTime;

    const permissions: Record<string, {
      canView: boolean;
      canEdit: boolean;
      canShare: boolean;
      canDelete: boolean;
    }> = {};

    let accessibleCount = 0;
    for (const [pageId, permission] of permissionsMap.entries()) {
      if (permission.canView) {
        permissions[pageId] = permission;
        accessibleCount++;
      }
    }

    const stats = {
      total: pageIds.length,
      accessible: accessibleCount,
      denied: pageIds.length - accessibleCount,
      processingTimeMs: duration
    };

    loggers.api.debug('Batch permission check completed', {
      userId,
      requestedPages: pageIds.length,
      accessiblePages: accessibleCount,
      processingTimeMs: duration,
      avgTimePerPage: Math.round(duration / pageIds.length * 100) / 100
    });

    if (duration > 500) {
      loggers.api.warn('Slow batch permission check', {
        userId,
        pageCount: pageIds.length,
        duration,
        stats
      });
    }

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'permissions', resourceId: '*', details: { source: 'batch', pageCount: pageIds.length, accessibleCount } });

    return NextResponse.json({
      success: true,
      permissions,
      stats
    });

  } catch (error) {
    loggers.api.error('Error in batch permission check', error as Error);

    return NextResponse.json(
      {
        error: 'Failed to check permissions',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}
