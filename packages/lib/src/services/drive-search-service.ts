/**
 * Drive Search Service
 *
 * This service encapsulates all database operations for drive search functionality.
 * Route handlers should call these service functions rather than accessing the database directly.
 */

import { db, pages, drives, eq, and, inArray, sql } from '@pagespace/db';
import { getUserAccessLevel, getUserDriveAccess } from '../permissions/permissions';

// ============================================================================
// Types
// ============================================================================

export interface DriveSearchInfo {
  hasAccess: boolean;
  drive: {
    id: string;
    slug: string | null;
    name: string;
  } | null;
}

export interface GlobSearchOptions {
  includeTypes?: Array<'FOLDER' | 'DOCUMENT' | 'AI_CHAT' | 'CHANNEL' | 'CANVAS' | 'SHEET'>;
  maxResults?: number;
}

export interface GlobSearchResult {
  pageId: string;
  title: string;
  type: string;
  semanticPath: string;
  matchedOn: 'path' | 'title';
}

export interface GlobSearchResponse {
  driveSlug: string | null;
  pattern: string;
  results: GlobSearchResult[];
  totalResults: number;
  summary: string;
  stats: {
    totalPagesScanned: number;
    matchingPages: number;
    documentTypes: string[];
    matchTypes: {
      path: number;
      title: number;
    };
  };
  nextSteps: string[];
}

export interface RegexSearchOptions {
  searchIn?: 'content' | 'title' | 'both';
  maxResults?: number;
}

export interface RegexSearchResult {
  pageId: string;
  title: string;
  type: string;
  semanticPath: string;
  matchingLines: Array<{ lineNumber: number; content: string }>;
  totalMatches: number;
}

export interface RegexSearchResponse {
  driveSlug: string | null;
  pattern: string;
  searchIn: string;
  results: RegexSearchResult[];
  totalResults: number;
  summary: string;
  stats: {
    pagesScanned: number;
    pagesWithAccess: number;
    documentTypes: string[];
  };
  nextSteps: string[];
}

// ============================================================================
// Service Functions
// ============================================================================

/**
 * Check if user has access to a drive and get drive info for search
 */
export async function checkDriveAccessForSearch(
  driveId: string,
  userId: string
): Promise<DriveSearchInfo> {
  // Check drive access
  const hasAccess = await getUserDriveAccess(userId, driveId);

  if (!hasAccess) {
    return { hasAccess: false, drive: null };
  }

  // Get drive info
  const [drive] = await db
    .select({ id: drives.id, slug: drives.slug, name: drives.name })
    .from(drives)
    .where(eq(drives.id, driveId));

  if (!drive) {
    return { hasAccess: true, drive: null };
  }

  return {
    hasAccess: true,
    drive: {
      id: drive.id,
      slug: drive.slug,
      name: drive.name,
    },
  };
}

/**
 * Convert glob pattern to regex
 */
function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars except * and ?
    .replace(/\*/g, '.*') // * matches any characters
    .replace(/\?/g, '.'); // ? matches single character
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Perform glob search on pages in a drive
 */
export async function globSearchPages(
  driveId: string,
  userId: string,
  pattern: string,
  driveSlug: string | null,
  options: GlobSearchOptions = {}
): Promise<GlobSearchResponse> {
  const { includeTypes, maxResults = 100 } = options;
  const effectiveMaxResults = Math.min(maxResults, 200);

  // Build where conditions
  const whereConditions =
    includeTypes && includeTypes.length > 0
      ? and(eq(pages.driveId, driveId), eq(pages.isTrashed, false), inArray(pages.type, includeTypes))
      : and(eq(pages.driveId, driveId), eq(pages.isTrashed, false));

  // Get all pages in drive
  const allPages = await db
    .select({
      id: pages.id,
      title: pages.title,
      type: pages.type,
      parentId: pages.parentId,
      position: pages.position,
    })
    .from(pages)
    .where(whereConditions);

  // Build page hierarchy with paths
  const pageMap = new Map<string, (typeof allPages)[0]>();
  const results: GlobSearchResult[] = [];

  // First pass: build page map
  for (const page of allPages) {
    pageMap.set(page.id, page);
  }

  const pathRegex = globToRegex(pattern);

  // Second pass: build paths and check pattern
  for (const page of allPages) {
    // Check permissions
    const accessLevel = await getUserAccessLevel(userId, page.id);
    if (!accessLevel?.canView) continue;

    // Build full path
    const pathParts: string[] = [];
    let currentPage: (typeof allPages)[0] | undefined = page;

    while (currentPage) {
      pathParts.unshift(currentPage.title);
      if (currentPage.parentId) {
        currentPage = pageMap.get(currentPage.parentId);
      } else {
        break;
      }
    }

    const fullPath = pathParts.join('/');
    const semanticPath = `/${driveSlug || driveId}/${fullPath}`;

    // Check if path matches pattern
    if (pathRegex.test(fullPath) || pathRegex.test(page.title)) {
      results.push({
        pageId: page.id,
        title: page.title,
        type: page.type,
        semanticPath,
        matchedOn: pathRegex.test(fullPath) ? 'path' : 'title',
      });

      if (results.length >= effectiveMaxResults) break;
    }
  }

  // Sort results by path for better organization
  results.sort((a, b) => a.semanticPath.localeCompare(b.semanticPath));

  return {
    driveSlug,
    pattern,
    results,
    totalResults: results.length,
    summary: `Found ${results.length} page${results.length === 1 ? '' : 's'} matching pattern "${pattern}"`,
    stats: {
      totalPagesScanned: allPages.length,
      matchingPages: results.length,
      documentTypes: [...new Set(results.map((r) => r.type))],
      matchTypes: {
        path: results.filter((r) => r.matchedOn === 'path').length,
        title: results.filter((r) => r.matchedOn === 'title').length,
      },
    },
    nextSteps:
      results.length > 0
        ? [
            'Use read_page with the pageId to examine content',
            'Use the semantic paths to understand the structure',
            'Consider using regex_search for content-based searching',
          ]
        : [
            'Try a broader pattern (e.g., "**/*" for all pages)',
            'Check if your pattern syntax is correct',
            'Verify the pages exist with list_pages',
          ],
  };
}

