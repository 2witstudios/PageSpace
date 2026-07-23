import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope, isScopedMCPAuth } from '@/lib/auth';
import { parseBoundedIntParam } from '@/lib/utils/query-params';
import { checkDriveAccessForSearch, globSearchPages } from '@pagespace/lib/services/drive-search-service'
import { hasAppDriveMembership, getAppDriveMembership, getAppAccessiblePagesInDrive } from '@pagespace/lib/permissions/app-permissions';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { drives } from '@pagespace/db/schema/core';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { parsePageTypesParam } from '@pagespace/lib/utils/enums';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const };

/**
 * GET /api/drives/[driveId]/search/glob
 * Find pages using glob-style patterns for titles and paths
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
    const includeTypesParam = searchParams.get('includeTypes');
    const maxResults = parseBoundedIntParam(searchParams.get('maxResults'), {
      defaultValue: 100,
      min: 1,
      max: 200,
    });

    if (!pattern) {
      return NextResponse.json(
        { error: 'Pattern parameter is required' },
        { status: 400 }
      );
    }

    // Parse includeTypes. Derived from the canonical PageType enum — a
    // hand-written list here had drifted and silently dropped FILE and
    // MACHINE (#2150).
    const includeTypes = parsePageTypesParam(includeTypesParam);

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

    // Perform glob search
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

    const searchResults = await globSearchPages(
      driveId,
      userId,
      pattern,
      drive.slug,
      {
        includeTypes: includeTypes?.length ? includeTypes : undefined,
        maxResults,
        authorizeView: tokenViewablePageIds
          ? async (pageId: string) => tokenViewablePageIds.has(pageId)
          : undefined,
      }
    );

    loggers.api.info('Glob search completed', {
      driveId,
      pattern,
      includeTypes,
      resultCount: searchResults.results.length,
      userId,
    });

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'drive_search', resourceId: driveId, details: { action: 'glob_search', resultCount: searchResults.results.length } });

    return NextResponse.json({
      success: true,
      ...searchResults,
    });
  } catch (error) {
    loggers.api.error('Error in glob search:', error as Error);
    return NextResponse.json(
      { error: 'Glob search failed' },
      { status: 500 }
    );
  }
}
