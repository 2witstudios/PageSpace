import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getBatchPagePermissions } from '@pagespace/lib/permissions/permissions';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';

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
 *   pageIds: string[]  // Array of page IDs to check (1..100)
 * }
 *
 * Response shape (consistent across empty and non-empty input):
 * {
 *   permissions: {
 *     // Only pages where canView === true are included. Pages the user
 *     // cannot view are omitted from this map — the library-level
 *     // getBatchPagePermissions returns every input pageId with all-false
 *     // permissions, and this route filters those out. Callers therefore
 *     // do NOT need to re-check canView on entries that appear here.
 *     [pageId: string]: {
 *       canView: true;            // always true for entries that appear
 *       canEdit: boolean;
 *       canShare: boolean;
 *       canDelete: boolean;
 *     }
 *   },
 *   stats: {
 *     total: number;             // pageIds.length
 *     accessible: number;        // count where canView === true
 *     denied: number;            // total - accessible (omitted from permissions map)
 *     processingTimeMs: number;  // 0 for the empty-input early return
 *   }
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
        stats: { total: 0, accessible: 0, denied: 0, processingTimeMs: 0 }
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
