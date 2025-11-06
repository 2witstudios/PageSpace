/**
 * GitHub Repositories Management
 * GET /api/github/repositories - List available or connected repositories
 * POST /api/github/repositories - Connect a repository to a drive
 * DELETE /api/github/repositories - Disconnect a repository
 * PATCH /api/github/repositories - Update repository settings
 */

import { githubConnections, githubRepositories, drives, driveMembers } from '@pagespace/db';
import { db, eq, and, inArray } from '@pagespace/db';
import { verify } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { z } from 'zod/v4';
import { GitHubService } from '@pagespace/lib/services/github-service';
import { createId } from '@paralleldrive/cuid2';

/**
 * GET - List GitHub repositories
 * Query params:
 * - driveId: Filter by drive (returns connected repos)
 * - available: true to list available repos from GitHub (requires connectionId)
 * - connectionId: GitHub connection to use
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
    const driveId = searchParams.get('driveId');
    const available = searchParams.get('available') === 'true';
    const connectionId = searchParams.get('connectionId');

    if (available) {
      // List available repositories from GitHub
      if (!connectionId) {
        return Response.json({ error: 'Connection ID required for available repositories' }, { status: 400 });
      }

      // Get the connection
      const connection = await db.query.githubConnections.findFirst({
        where: and(
          eq(githubConnections.id, connectionId),
          eq(githubConnections.userId, payload.userId)
        ),
      });

      if (!connection) {
        return Response.json({ error: 'GitHub connection not found' }, { status: 404 });
      }

      // Fetch repositories from GitHub
      const githubService = GitHubService.fromEncryptedToken(connection.encryptedAccessToken);
      const repos = await githubService.listRepositories({
        per_page: 100,
        sort: 'updated',
      });

      return Response.json(repos);

    } else if (driveId) {
      // List connected repositories for a specific drive
      // Verify user has access to the drive
      const drive = await db.query.drives.findFirst({
        where: eq(drives.id, driveId),
      });

      if (!drive) {
        return Response.json({ error: 'Drive not found' }, { status: 404 });
      }

      // Check if user is owner or member
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

      // Get connected repositories
      const repos = await db.query.githubRepositories.findMany({
        where: eq(githubRepositories.driveId, driveId),
        with: {
          connection: {
            columns: {
              githubUsername: true,
              githubAvatarUrl: true,
            },
          },
        },
      });

      return Response.json(repos);

    } else {
      // List all connected repositories for the user across all their drives
      // Get all drives the user owns or is a member of
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
        return Response.json([]);
      }

      const repos = await db.query.githubRepositories.findMany({
        where: inArray(githubRepositories.driveId, driveIds),
        with: {
          drive: {
            columns: {
              id: true,
              name: true,
            },
          },
          connection: {
            columns: {
              githubUsername: true,
              githubAvatarUrl: true,
            },
          },
        },
      });

      return Response.json(repos);
    }

  } catch (error) {
    loggers.auth.error('Failed to list GitHub repositories', error as Error);
    return Response.json({ error: 'Failed to retrieve repositories' }, { status: 500 });
  }
}

const connectRepoSchema = z.object({
  driveId: z.string(),
  connectionId: z.string(),
  owner: z.string(),
  name: z.string(),
  branches: z.array(z.string()).optional(),
});

/**
 * POST - Connect a GitHub repository to a drive
 */
