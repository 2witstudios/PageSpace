import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope } from '@/lib/auth';
import {
  checkDriveAccessForSearch,
  regexSearchPages,
  loggers,
} from '@pagespace/lib/server';

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
    const maxResults = Math.min(parseInt(searchParams.get('maxResults') || '50'), 100);

    if (!pattern) {
      return NextResponse.json(
        { error: 'Pattern parameter is required' },
        { status: 400 }
      );
    }

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

    // Perform regex search
    const searchResults = await regexSearchPages(
      driveId,
      userId,
      pattern,
      accessInfo.drive.slug,
      {
        searchIn,
        maxResults,
      }
    );

    loggers.api.info('Regex search completed', {
      driveId,
      pattern,
      searchIn,
      resultCount: searchResults.results.length,
      userId,
    });

    return NextResponse.json({
      success: true,
      ...searchResults,
    });
  } catch (error) {
    loggers.api.error('Error in regex search:', error as Error);
    return NextResponse.json(
      { error: `Regex search failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}
