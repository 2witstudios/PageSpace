import { NextRequest, NextResponse } from 'next/server';
import { db, mcpTokens, mcpTokenDrives } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/server';
import { getActorInfo, logTokenActivity } from '@pagespace/lib/monitoring/activity-logger';
import { generateToken } from '@pagespace/lib/auth';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

// Schema for creating a new MCP token
const createTokenSchema = z.object({
  name: z.string().min(1).max(100),
  // Optional array of drive IDs to scope this token to
  // If empty or not provided, token has access to all user's drives
  driveIds: z.array(z.string()).optional(),
});

// POST: Create a new MCP token
export async function POST(req: NextRequest) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  try {
    const body = await req.json();
    const { name, driveIds } = createTokenSchema.parse(body);

    // Zero Trust: Validate that the user has access to each specified drive
    // Users can scope tokens to any drive they have access to (owned OR member)
    if (driveIds && driveIds.length > 0) {
      const invalidDriveIds: string[] = [];

      for (const driveId of driveIds) {
        const access = await getDriveAccess(driveId, userId);
        // User must be owner, admin, or member to scope a token to this drive
        if (!access.isOwner && !access.isMember) {
          invalidDriveIds.push(driveId);
        }
      }

      if (invalidDriveIds.length > 0) {
        return NextResponse.json(
          { error: 'You do not have access to these drives: ' + invalidDriveIds.join(', ') },
          { status: 403 }
        );
      }
    }

    // P1-T3: Generate token with hash and prefix for secure storage
    // SECURITY: Only the hash is stored - plaintext token is returned once and never persisted
    const { token: rawToken, hash: tokenHash, tokenPrefix } = generateToken('mcp');

    // Determine if this token is scoped (fail-closed security)
    const isScoped = !!(driveIds && driveIds.length > 0);

    // Use transaction to ensure token and drive scopes are created atomically
    // If drive scope insertion fails, the token should not exist
    const newToken = await db.transaction(async (tx) => {
      // Store ONLY the hash in the database
      // isScoped=true means if all scoped drives are deleted, deny access (not grant all)
      const [token] = await tx.insert(mcpTokens).values({
        userId,
        tokenHash,
        tokenPrefix,
        name,
        isScoped,
      }).returning();

      // If drive scopes are specified, create the junction table entries
      if (driveIds && driveIds.length > 0) {
        await tx.insert(mcpTokenDrives).values(
          driveIds.map(driveId => ({
            tokenId: token.id,
            driveId,
          }))
        );
      }

      return token;
    });

    // Log activity for audit trail (token creation is a security event)
    const actorInfo = await getActorInfo(userId);
    logTokenActivity(userId, 'token_create', {
      tokenId: newToken.id,
      tokenType: 'mcp',
      tokenName: newToken.name,
    }, actorInfo);

    // Return the raw token ONCE to the user - this is the only time they'll see it
    return NextResponse.json({
      id: newToken.id,
      name: newToken.name,
      token: rawToken, // Return the actual token, not the hash
      createdAt: newToken.createdAt,
      driveIds: driveIds || [], // Return the drive scopes
    });
  } catch (error) {
    loggers.auth.error('Error creating MCP token:', error as Error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to create MCP token' }, { status: 500 });
  }
}

// GET: List user's MCP tokens (without the actual token values)
export async function GET(req: NextRequest) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  try {
    // Fetch all non-revoked tokens for the user with their drive scopes
    const tokens = await db.query.mcpTokens.findMany({
      where: (tokens, { eq, isNull, and }) => and(
        eq(tokens.userId, userId),
        isNull(tokens.revokedAt)
      ),
      columns: {
        id: true,
        name: true,
        lastUsed: true,
        createdAt: true,
      },
      with: {
        driveScopes: {
          columns: {
            driveId: true,
          },
          with: {
            drive: {
              columns: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    });

    // Transform the response to include drive info
    // Filter out any scopes where the drive may have been deleted
    const tokensWithDrives = tokens.map(token => ({
      id: token.id,
      name: token.name,
      lastUsed: token.lastUsed,
      createdAt: token.createdAt,
      driveScopes: token.driveScopes
        .filter(scope => scope.drive != null)
        .map(scope => ({
          id: scope.drive.id,
          name: scope.drive.name,
        })),
    }));

    return NextResponse.json(tokensWithDrives);
  } catch (error) {
    loggers.auth.error('Error fetching MCP tokens:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch MCP tokens' }, { status: 500 });
  }
}