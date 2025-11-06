/**
 * GitHub File Browsing
 * GET /api/github/files - Browse repository files and get file contents
 */

import { githubRepositories, githubCodeEmbeds, driveMembers } from '@pagespace/db';
import { db, eq, and } from '@pagespace/db';
import { verify } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { GitHubService, detectLanguageFromPath } from '@pagespace/lib/services/github-service';
import { createId } from '@paralleldrive/cuid2';
import { z } from 'zod/v4';

/**
 * GET - Browse repository files or get file content
 * Query params:
 * - repositoryId: Repository ID (required)
 * - path: File or directory path (default: root)
 * - ref: Branch or commit SHA (default: repository default branch)
 * - startLine: Start line for code snippet (optional)
 * - endLine: End line for code snippet (optional)
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
    const repositoryId = searchParams.get('repositoryId');
    const path = searchParams.get('path') || '';
    const ref = searchParams.get('ref');
    const startLine = searchParams.get('startLine');
    const endLine = searchParams.get('endLine');

    if (!repositoryId) {
      return Response.json({ error: 'Repository ID required' }, { status: 400 });
    }

    // Get the repository
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

    // Create GitHub service
    const githubService = GitHubService.fromEncryptedToken(repo.connection.encryptedAccessToken);

    // Determine the branch to use
    const branch = ref || repo.defaultBranch;

    // Get file/directory contents
    const contents = await githubService.getContents(repo.owner, repo.name, path, branch);

    // If it's a directory, return the listing
    if (Array.isArray(contents)) {
      return Response.json({
        type: 'directory',
        path,
        branch,
        items: contents,
      });
    }

    // If it's a file, get the content
    if (contents.type === 'file') {
      const fileContent = await githubService.getFileContent(repo.owner, repo.name, path, branch);

      // Extract line range if specified
      let finalContent = fileContent.content;
      if (startLine && endLine) {
        const lines = fileContent.content.split('\n');
        const start = parseInt(startLine) - 1; // Convert to 0-indexed
        const end = parseInt(endLine);
        finalContent = lines.slice(start, end).join('\n');
      }

      // Detect language
      const language = detectLanguageFromPath(path);

      return Response.json({
        type: 'file',
        path,
        branch,
        content: finalContent,
        sha: fileContent.sha,
        size: fileContent.size,
        language,
        startLine: startLine ? parseInt(startLine) : undefined,
        endLine: endLine ? parseInt(endLine) : undefined,
      });
    }

    return Response.json({
      type: contents.type,
      path,
      branch,
      message: `Unsupported type: ${contents.type}`,
    });

  } catch (error) {
    loggers.auth.error('Failed to browse GitHub files', error as Error);
    return Response.json({ error: 'Failed to browse files' }, { status: 500 });
  }
}

const createEmbedSchema = z.object({
  repositoryId: z.string(),
  filePath: z.string(),
  branch: z.string(),
  startLine: z.number().optional(),
  endLine: z.number().optional(),
  showLineNumbers: z.boolean().default(true),
  highlightLines: z.array(z.number()).optional(),
});

/**
 * POST - Create a code embed
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
    const validation = createEmbedSchema.safeParse(body);

    if (!validation.success) {
      return Response.json({ errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const { repositoryId, filePath, branch, startLine, endLine, showLineNumbers, highlightLines } = validation.data;

    // Get the repository
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

    // Verify access
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

    // Fetch the file content
    const githubService = GitHubService.fromEncryptedToken(repo.connection.encryptedAccessToken);
    const fileContent = await githubService.getFileContent(repo.owner, repo.name, filePath, branch);

    // Get the latest commit SHA for this file
    const commits = await githubService.listCommits(repo.owner, repo.name, {
      path: filePath,
      sha: branch,
      per_page: 1,
    });
    const commitSha = commits[0]?.sha || null;

    // Extract line range if specified
    let content = fileContent.content;
    if (startLine && endLine) {
      const lines = fileContent.content.split('\n');
      const start = startLine - 1; // Convert to 0-indexed
      const end = endLine;
      content = lines.slice(start, end).join('\n');
    }

    // Detect language
    const language = detectLanguageFromPath(filePath);

    // Create the embed record
    const [embed] = await db.insert(githubCodeEmbeds).values({
      id: createId(),
      repositoryId,
      filePath,
      branch,
      startLine: startLine || null,
      endLine: endLine || null,
      content,
      language,
      fileSize: fileContent.size,
      commitSha,
      lastFetchedAt: new Date(),
      showLineNumbers,
      highlightLines: highlightLines || null,
    }).returning();

    loggers.auth.info('Created GitHub code embed', {
      userId: payload.userId,
      embedId: embed.id,
      repository: repo.fullName,
      filePath,
    });

    return Response.json(embed, { status: 201 });

  } catch (error) {
    loggers.auth.error('Failed to create code embed', error as Error);
    return Response.json({ error: 'Failed to create code embed' }, { status: 500 });
  }
}

const updateEmbedSchema = z.object({
  embedId: z.string(),
  showLineNumbers: z.boolean().optional(),
  highlightLines: z.array(z.number()).optional(),
  refresh: z.boolean().optional(),
});

/**
 * PATCH - Update or refresh a code embed
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
    const validation = updateEmbedSchema.safeParse(body);

    if (!validation.success) {
      return Response.json({ errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const { embedId, showLineNumbers, highlightLines, refresh } = validation.data;

    // Get the embed with repository info
    const embed = await db.query.githubCodeEmbeds.findFirst({
      where: eq(githubCodeEmbeds.id, embedId),
      with: {
        repository: {
          with: {
            drive: true,
            connection: true,
          },
        },
      },
    });

    if (!embed) {
      return Response.json({ error: 'Code embed not found' }, { status: 404 });
    }

    // Verify access
    if (embed.repository.drive.ownerId !== payload.userId) {
      const membership = await db.query.driveMembers.findFirst({
        where: and(
          eq(driveMembers.driveId, embed.repository.driveId),
          eq(driveMembers.userId, payload.userId)
        ),
      });

      if (!membership) {
        return Response.json({ error: 'Access denied' }, { status: 403 });
      }
    }

    const updates: Partial<typeof githubCodeEmbeds.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (showLineNumbers !== undefined) {
      updates.showLineNumbers = showLineNumbers;
    }

    if (highlightLines !== undefined) {
      updates.highlightLines = highlightLines;
    }

    // Refresh content if requested
    if (refresh) {
      try {
        const githubService = GitHubService.fromEncryptedToken(
          embed.repository.connection.encryptedAccessToken
        );

        const fileContent = await githubService.getFileContent(
          embed.repository.owner,
          embed.repository.name,
          embed.filePath,
          embed.branch
        );

        // Extract line range
        let content = fileContent.content;
        if (embed.startLine && embed.endLine) {
          const lines = fileContent.content.split('\n');
          const start = embed.startLine - 1;
          const end = embed.endLine;
          content = lines.slice(start, end).join('\n');
        }

        // Get latest commit
        const commits = await githubService.listCommits(
          embed.repository.owner,
          embed.repository.name,
          {
            path: embed.filePath,
            sha: embed.branch,
            per_page: 1,
          }
        );

        updates.content = content;
        updates.commitSha = commits[0]?.sha || null;
        updates.fileSize = fileContent.size;
        updates.lastFetchedAt = new Date();
        updates.fetchError = null;

      } catch (error) {
        updates.fetchError = (error as Error).message;
        loggers.auth.error('Failed to refresh code embed', {
          error: error as Error,
          embedId,
        });
      }
    }

    const [updatedEmbed] = await db.update(githubCodeEmbeds)
      .set(updates)
      .where(eq(githubCodeEmbeds.id, embedId))
      .returning();

    return Response.json(updatedEmbed);

  } catch (error) {
    loggers.auth.error('Failed to update code embed', error as Error);
    return Response.json({ error: 'Failed to update code embed' }, { status: 500 });
  }
}

/**
 * DELETE - Delete a code embed
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
    const embedId = searchParams.get('embedId');

    if (!embedId) {
      return Response.json({ error: 'Embed ID required' }, { status: 400 });
    }

    // Get the embed
    const embed = await db.query.githubCodeEmbeds.findFirst({
      where: eq(githubCodeEmbeds.id, embedId),
      with: {
        repository: {
          with: {
            drive: true,
          },
        },
      },
    });

    if (!embed) {
      return Response.json({ error: 'Code embed not found' }, { status: 404 });
    }

    // Verify access
    if (embed.repository.drive.ownerId !== payload.userId) {
      const membership = await db.query.driveMembers.findFirst({
        where: and(
          eq(driveMembers.driveId, embed.repository.driveId),
          eq(driveMembers.userId, payload.userId)
        ),
      });

      if (!membership) {
        return Response.json({ error: 'Access denied' }, { status: 403 });
      }
    }

    await db.delete(githubCodeEmbeds).where(eq(githubCodeEmbeds.id, embedId));

    return Response.json({ success: true });

  } catch (error) {
    loggers.auth.error('Failed to delete code embed', error as Error);
    return Response.json({ error: 'Failed to delete code embed' }, { status: 500 });
  }
}
