import { NextResponse } from 'next/server';
import { parseBoundedIntParam } from '@/lib/utils/query-params';
import { checkDriveAccessForSearch, regexSearchPages } from '@pagespace/lib/services/drive-search-service'
import { hasAppDriveMembership, getAppDriveMembership, getAppAccessiblePagesInDrive } from '@pagespace/lib/permissions/app-permissions';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError, checkMCPDriveScope } from '@/lib/auth/auth-core';
import { isScopedMCPAuth } from '@/lib/auth/principal-permissions';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const };

/**
 * GET /api/drives/[driveId]/search/regex
 * Search page content using regular expression patterns
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const { driveId } = await context.params;

    // Check MCP token scope before drive access
    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    const { searchParams } = new URL(request.url);
    const pattern = searchParams.get('pattern');
    const searchIn = (searchParams.get('searchIn') || 'content') as 'content' | 'title' | 'both';
    const maxResults = parseBoundedIntParam(searchParams.get('maxResults'), {
      defaultValue: 50,
      min: 1,
      max: 100,
    });

    if (!pattern) {
      return NextResponse.json(
        { error: 'Pattern parameter is required' },
        { status: 400 }
      );
    }

    // Check drive access. A scoped MCP token is its own drive member — gate on
    // the TOKEN's membership, not the owning user's.
    let drive: { id: string; slug: string | null; name: string } | null;
    if (isScopedMCPAuth(auth)) {
      // Membership gate only — results below are filtered per page by the
      // TOKEN's own access, so per-page custom-role grants still work.
      if (!(await hasAppDriveMembership(auth.tokenId, driveId))) {
        return NextResponse.json(
          { error: "You don't have access to this drive" },
          { status: 403 }
        );
      }
      const [row] = await db
        .select({ id: drives.id, slug: drives.slug, name: drives.name })
        .from(drives)
        .where(eq(drives.id, driveId));
      drive = row ?? null;
    } else {
      const accessInfo = await checkDriveAccessForSearch(driveId, userId);

      if (!accessInfo.hasAccess) {
        return NextResponse.json(
          { error: "You don't have access to this drive" },
          { status: 403 }
        );
      }

      drive = accessInfo.drive;
    }

    if (!drive) {
      return NextResponse.json(
        { error: 'Drive not found' },
        { status: 404 }
      );
    }

    // Perform regex search
    // Explicit-role tokens: filter results by the TOKEN's accessible page set.
    // Inherited keys (role null) act as their owner, so the service's default
    // user filter is already correct for them.
    let tokenViewablePageIds: Set<string> | null = null;
    if (isScopedMCPAuth(auth)) {
      const explicitMembership = await getAppDriveMembership(auth.tokenId, driveId);
      if (explicitMembership && explicitMembership.role !== null) {
        tokenViewablePageIds = new Set(
          (await getAppAccessiblePagesInDrive(auth.tokenId, driveId))
            .filter((p) => p.permissions.canView)
            .map((p) => p.id),
        );
      }
    }

    const searchResults = await regexSearchPages(
      driveId,
      userId,
      pattern,
      drive.slug,
      {
        searchIn,
        maxResults,
        authorizeView: tokenViewablePageIds
          ? async (pageId: string) => tokenViewablePageIds.has(pageId)
          : undefined,
      }
    );

    loggers.api.info('Regex search completed', {
      driveId,
      pattern,
      searchIn,
      resultCount: searchResults.results.length,
      userId,
    });

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'drive_search', resourceId: driveId, details: { action: 'regex_search', resultCount: searchResults.results.length } });

    return NextResponse.json({
      success: true,
      ...searchResults,
    });
  } catch (error) {
    loggers.api.error('Error in regex search:', error as Error);
    return NextResponse.json(
      { error: 'Regex search failed' },
      { status: 500 }
    );
  }
}
