import { NextResponse } from 'next/server';
import { db, eq, and, or, ilike, pages, drives, users, userProfiles, inArray, SQL } from '@pagespace/db';
import { verifyAuth } from '@/lib/auth';
import { getBatchPagePermissions } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';

interface SearchResult {
  id: string;
  title: string;
  type: 'page' | 'drive' | 'user';
  pageType?: string;
  driveId?: string;
  driveName?: string;
  description?: string;
  avatarUrl?: string | null;
  matchLocation?: 'title' | 'content' | 'both';
  relevanceScore?: number;
}

/**
 * Escape LIKE pattern metacharacters to prevent injection
 */
function escapeLikePattern(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

/**
 * Build multi-word search conditions where all words must be present
 * For title: all words must appear in title (any order)
 * For content: at least one word in content OR all words in title
 */
function buildMultiWordTitleCondition(query: string): SQL | undefined {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;

  const conditions = words.map(word =>
    ilike(pages.title, `%${escapeLikePattern(word)}%`)
  );

  return conditions.length === 1 ? conditions[0] : and(...conditions);
}

function buildMultiWordContentCondition(query: string): SQL | undefined {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;

  // For content, we search for any word (more lenient)
  const conditions = words.map(word =>
    ilike(pages.content, `%${escapeLikePattern(word)}%`)
  );

  return conditions.length === 1 ? conditions[0] : or(...conditions);
}

/**
 * Build multi-word search for drives (name or slug)
 */
function buildMultiWordDriveCondition(query: string): SQL | undefined {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;

  // Each word must appear in name or slug
  const conditions = words.map(word =>
    or(
      ilike(drives.name, `%${escapeLikePattern(word)}%`),
      ilike(drives.slug, `%${escapeLikePattern(word)}%`)
    )
  );

  return conditions.length === 1 ? conditions[0] : and(...conditions);
}

/**
 * Build multi-word search for user profiles
 */
function buildMultiWordUserCondition(query: string): SQL | undefined {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;

  // Each word must appear in username or display name
  const conditions = words.map(word =>
    or(
      ilike(userProfiles.username, `%${escapeLikePattern(word)}%`),
      ilike(userProfiles.displayName, `%${escapeLikePattern(word)}%`)
    )
  );

  return conditions.length === 1 ? conditions[0] : and(...conditions);
}

/**
 * Calculate relevance score for search results
 * Higher score = more relevant
 *
 * Priority (highest to lowest):
 * 1. Exact title match
 * 2. Title starts with query
 * 3. Title contains exact query phrase
 * 4. All query words match title word boundaries
 * 5. Partial word matches in title
 * 6. Content matches (significantly lower)
 * 7. Shorter titles preferred (more specific)
 */
function calculateRelevanceScore(
  title: string,
  query: string,
  matchLocation: 'title' | 'content' | 'both'
): number {
  const lowerTitle = title.toLowerCase();
  const lowerQuery = query.toLowerCase().trim();
  const queryWords = lowerQuery.split(/\s+/).filter(Boolean);

  let score = 0;

  // Base score based on where the match occurred
  // Title matches are WAY more valuable than content matches
  if (matchLocation === 'title' || matchLocation === 'both') {
    score += 1000; // Big boost for title matches
  } else if (matchLocation === 'content') {
    score += 100; // Content-only matches are lower priority
  }

  // Exact title match (highest priority)
  if (lowerTitle === lowerQuery) {
    score += 5000;
  }

  // Title starts with exact query
  if (lowerTitle.startsWith(lowerQuery)) {
    score += 2000;
  }

  // Title contains exact query phrase
  if (lowerTitle.includes(lowerQuery)) {
    score += 1000;
  }

  // Word boundary matching - check each query word
  const titleWords = lowerTitle.split(/[\s\-_.,;:!?()[\]{}]+/).filter(Boolean);
  let wordBoundaryMatches = 0;
  let prefixMatches = 0;
  let partialMatches = 0;

  for (const queryWord of queryWords) {
    let foundMatch = false;

    for (const titleWord of titleWords) {
      if (titleWord === queryWord) {
        // Exact word match
        wordBoundaryMatches++;
        foundMatch = true;
        break;
      } else if (titleWord.startsWith(queryWord)) {
        // Title word starts with query word (prefix match)
        prefixMatches++;
        foundMatch = true;
        break;
      } else if (titleWord.includes(queryWord)) {
        // Partial match within word
        partialMatches++;
        foundMatch = true;
        break;
      }
    }

    if (!foundMatch && matchLocation === 'title') {
      // Query word not found in title at all - reduce score
      score -= 50;
    }
  }

  // Award points for word matches
  score += wordBoundaryMatches * 500;
  score += prefixMatches * 300;
  score += partialMatches * 100;

  // Bonus for matching ALL query words (complete multi-word match)
  if (queryWords.length > 1) {
    const matchedCount = wordBoundaryMatches + prefixMatches + partialMatches;
    if (matchedCount >= queryWords.length) {
      score += 800; // Bonus for complete multi-word match
    }
  }

  // Prefer shorter titles (more specific/focused results)
  // Penalty scales with length but caps at 100 points
  score -= Math.min(title.length, 100);

  return score;
}

/**
 * Determine where the match occurred (title, content, or both)
 */
function getMatchLocation(
  title: string,
  content: string | null,
  query: string
): 'title' | 'content' | 'both' {
  const lowerQuery = query.toLowerCase().trim();
  const queryWords = lowerQuery.split(/\s+/).filter(Boolean);
  const lowerTitle = title.toLowerCase();
  const lowerContent = (content || '').toLowerCase();

  // Check if ANY query word matches title
  const titleMatches = queryWords.some(word => lowerTitle.includes(word));

  // Check if ANY query word matches content
  const contentMatches = queryWords.some(word => lowerContent.includes(word));

  if (titleMatches && contentMatches) return 'both';
  if (titleMatches) return 'title';
  return 'content';
}

export async function GET(request: Request) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q');
    const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 50);

    // Trim whitespace and validate - prevents whitespace-only queries
    const trimmedQuery = query?.trim();
    if (!trimmedQuery || trimmedQuery.length < 2) {
      return NextResponse.json({ results: [] });
    }

    const results: SearchResult[] = [];

    // 1. Search drives the user owns (with multi-word support)
    const driveCondition = buildMultiWordDriveCondition(trimmedQuery);
    const driveResults = await db.select({
      id: drives.id,
      name: drives.name,
      slug: drives.slug,
    })
    .from(drives)
    .where(
      and(
        eq(drives.ownerId, user.id),
        eq(drives.isTrashed, false),
        driveCondition
      )
    )
    .limit(10);

    // Add drive results (calculate score inline for consistency)
    for (const drive of driveResults) {
      const matchLocation = 'title' as const;
      const relevanceScore = calculateRelevanceScore(drive.name, trimmedQuery, matchLocation);
      results.push({
        id: drive.id,
        title: drive.name,
        type: 'drive',
        description: `/${drive.slug}`,
        matchLocation,
        relevanceScore,
      });
    }

    // Get all drives the user owns (not just searched ones) for page search
    const allUserDrives = await db.select({
      id: drives.id,
      name: drives.name,
    })
    .from(drives)
    .where(
      and(
        eq(drives.ownerId, user.id),
        eq(drives.isTrashed, false)
      )
    );

    const allDriveIds = allUserDrives.map(d => d.id);
    const driveMap = new Map(allUserDrives.map(d => [d.id, d.name]));

    // 2. Search pages in accessible drives
    // We use multi-word search: all query words must appear in title OR content
    if (allDriveIds.length > 0) {
      const titleCondition = buildMultiWordTitleCondition(trimmedQuery);
      const contentCondition = buildMultiWordContentCondition(trimmedQuery);

      const pageResults = await db.select({
        id: pages.id,
        title: pages.title,
        type: pages.type,
        driveId: pages.driveId,
        content: pages.content,
      })
      .from(pages)
      .where(
        and(
          inArray(pages.driveId, allDriveIds),
          eq(pages.isTrashed, false),
          or(
            titleCondition,
            // Search content for documents
            and(
              eq(pages.type, 'DOCUMENT'),
              contentCondition
            )
          )
        )
      )
      .limit(50); // Fetch more to allow better ranking

      // Batch check permissions for all pages at once (eliminates N+1 queries)
      const pageIds = pageResults.map(page => page.id);
      const permissionsMap = await getBatchPagePermissions(user.id, pageIds);

      // Filter by permissions and calculate relevance
      for (const page of pageResults) {
        const permissions = permissionsMap.get(page.id);
        if (!permissions?.canView) continue;

        const matchLocation = getMatchLocation(page.title, page.content, trimmedQuery);
        const relevanceScore = calculateRelevanceScore(page.title, trimmedQuery, matchLocation);

        results.push({
          id: page.id,
          title: page.title,
          type: 'page',
          pageType: page.type,
          driveId: page.driveId,
          driveName: driveMap.get(page.driveId) || 'Unknown Drive',
          description: `${page.type.toLowerCase()} in ${driveMap.get(page.driveId) || 'drive'}`,
          matchLocation,
          relevanceScore,
        });
      }
    }

    // 3. Search users (with public profiles) - multi-word support
    const userCondition = buildMultiWordUserCondition(trimmedQuery);
    const profileResults = await db.select({
      userId: userProfiles.userId,
      username: userProfiles.username,
      displayName: userProfiles.displayName,
      avatarUrl: userProfiles.avatarUrl,
      email: users.email,
    })
    .from(userProfiles)
    .leftJoin(users, eq(userProfiles.userId, users.id))
    .where(
      and(
        eq(userProfiles.isPublic, true),
        userCondition
      )
    )
    .limit(10);

    // Add user results (calculate score inline for consistency)
    for (const profile of profileResults) {
      const title = profile.displayName || profile.username || 'Unknown User';
      const matchLocation = 'title' as const;
      const relevanceScore = calculateRelevanceScore(title, trimmedQuery, matchLocation);
      results.push({
        id: profile.userId,
        title,
        type: 'user',
        description: profile.username ? `@${profile.username}` : profile.email || '',
        avatarUrl: profile.avatarUrl,
        matchLocation,
        relevanceScore,
      });
    }

    // Sort results by relevance score (highest first)
    results.sort((a, b) => {
      const aScore = a.relevanceScore ?? 0;
      const bScore = b.relevanceScore ?? 0;

      // Primary: Sort by relevance score (higher = better)
      if (aScore !== bScore) {
        return bScore - aScore;
      }

      // Secondary: Type priority (drives > pages > users) as tiebreaker
      const typePriority = { drive: 0, page: 1, user: 2 };
      const aPriority = typePriority[a.type];
      const bPriority = typePriority[b.type];

      if (aPriority !== bPriority) {
        return aPriority - bPriority;
      }

      // Tertiary: Alphabetical
      return a.title.localeCompare(b.title);
    });

    // Limit total results
    const finalResults = results.slice(0, limit);

    loggers.api.debug('[SEARCH] Returning results', {
      query: trimmedQuery,
      count: finalResults.length,
      breakdown: {
        drives: finalResults.filter(r => r.type === 'drive').length,
        pages: finalResults.filter(r => r.type === 'page').length,
        users: finalResults.filter(r => r.type === 'user').length,
      }
    });

    return NextResponse.json({ results: finalResults });
  } catch (error) {
    loggers.api.error('Error in global search:', error as Error);
    return NextResponse.json(
      { error: 'Failed to search' },
      { status: 500 }
    );
  }
}