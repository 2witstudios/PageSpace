import { NextResponse } from 'next/server';
import { db, eq, and, or, ilike, pages, drives, users, userProfiles, inArray } from '@pagespace/db';
import { verifyAuth } from '@/lib/auth';
import { getBatchPagePermissions } from '@pagespace/lib/permissions-cached';
import { loggers } from '@pagespace/lib/logger-config';

interface SearchResult {
  id: string;
  title: string;
  type: 'page' | 'drive' | 'user';
  pageType?: string;
  driveId?: string;
  driveName?: string;
  description?: string;
  avatarUrl?: string | null;
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

    if (!query || query.length < 2) {
      return NextResponse.json({ results: [] });
    }

    const searchPattern = `%${query}%`;
    const results: SearchResult[] = [];

    // 1. Search drives the user owns
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
        or(
          ilike(drives.name, searchPattern),
          ilike(drives.slug, searchPattern)
        )
      )
    )
    .limit(10);

    // Add drive results
    for (const drive of driveResults) {
      results.push({
        id: drive.id,
        title: drive.name,
        type: 'drive',
        description: `/${drive.slug}`,
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
    if (allDriveIds.length > 0) {
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
            ilike(pages.title, searchPattern),
            // Optional: search in content for documents
            and(
              eq(pages.type, 'DOCUMENT'),
              ilike(pages.content, searchPattern)
            )
          )
        )
      )
      .limit(20);

      // Batch check permissions for all pages at once (eliminates N+1 queries)
      const pageIds = pageResults.map(page => page.id);
      const permissionsMap = await getBatchPagePermissions(user.id, pageIds);

      // Filter by permissions and add to results
      for (const page of pageResults) {
        const permissions = permissionsMap.get(page.id);
        if (!permissions?.canView) continue;

        results.push({
          id: page.id,
          title: page.title,
          type: 'page',
          pageType: page.type,
          driveId: page.driveId,
          driveName: driveMap.get(page.driveId) || 'Unknown Drive',
          description: `${page.type.toLowerCase()} in ${driveMap.get(page.driveId) || 'drive'}`,
        });
      }
    }

    // 3. Search users (with public profiles)
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
        or(
          ilike(userProfiles.username, searchPattern),
          ilike(userProfiles.displayName, searchPattern)
        )
      )
    )
    .limit(10);

    for (const profile of profileResults) {
      results.push({
        id: profile.userId,
        title: profile.displayName || profile.username || 'Unknown User',
        type: 'user',
        description: profile.username ? `@${profile.username}` : profile.email || '',
        avatarUrl: profile.avatarUrl,
      });
    }

    // Sort results by relevance
    results.sort((a, b) => {
      // Exact matches first
      const aExact = a.title.toLowerCase() === query.toLowerCase();
      const bExact = b.title.toLowerCase() === query.toLowerCase();

      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;

      // Then by type priority: drives > pages > users
      const typePriority = { drive: 0, page: 1, user: 2 };
      const aPriority = typePriority[a.type];
      const bPriority = typePriority[b.type];

      if (aPriority !== bPriority) return aPriority - bPriority;

      // Finally alphabetical
      return a.title.localeCompare(b.title);
    });

    // Limit total results
    const finalResults = results.slice(0, limit);

    loggers.api.debug('[SEARCH] Returning results', {
      query,
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