/**
 * GitHub Code Search
 * GET /api/github/search - Search code across connected repositories
 */

import { githubConnections, githubRepositories, githubSearchCache, drives, driveMembers } from '@pagespace/db';
import { db, eq, and, inArray, lt } from '@pagespace/db';
import { verify } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { GitHubService } from '@pagespace/lib/services/github-service';
import { createId } from '@paralleldrive/cuid2';

/**
 * GET - Search code across GitHub repositories
 * Query params:
 * - q: Search query
 * - driveId: Limit search to repositories in this drive
 * - repositoryId: Limit search to specific repository
 * - language: Filter by programming language
 * - path: Filter by file path
 * - per_page: Results per page (default 30)
 * - page: Page number (default 1)
 */
export async function GET(req: Request) {
  try {
    // Verify authentication
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');
    const payload = await verify(token);
    if (!payload) {
      return Response.json({ error: 'Invalid token' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const query = searchParams.get('q');
    const driveId = searchParams.get('driveId');
    const repositoryId = searchParams.get('repositoryId');
    const language = searchParams.get('language');
    const path = searchParams.get('path');
    const per_page = parseInt(searchParams.get('per_page') || '30');
    const page = parseInt(searchParams.get('page') || '1');

    if (!query) {
      return Response.json({ error: 'Search query required' }, { status: 400 });
    }

    // Determine which repositories to search
    let repositories;

    if (repositoryId) {
      // Search specific repository
      const repo = await db.query.githubRepositories.findFirst({
        where: eq(githubRepositories.id, repositoryId),
        with: {
          drive: true,
          connection: true,
        },
      });

      if (!repo) {
        return Response.json({ error: 'Repository not found' }, { status: 404 });
      }

      // Verify access to the drive
      if (repo.drive.ownerId !== payload.userId) {
        const membership = await db.query.driveMembers.findFirst({
          where: and(
            eq(driveMembers.driveId, repo.driveId),
            eq(driveMembers.userId, payload.userId)
          ),
        });

        if (!membership) {
          return Response.json({ error: 'Access denied' }, { status: 403 });
        }
      }

      repositories = [repo];

    } else if (driveId) {
      // Search all repositories in a drive
      const drive = await db.query.drives.findFirst({
        where: eq(drives.id, driveId),
      });

      if (!drive) {
        return Response.json({ error: 'Drive not found' }, { status: 404 });
      }

      // Verify access
      if (drive.ownerId !== payload.userId) {
        const membership = await db.query.driveMembers.findFirst({
          where: and(
            eq(driveMembers.driveId, driveId),
            eq(driveMembers.userId, payload.userId)
          ),
        });

        if (!membership) {
          return Response.json({ error: 'Access denied' }, { status: 403 });
        }
      }

      repositories = await db.query.githubRepositories.findMany({
        where: and(
          eq(githubRepositories.driveId, driveId),
          eq(githubRepositories.enabled, true)
        ),
        with: {
          connection: true,
        },
      });

    } else {
      // Search all accessible repositories across all drives
      const ownedDrives = await db.query.drives.findMany({
        where: eq(drives.ownerId, payload.userId),
        columns: { id: true },
      });

      const memberDrives = await db.query.driveMembers.findMany({
        where: eq(driveMembers.userId, payload.userId),
        columns: { driveId: true },
      });

      const driveIds = [
        ...ownedDrives.map((d) => d.id),
        ...memberDrives.map((m) => m.driveId),
      ];

      if (driveIds.length === 0) {
        return Response.json({ items: [], total_count: 0 });
      }

      repositories = await db.query.githubRepositories.findMany({
        where: and(
          inArray(githubRepositories.driveId, driveIds),
          eq(githubRepositories.enabled, true)
        ),
        with: {
          connection: true,
        },
      });
    }

    if (repositories.length === 0) {
      return Response.json({ items: [], total_count: 0 });
    }

    // Check cache first
    const cacheKey = `${query}:${repositories.map(r => r.id).join(',')}:${language || ''}:${path || ''}`;
    const cached = await db.query.githubSearchCache.findFirst({
      where: and(
        eq(githubSearchCache.query, cacheKey),
        lt(githubSearchCache.expiresAt, new Date())
      ),
    });

    if (cached && cached.results) {
      loggers.auth.info('GitHub search cache hit', {
        userId: payload.userId,
        query,
        repositoryCount: repositories.length,
      });

      return Response.json({
        items: cached.results,
        total_count: cached.resultCount,
        cached: true,
      });
    }

    // Perform search across repositories
    // Group repositories by connection to minimize API calls
    const connectionGroups = repositories.reduce((acc, repo) => {
      const connId = repo.connectionId;
      if (!acc[connId]) {
        acc[connId] = [];
      }
      acc[connId].push(repo);
      return {};
    }, {} as Record<string, typeof repositories>);

    const allResults: any[] = [];

    // Search each repository
    for (const repo of repositories) {
      try {
        const githubService = GitHubService.fromEncryptedToken(repo.connection.encryptedAccessToken);

        const searchResults = await githubService.searchCode(query, {
          repo: repo.fullName,
          language: language || undefined,
          path: path || undefined,
          per_page,
          page,
        });

        // Add repository context to results
        const resultsWithContext = searchResults.items.map((item: any) => ({
          ...item,
          repository: {
            id: repo.id,
            fullName: repo.fullName,
            htmlUrl: repo.htmlUrl,
            owner: repo.owner,
            name: repo.name,
          },
        }));

        allResults.push(...resultsWithContext);

      } catch (error) {
        loggers.auth.error('GitHub search error for repository', {
          error: error as Error,
          repository: repo.fullName,
        });
        // Continue searching other repositories
      }
    }

    // Sort results by score
    allResults.sort((a, b) => (b.score || 0) - (a.score || 0));

    // Cache the results (expire after 1 hour)
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await db.insert(githubSearchCache).values({
      id: createId(),
      driveId: driveId || repositories[0].driveId,
      query: cacheKey,
      repositoryIds: repositories.map(r => r.id),
      results: allResults,
      resultCount: allResults.length,
      expiresAt,
    });

    loggers.auth.info('GitHub search completed', {
      userId: payload.userId,
      query,
      repositoryCount: repositories.length,
      resultCount: allResults.length,
    });

    return Response.json({
      items: allResults,
      total_count: allResults.length,
      cached: false,
    });

  } catch (error) {
    loggers.auth.error('Failed to search GitHub code', error as Error);
    return Response.json({ error: 'Failed to search code' }, { status: 500 });
  }
}

/**
 * DELETE - Clear search cache
 */
export async function DELETE(req: Request) {
  try {
    // Verify authentication
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const token = authHeader.replace('Bearer ', '');
    const payload = await verify(token);
    if (!payload) {
      return Response.json({ error: 'Invalid token' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const driveId = searchParams.get('driveId');

    if (driveId) {
      // Clear cache for specific drive
      await db.delete(githubSearchCache).where(eq(githubSearchCache.driveId, driveId));
    } else {
      // Clear all expired cache entries
      await db.delete(githubSearchCache).where(lt(githubSearchCache.expiresAt, new Date()));
    }

    return Response.json({ success: true });

  } catch (error) {
    loggers.auth.error('Failed to clear GitHub search cache', error as Error);
    return Response.json({ error: 'Failed to clear cache' }, { status: 500 });
  }
}