/**
 * Perform regex search on pages in a drive
 */
export async function regexSearchPages(
  driveId: string,
  userId: string,
  pattern: string,
  driveSlug: string | null,
  options: RegexSearchOptions = {}
): Promise<RegexSearchResponse> {
  const { searchIn = 'content', maxResults = 50 } = options;
  const effectiveMaxResults = Math.min(maxResults, 100);

  // Validate and limit pattern length to prevent ReDoS
  if (pattern.length > 500) {
    return {
      driveSlug,
      pattern,
      searchIn,
      results: [],
      totalResults: 0,
      summary: 'Pattern too long (max 500 characters)',
      stats: { pagesScanned: 0, pagesWithAccess: 0, documentTypes: [] },
      nextSteps: ['Shorten your regex pattern to under 500 characters'],
    };
  }

  // Create regex for PostgreSQL - escape backslashes but preserve regex shortcuts
  const pgPattern = pattern.replace(/\\(?![dDwWsSbBntrvfAZzGQE])/g, '\\\\');

  // Build where conditions based on searchIn parameter
  let whereConditions;
  if (searchIn === 'content') {
    whereConditions = and(
      eq(pages.driveId, driveId),
      eq(pages.isTrashed, false),
      sql`${pages.content} ~ ${pgPattern}`
    );
  } else if (searchIn === 'title') {
    whereConditions = and(
      eq(pages.driveId, driveId),
      eq(pages.isTrashed, false),
      sql`${pages.title} ~ ${pgPattern}`
    );
  } else {
    whereConditions = and(
      eq(pages.driveId, driveId),
      eq(pages.isTrashed, false),
      sql`${pages.content} ~ ${pgPattern} OR ${pages.title} ~ ${pgPattern}`
    );
  }

  // Build and execute query
  const matchingPages = await db
    .select({
      id: pages.id,
      title: pages.title,
      type: pages.type,
      parentId: pages.parentId,
      content: pages.content,
    })
    .from(pages)
    .where(whereConditions)
    .limit(effectiveMaxResults);

  // Use original pattern for line-level matching — consistent with PG regex semantics.
  // Pattern is length-checked (≤500 chars) and applied per-line (not concatenated).
  let lineRegex: RegExp | null = null;
  try {
    lineRegex = new RegExp(pattern, 'gi');
  } catch {
    // PG regex syntax may differ from JS — skip line extraction
  }

  // Filter by permissions and build results
  const results: RegexSearchResult[] = [];
  for (const page of matchingPages) {
    const accessLevel = await getUserAccessLevel(userId, page.id);
    if (!accessLevel?.canView) continue;

    // Build semantic path
    const pathParts = [driveSlug || driveId];
    let currentPage: typeof page | null = page;
    const parentChain: string[] = [];

    // Build parent chain
    while (currentPage?.parentId) {
      const [parent] = await db
        .select({
          id: pages.id,
          title: pages.title,
          parentId: pages.parentId,
          type: pages.type,
          content: pages.content,
        })
        .from(pages)
        .where(eq(pages.id, currentPage.parentId));

      if (parent) {
        parentChain.unshift(parent.title);
        currentPage = parent;
      } else {
        break;
      }
    }

    const semanticPath = `/${[...pathParts, ...parentChain, page.title].join('/')}`;

    // Extract matching lines if searching content
    const matchingLines: Array<{ lineNumber: number; content: string }> = [];
    if (searchIn !== 'title' && lineRegex) {
      const lines = page.content.split('\n');
      lines.forEach((line, index) => {
        // Reset lastIndex for global regex on each line
        lineRegex!.lastIndex = 0;
        if (lineRegex!.test(line)) {
          matchingLines.push({
            lineNumber: index + 1,
            content: line.substring(0, 200), // Truncate long lines
          });
        }
      });
    }

    results.push({
      pageId: page.id,
      title: page.title,
      type: page.type,
      semanticPath,
      matchingLines: matchingLines.slice(0, 5), // Limit to first 5 matches
      totalMatches: matchingLines.length,
    });
  }

  return {
    driveSlug,
    pattern,
    searchIn,
    results,
    totalResults: results.length,
    summary: `Found ${results.length} page${results.length === 1 ? '' : 's'} matching pattern "${pattern}"`,
    stats: {
      pagesScanned: matchingPages.length,
      pagesWithAccess: results.length,
      documentTypes: [...new Set(results.map((r) => r.type))],
    },
    nextSteps:
      results.length > 0
        ? [
            'Use read_page with the pageId to examine full content',
            'Use edit tools to modify matching pages',
            'Refine your regex pattern for more specific results',
          ]
        : [
            'Try a different pattern or search in a different location',
            'Check if the pattern syntax is correct for PostgreSQL regex',
          ],
  };
}
