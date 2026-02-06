import { NextResponse } from 'next/server';
import { getUserAccessLevel, getUserDriveAccess, getDriveIdsForUser, loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { pages, users, db, and, eq, ilike, drives, inArray, desc, SQL } from '@pagespace/db';
import { MentionSuggestion, MentionType } from '@/types/mentions';
import { z } from 'zod';

/**
 * Escape LIKE pattern metacharacters (%, _) in user input
 * Prevents user input from being interpreted as wildcards
 */
function escapeLikePattern(input: string): string {
  return input
    .replace(/\\/g, '\\\\')  // Escape backslashes first
    .replace(/%/g, '\\%')    // Escape percent
    .replace(/_/g, '\\_');   // Escape underscore
}

/**
 * Build a multi-word search condition
 * All words must be present in the title (in any order)
 * e.g., "alpha budget" matches "Project Alpha Budget"
 */
function buildMultiWordSearchCondition(query: string): SQL | undefined {
  if (!query.trim()) return undefined;

  // Split by whitespace and filter empty strings
  const words = query.trim().split(/\s+/).filter(Boolean);

  if (words.length === 0) return undefined;

  // Each word must be present in the title (escaped to prevent LIKE injection)
  const conditions = words.map(word => ilike(pages.title, `%${escapeLikePattern(word)}%`));

  return conditions.length === 1 ? conditions[0] : and(...conditions);
}

/**
 * Calculate relevance score for sorting
 * Higher score = more relevant
 */
function calculateRelevanceScore(title: string, query: string): number {
  const lowerTitle = title.toLowerCase();
  const lowerQuery = query.toLowerCase().trim();

  if (!lowerQuery) return 0;

  const queryWords = lowerQuery.split(/\s+/).filter(Boolean);
  const titleWords = lowerTitle.split(/\s+/);

  let score = 0;

  // Exact match (highest priority)
  if (lowerTitle === lowerQuery) {
    score += 1000;
  }

  // Title starts with full query string (strong signal)
  if (lowerTitle.startsWith(lowerQuery)) {
    score += 500;
  }

  // Title contains full query as contiguous substring
  if (lowerTitle.includes(lowerQuery)) {
    score += 200;
  }

  // Word-level matching
  let wordStartMatches = 0;
  let substringMatches = 0;
  let exactWordMatches = 0;

  for (const queryWord of queryWords) {
    let bestMatchForThisWord = 0;
    for (const titleWord of titleWords) {
      if (titleWord === queryWord) {
        // Exact word match
        bestMatchForThisWord = Math.max(bestMatchForThisWord, 3);
      } else if (titleWord.startsWith(queryWord)) {
        // Word-start prefix match (e.g., "proj" matches "project")
        bestMatchForThisWord = Math.max(bestMatchForThisWord, 2);
      } else if (titleWord.includes(queryWord)) {
        // Substring match within a word
        bestMatchForThisWord = Math.max(bestMatchForThisWord, 1);
      }
    }
    if (bestMatchForThisWord === 3) exactWordMatches++;
    else if (bestMatchForThisWord === 2) wordStartMatches++;
    else if (bestMatchForThisWord === 1) substringMatches++;
  }

  score += exactWordMatches * 150;
  score += wordStartMatches * 100;
  score += substringMatches * 30;

  // Bonus when ALL query words match at word boundaries (strong multi-word match)
  if (queryWords.length > 1 && (exactWordMatches + wordStartMatches) === queryWords.length) {
    score += 300;
  }

  // Bonus for consecutive word matches in order (e.g., "project alpha" matches title "Project Alpha Budget")
  if (queryWords.length > 1) {
    const titleJoined = titleWords.join(' ');
    const queryJoined = queryWords.join(' ');
    if (titleJoined.includes(queryJoined)) {
      score += 250;
    }
  }

  // Prefer shorter titles (more specific matches) - normalized to avoid dominating
  score -= Math.min(title.length, 100) * 0.5;

  return score;
}

// Zod schema for driveId validation
const driveIdSchema = z.string().min(1, 'driveId must not be empty').max(100);

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false } as const;

