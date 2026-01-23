import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  checkDriveAccessForSearch,
  globSearchPages,
  loggers,
} from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const };

const VALID_PAGE_TYPES = ['FOLDER', 'DOCUMENT', 'AI_CHAT', 'CHANNEL', 'CANVAS', 'SHEET'] as const;
type PageType = (typeof VALID_PAGE_TYPES)[number];

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
    const { searchParams } = new URL(request.url);
    const pattern = searchParams.get('pattern');
    const includeTypesParam = searchParams.get('includeTypes');
    const maxResults = Math.min(parseInt(searchParams.get('maxResults') || '100'), 200);

    if (!pattern) {
      return NextResponse.json(
        { error: 'Pattern parameter is required' },
        { status: 400 }
      );
    }

    // Parse includeTypes
    const includeTypes = includeTypesParam
      ? (includeTypesParam
          .split(',')
          .filter((t): t is PageType => VALID_PAGE_TYPES.includes(t as PageType)))
      : undefined;

    // Check drive access
    const accessInfo = await checkDriveAccessForSearch(driveId, userId);

    if (!accessInfo.hasAccess) {
      return NextResponse.json(
        { error: "You don't have access to this drive" },
        { status: 403 }
      );
    }

    if (!accessInfo.drive) {
      return NextResponse.json(
        { error: 'Drive not found' },
        { status: 404 }
      );
    }

    // Perform glob search
    const searchResults = await globSearchPages(
      driveId,
      userId,
      pattern,
      accessInfo.drive.slug,
      {
        includeTypes: includeTypes?.length ? includeTypes : undefined,
        maxResults,
      }
    );

    loggers.api.info('Glob search completed', {
      driveId,
      pattern,
      includeTypes,
      resultCount: searchResults.results.length,
      userId,
    });

    return NextResponse.json({
      success: true,
      ...searchResults,
    });
  } catch (error) {
    loggers.api.error('Error in glob search:', error as Error);
    return NextResponse.json(
      { error: `Glob search failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}
