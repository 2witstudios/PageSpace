/**
 * GitHub Connections Management
 * GET /api/github/connections - List user's GitHub connections
 * DELETE /api/github/connections - Remove GitHub connection
 */

import { githubConnections, githubRepositories } from '@pagespace/db';
import { db, eq } from '@pagespace/db';
import { verify } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { z } from 'zod/v4';
import { GitHubService } from '@pagespace/lib/services/github-service';

/**
 * GET - List GitHub connections for authenticated user
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

    // Get user's GitHub connections
    const connections = await db.query.githubConnections.findMany({
      where: eq(githubConnections.userId, payload.userId),
      with: {
        repositories: {
          columns: {
            id: true,
            fullName: true,
            enabled: true,
          },
        },
      },
    });

    // Don't return encrypted tokens in the response
    const sanitizedConnections = connections.map((conn) => ({
      id: conn.id,
      githubUserId: conn.githubUserId,
      githubUsername: conn.githubUsername,
      githubEmail: conn.githubEmail,
      githubAvatarUrl: conn.githubAvatarUrl,
      tokenType: conn.tokenType,
      scope: conn.scope,
      lastUsed: conn.lastUsed,
      createdAt: conn.createdAt,
      updatedAt: conn.updatedAt,
      revokedAt: conn.revokedAt,
      repositories: conn.repositories,
    }));

    return Response.json(sanitizedConnections);

  } catch (error) {
    loggers.auth.error('Failed to list GitHub connections', error as Error);
    return Response.json({ error: 'Failed to retrieve connections' }, { status: 500 });
  }
}

const deleteConnectionSchema = z.object({
  connectionId: z.string().optional(),
});

/**
 * DELETE - Remove GitHub connection
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
    const validation = deleteConnectionSchema.safeParse(body);

    if (!validation.success) {
      return Response.json({ errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const { connectionId } = validation.data;

    // If connectionId is provided, delete that specific connection
    // Otherwise, delete all connections for the user
    if (connectionId) {
      // Verify the connection belongs to the user
      const connection = await db.query.githubConnections.findFirst({
        where: eq(githubConnections.id, connectionId),
      });

      if (!connection) {
        return Response.json({ error: 'Connection not found' }, { status: 404 });
      }

      if (connection.userId !== payload.userId) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }

      // Delete the connection (cascade will delete related repositories and embeds)
      await db.delete(githubConnections).where(eq(githubConnections.id, connectionId));

      loggers.auth.info('Deleted GitHub connection', {
        userId: payload.userId,
        connectionId,
        githubUsername: connection.githubUsername,
      });
    } else {
      // Delete all connections for the user
      await db.delete(githubConnections).where(eq(githubConnections.userId, payload.userId));

      loggers.auth.info('Deleted all GitHub connections', {
        userId: payload.userId,
      });
    }

    return Response.json({ success: true });

  } catch (error) {
    loggers.auth.error('Failed to delete GitHub connection', error as Error);
    return Response.json({ error: 'Failed to delete connection' }, { status: 500 });
  }
}

/**
 * PATCH - Validate and refresh GitHub connection
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

    const { searchParams } = new URL(req.url);
    const connectionId = searchParams.get('connectionId');

    if (!connectionId) {
      return Response.json({ error: 'Connection ID required' }, { status: 400 });
    }

    // Get the connection
    const connection = await db.query.githubConnections.findFirst({
      where: eq(githubConnections.id, connectionId),
    });

    if (!connection) {
      return Response.json({ error: 'Connection not found' }, { status: 404 });
    }

    if (connection.userId !== payload.userId) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Validate the token
    const githubService = GitHubService.fromEncryptedToken(connection.encryptedAccessToken);
    const isValid = await githubService.validateToken();

    if (!isValid) {
      // Mark connection as invalid
      await db.update(githubConnections)
        .set({
          revokedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(githubConnections.id, connectionId));

      return Response.json({
        valid: false,
        message: 'GitHub token is invalid or expired. Please reconnect.',
      });
    }

    // Update last used timestamp
    await db.update(githubConnections)
      .set({
        lastUsed: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(githubConnections.id, connectionId));

    return Response.json({
      valid: true,
      message: 'GitHub connection is valid',
    });

  } catch (error) {
    loggers.auth.error('Failed to validate GitHub connection', error as Error);
    return Response.json({ error: 'Failed to validate connection' }, { status: 500 });
  }
}
