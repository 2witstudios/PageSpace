import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getBatchPagePermissions } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

/**
 * Batch Permission Check API
 *
 * POST /api/permissions/batch
 *
 * Efficiently check permissions for multiple pages at once,
 * eliminating N+1 query problems in search and bulk operations.
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
 *   stats: {
 *     total: number;
 *     accessible: number;
 *     cacheHits: number;
 *   }
 * }
 */
export async function POST(request: NextRequest) {
  try {
    // Verify authentication
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const body = await request.json();
    const { pageIds } = body;

    // Validate input
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

    // Validate that all pageIds are strings
    if (!pageIds.every(id => typeof id === 'string' && id.length > 0)) {
      return NextResponse.json(
        { error: 'All pageIds must be non-empty strings' },
        { status: 400 }
      );
    }

    const startTime = Date.now();

    // Get batch permissions using optimized function
    const permissionsMap = await getBatchPagePermissions(userId, pageIds);

    const endTime = Date.now();
    const duration = endTime - startTime;

    // Convert Map to object for JSON response
    const permissions: Record<string, {
      canView: boolean;
      canEdit: boolean;
      canShare: boolean;
      canDelete: boolean;
    }> = {};

    for (const [pageId, permission] of permissionsMap.entries()) {
      permissions[pageId] = permission;
    }

    const stats = {
      total: pageIds.length,
      accessible: permissionsMap.size,
      denied: pageIds.length - permissionsMap.size,
      processingTimeMs: duration
    };

    // Log performance metrics
    loggers.api.debug('Batch permission check completed', {
      userId,
      requestedPages: pageIds.length,
      accessiblePages: permissionsMap.size,
      processingTimeMs: duration,
      avgTimePerPage: Math.round(duration / pageIds.length * 100) / 100
    });

    // Log warning if request is slow
    if (duration > 500) {
      loggers.api.warn('Slow batch permission check', {
        userId,
        pageCount: pageIds.length,
        duration,
        stats
      });
    }

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

/**
 * GET /api/permissions/batch/stats
 *
 * Get cache performance statistics for monitoring
 */
export async function GET(request: NextRequest) {
  try {
    // Verify authentication
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;

    // Import cache stats function dynamically to avoid circular dependencies
    const { getPermissionCacheStats } = await import('@pagespace/lib/server');
    const stats = getPermissionCacheStats();

    return NextResponse.json({
      success: true,
      cache: stats,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    loggers.api.error('Error getting permission cache stats', error as Error);

    return NextResponse.json(
      {
        error: 'Failed to get cache statistics',
        message: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    );
  }
}