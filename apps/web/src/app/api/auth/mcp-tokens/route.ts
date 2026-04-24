import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { sessionRepository } from '@/lib/repositories/session-repository';
import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getActorInfo, logTokenActivity } from '@pagespace/lib/monitoring/activity-logger';
import { generateToken } from '@pagespace/lib/auth/token-utils';
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
    const { name, driveIds: rawDriveIds } = createTokenSchema.parse(body);

    // Deduplicate drive IDs to prevent unique constraint violations
    const driveIds = rawDriveIds ? [...new Set(rawDriveIds)] : [];

    // Zero Trust: Validate that the user has access to each specified drive
    // Users can scope tokens to any drive they have access to (owned OR member)
    if (driveIds.length > 0) {
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
    const newToken = await sessionRepository.createMcpTokenWithDriveScopes({
      userId,
      tokenHash,
      tokenPrefix,
      name,
      isScoped,
      driveIds,
    });

    // Fetch drive names for consistent response format with GET
    let driveScopes: { id: string; name: string }[] = [];
    if (driveIds.length > 0) {
      driveScopes = await sessionRepository.findDrivesByIds(driveIds);
    }

    // Log activity for audit trail (token creation is a security event)
    const actorInfo = await getActorInfo(userId);
    logTokenActivity(userId, 'token_create', {
      tokenId: newToken.id,
      tokenType: 'mcp',
      tokenName: newToken.name,
    }, actorInfo);
    auditRequest(req, { eventType: 'auth.token.created', userId, details: { tokenType: 'mcp' } });

    // Return the raw token ONCE to the user - this is the only time they'll see it
    // Response format matches GET for consistency
    return NextResponse.json({
      id: newToken.id,
      name: newToken.name,
      token: rawToken, // Return the actual token, not the hash
      createdAt: newToken.createdAt,
      lastUsed: null, // New token hasn't been used yet
      driveScopes, // Consistent format with GET: { id, name }[]
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
    const tokensWithDrives = await sessionRepository.findUserMcpTokensWithDrives(userId);
    auditRequest(req, { eventType: 'data.read', userId, resourceType: 'mcp_token', resourceId: userId });
    return NextResponse.json(tokensWithDrives);
  } catch (error) {
    loggers.auth.error('Error fetching MCP tokens:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch MCP tokens' }, { status: 500 });
  }
}