export async function POST(req: Request) {
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

    const body = await req.json();
    const validation = connectRepoSchema.safeParse(body);

    if (!validation.success) {
      return Response.json({ errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const { driveId, connectionId, owner, name, branches } = validation.data;

    // Verify user owns the drive or is an admin
    const drive = await db.query.drives.findFirst({
      where: eq(drives.id, driveId),
    });

    if (!drive) {
      return Response.json({ error: 'Drive not found' }, { status: 404 });
    }

    if (drive.ownerId !== payload.userId) {
      const membership = await db.query.driveMembers.findFirst({
        where: and(
          eq(driveMembers.driveId, driveId),
          eq(driveMembers.userId, payload.userId)
        ),
      });

      if (!membership || membership.role === 'MEMBER') {
        return Response.json({ error: 'Admin access required' }, { status: 403 });
      }
    }

    // Verify the connection belongs to the user
    const connection = await db.query.githubConnections.findFirst({
      where: and(
        eq(githubConnections.id, connectionId),
        eq(githubConnections.userId, payload.userId)
      ),
    });

    if (!connection) {
      return Response.json({ error: 'GitHub connection not found' }, { status: 404 });
    }

    // Fetch repository details from GitHub
    const githubService = GitHubService.fromEncryptedToken(connection.encryptedAccessToken);
    const repoData = await githubService.getRepository(owner, name);

    // Check if repository is already connected to this drive
    const existing = await db.query.githubRepositories.findFirst({
      where: and(
        eq(githubRepositories.driveId, driveId),
        eq(githubRepositories.fullName, repoData.full_name)
      ),
    });

    if (existing) {
      return Response.json({ error: 'Repository already connected to this drive' }, { status: 409 });
    }

    // Create repository record
    const [repo] = await db.insert(githubRepositories).values({
      id: createId(),
      driveId,
      connectionId,
      githubRepoId: repoData.id,
      owner: repoData.owner.login,
      name: repoData.name,
      fullName: repoData.full_name,
      description: repoData.description,
      isPrivate: repoData.private,
      defaultBranch: repoData.default_branch,
      language: repoData.language,
      htmlUrl: repoData.html_url,
      cloneUrl: repoData.clone_url,
      stargazersCount: repoData.stargazers_count,
      forksCount: repoData.forks_count,
      openIssuesCount: repoData.open_issues_count,
      lastSyncedAt: new Date(),
      enabled: true,
      branches: branches || null,
    }).returning();

    loggers.auth.info('Connected GitHub repository', {
      userId: payload.userId,
      driveId,
      repoFullName: repoData.full_name,
    });

    return Response.json(repo, { status: 201 });

  } catch (error) {
    loggers.auth.error('Failed to connect GitHub repository', error as Error);
    return Response.json({ error: 'Failed to connect repository' }, { status: 500 });
  }
}

const disconnectRepoSchema = z.object({
  repositoryId: z.string(),
});

/**
 * DELETE - Disconnect a GitHub repository
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

    const body = await req.json();
    const validation = disconnectRepoSchema.safeParse(body);

    if (!validation.success) {
      return Response.json({ errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const { repositoryId } = validation.data;

    // Get the repository
    const repo = await db.query.githubRepositories.findFirst({
      where: eq(githubRepositories.id, repositoryId),
      with: {
        drive: true,
      },
    });

    if (!repo) {
      return Response.json({ error: 'Repository not found' }, { status: 404 });
    }

    // Verify user owns the drive or is an admin
    if (repo.drive.ownerId !== payload.userId) {
      const membership = await db.query.driveMembers.findFirst({
        where: and(
          eq(driveMembers.driveId, repo.driveId),
          eq(driveMembers.userId, payload.userId)
        ),
      });

      if (!membership || membership.role === 'MEMBER') {
        return Response.json({ error: 'Admin access required' }, { status: 403 });
      }
    }

    // Delete the repository (cascade will delete related embeds)
    await db.delete(githubRepositories).where(eq(githubRepositories.id, repositoryId));

    loggers.auth.info('Disconnected GitHub repository', {
      userId: payload.userId,
      repositoryId,
      repoFullName: repo.fullName,
    });

    return Response.json({ success: true });

  } catch (error) {
    loggers.auth.error('Failed to disconnect GitHub repository', error as Error);
    return Response.json({ error: 'Failed to disconnect repository' }, { status: 500 });
  }
}

const updateRepoSchema = z.object({
  repositoryId: z.string(),
  enabled: z.boolean().optional(),
  branches: z.array(z.string()).optional(),
});

/**
 * PATCH - Update repository settings
 */
export async function PATCH(req: Request) {
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

    const body = await req.json();
    const validation = updateRepoSchema.safeParse(body);

    if (!validation.success) {
      return Response.json({ errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const { repositoryId, enabled, branches } = validation.data;

    // Get the repository
    const repo = await db.query.githubRepositories.findFirst({
      where: eq(githubRepositories.id, repositoryId),
      with: {
        drive: true,
      },
    });

    if (!repo) {
      return Response.json({ error: 'Repository not found' }, { status: 404 });
    }

    // Verify user owns the drive or is an admin
    if (repo.drive.ownerId !== payload.userId) {
      const membership = await db.query.driveMembers.findFirst({
        where: and(
          eq(driveMembers.driveId, repo.driveId),
          eq(driveMembers.userId, payload.userId)
        ),
      });

      if (!membership || membership.role === 'MEMBER') {
        return Response.json({ error: 'Admin access required' }, { status: 403 });
      }
    }

    // Update the repository
    const updates: Partial<typeof githubRepositories.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (enabled !== undefined) {
      updates.enabled = enabled;
    }

    if (branches !== undefined) {
      updates.branches = branches;
    }

    const [updatedRepo] = await db.update(githubRepositories)
      .set(updates)
      .where(eq(githubRepositories.id, repositoryId))
      .returning();

    loggers.auth.info('Updated GitHub repository settings', {
      userId: payload.userId,
      repositoryId,
      updates,
    });

    return Response.json(updatedRepo);

  } catch (error) {
    loggers.auth.error('Failed to update GitHub repository', error as Error);
    return Response.json({ error: 'Failed to update repository' }, { status: 500 });
  }
}