export async function GET(request: Request) {
  loggers.api.debug('[API] /api/mentions/search - Request received', {});

  // Support both Bearer tokens (desktop) and cookies (web)
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    loggers.api.debug('[API] Authentication failed', {});
    return auth.error;
  }

  const userId = auth.userId;

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q') || '';
  const driveId = searchParams.get('driveId');
  const crossDrive = searchParams.get('crossDrive') === 'true'; // Flag for cross-drive search
  const typesParam = searchParams.get('types'); // Comma-separated types
  
  loggers.api.debug('[API] Search params', { query, driveId, crossDrive, types: typesParam });
  
  // For within-drive searches, driveId is required
  // For cross-drive searches, driveId is optional (searches all accessible drives)
  if (!crossDrive && !driveId) {
    loggers.api.debug('[API] Missing driveId parameter for within-drive search', {});
    return NextResponse.json(
      { error: 'Missing driveId parameter for within-drive search' },
      { status: 400 }
    );
  }

  // Validate driveId if provided
  if (driveId) {
    const driveIdValidation = driveIdSchema.safeParse(driveId);
    if (!driveIdValidation.success) {
      loggers.api.debug('[API] Invalid driveId format', { driveId });
      return NextResponse.json(
        { error: 'Invalid driveId format' },
        { status: 400 }
      );
    }
  }

  // Parse requested mention types, default to all types
  const requestedTypes = typesParam
    ? typesParam.split(',') as MentionType[]
    : ['page', 'user'];

  try {
    const suggestions: MentionSuggestion[] = [];

    // Get target drive IDs based on search mode
    let targetDriveIds: string[];
    const driveContextMap: Map<string, string> = new Map(); // driveId -> drive name/slug for context

    if (crossDrive) {
      // Cross-drive search: get all drives user has access to (owned, member, page permissions)
      targetDriveIds = await getDriveIdsForUser(userId);

      // Build context map for drive disambiguation
      if (targetDriveIds.length > 0) {
        const driveInfos = await db.select({
          id: drives.id,
          name: drives.name,
          slug: drives.slug,
        })
        .from(drives)
        .where(inArray(drives.id, targetDriveIds));

        driveInfos.forEach(drive => {
          driveContextMap.set(drive.id, drive.name || drive.slug || drive.id);
        });
      }

      loggers.api.debug('[API] Cross-drive search', { driveCount: targetDriveIds.length });
    } else {
      // Within-drive search: verify user has access to the specified drive
      const hasAccess = await getUserDriveAccess(userId, driveId!);

      if (!hasAccess) {
        loggers.api.debug('[API] User does not have access to drive', { userId, driveId });
        return NextResponse.json(
          { error: 'Access denied to the specified drive' },
          { status: 403 }
        );
      }

      targetDriveIds = [driveId!];
      loggers.api.debug('[API] Within-drive search', { driveId });
    }

    if (targetDriveIds.length === 0) {
      loggers.api.debug('[API] No accessible drives found for user', {});
      return NextResponse.json([]);
    }

    // Search pages (all page types)
    if (requestedTypes.includes('page')) {
      const searchCondition = buildMultiWordSearchCondition(query);

      // Build query - when no search query, return recent pages ordered by updatedAt
      const pageQuery = db.select({
        id: pages.id,
        title: pages.title,
        type: pages.type,
        driveId: pages.driveId,
      })
      .from(pages)
      .where(
        and(
          inArray(pages.driveId, targetDriveIds),
          searchCondition, // undefined when empty query = no filter = all pages
          eq(pages.isTrashed, false)
        )
      );

      // When query is empty, order by recently updated so user sees relevant pages
      const pageResults = query.trim()
        ? await pageQuery.limit(50)
        : await pageQuery.orderBy(desc(pages.updatedAt)).limit(20);

      // Filter by permissions and requested types
      for (const page of pageResults) {
        const accessLevel = await getUserAccessLevel(userId, page.id);
        if (!accessLevel) continue;

        // All page types are now under 'page' mention type
        if (!requestedTypes.includes('page')) {
          continue; // Skip if page type not requested
        }
        
        const mentionType: MentionType = 'page';

        // Include drive context for cross-drive searches and short ID for differentiation
        const driveContext = crossDrive ? driveContextMap.get(page.driveId) : undefined;
        const shortId = page.id.slice(0, 6); // Short ID for differentiation
        const typeLabel = page.type.toLowerCase();

        let description: string;
        if (crossDrive && driveContext) {
          description = `${typeLabel} in ${driveContext} · ${shortId}`;
        } else {
          description = `${typeLabel} · ${shortId}`;
        }

        suggestions.push({
          id: page.id,
          label: page.title,
          type: mentionType,
          data: {
            pageType: page.type as 'DOCUMENT' | 'FOLDER' | 'CHANNEL' | 'AI_CHAT' | 'SHEET',
            driveId: page.driveId,
          },
          description,
        });
      }
    }

    // Search users (if user mentions are requested)
    if (requestedTypes.includes('user')) {
      const authorizedUserIds = new Set<string>();
      
      if (crossDrive) {
        // Cross-drive search: collect users from all accessible drives
        for (const targetDriveId of targetDriveIds) {
          // Get the drive owner
          const driveResults = await db.select({ ownerId: drives.ownerId }).from(drives).where(eq(drives.id, targetDriveId)).limit(1);
          const drive = driveResults[0];
          
          if (drive) {
            authorizedUserIds.add(drive.ownerId);
          }
        }
      } else {
        // Within-drive search: only users from the specified drive
        const driveResults = await db.select({ ownerId: drives.ownerId }).from(drives).where(eq(drives.id, driveId!)).limit(1);
        const drive = driveResults[0];
        
        if (!drive) {
          return NextResponse.json(
            { error: 'Drive not found' },
            { status: 404 }
          );
        }

        // Add the drive owner
        authorizedUserIds.add(drive.ownerId);
      }

      // Search for users only within the authorized set
      if (authorizedUserIds.size > 0) {
        // Build multi-word search for users (escaped to prevent LIKE injection)
        const userSearchConditions: SQL[] = [];
        if (query.trim()) {
          const words = query.trim().split(/\s+/).filter(Boolean);
          for (const word of words) {
            userSearchConditions.push(ilike(users.name, `%${escapeLikePattern(word)}%`));
          }
        }

        const userResults = await db.select({
          id: users.id,
          name: users.name,
          image: users.image,
        })
        .from(users)
        .where(
          and(
            inArray(users.id, Array.from(authorizedUserIds)),
            userSearchConditions.length > 0 ? and(...userSearchConditions) : undefined
          )
        )
        .limit(10);

        // Create suggestions without exposing email addresses or avatars
        for (const user of userResults) {
          suggestions.push({
            id: user.id,
            label: user.name || 'Unnamed User',
            type: 'user',
            data: {},
            description: crossDrive ? 'User (cross-drive)' : 'User',
          });
        }
      }
    }


    // Sort by relevance when there's a query; preserve DB order (updatedAt) when empty
    if (query.trim()) {
      suggestions.sort((a, b) => {
        const aScore = calculateRelevanceScore(a.label, query);
        const bScore = calculateRelevanceScore(b.label, query);

        if (aScore !== bScore) {
          return bScore - aScore;
        }

        return a.label.localeCompare(b.label);
      });
    }

    const finalSuggestions = suggestions.slice(0, 10);
    loggers.api.debug('[API] Returning suggestions', { count: finalSuggestions.length, suggestions: finalSuggestions });
    return NextResponse.json(finalSuggestions);
  } catch (error) {
    loggers.api.error('[MENTIONS_SEARCH_GET]', error as Error);
    return NextResponse.json(
      { error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}