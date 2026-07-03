import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { sessionRepository } from '@/lib/repositories/session-repository';
import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getActorInfo, logTokenActivity } from '@pagespace/lib/monitoring/activity-logger';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import { validateDriveScopeAccess } from '@pagespace/lib/services/drive-service';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

// Schema for creating a new MCP token
const createTokenSchema = z.object({
  name: z.string().min(1).max(100),
  // Legacy: plain drive IDs — scope only, role inherits from the owner
  driveIds: z.array(z.string()).optional(),
  // Preferred: per-drive scope. Omitted role = INHERIT (the key acts as its
  // owner in that drive); an explicit role is an opt-in downgrade.
  drives: z.array(z.object({
    id: z.string(),
    role: z.enum(['ADMIN', 'MEMBER']).nullish(),
    customRoleId: z.string().optional(),
  })).optional(),
}).refine(d => !(d.drives && d.driveIds), { message: 'Provide drives or driveIds, not both' });

// POST: Create a new MCP token
export async function POST(req: NextRequest) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  try {
    const body = await req.json();
    const { name, driveIds: rawDriveIds, drives: rawDrives } = createTokenSchema.parse(body);

    const driveScopes = (rawDrives
      ?? (rawDriveIds ?? []).map(id => ({ id, role: null, customRoleId: undefined }))
    ).map(scope => ({ ...scope, role: scope.role ?? null }));
    const uniqueDriveScopes = [...new Map(driveScopes.map(d => [d.id, d])).values()];

    if (uniqueDriveScopes.length > 0) {
      const { invalidDriveIds, unauthorizedRoles, invalidCustomRoles, unauthorizedCustomRoles } =
        await validateDriveScopeAccess(uniqueDriveScopes, userId);

      if (invalidDriveIds.length > 0) {
        return NextResponse.json(
          { error: 'You do not have access to these drives: ' + invalidDriveIds.join(', ') },
          { status: 403 }
        );
      }
      if (unauthorizedRoles.length > 0) {
        return NextResponse.json(
          { error: 'You do not have permission to grant ADMIN role in these drives: ' + unauthorizedRoles.join(', ') },
          { status: 403 }
        );
      }
      if (invalidCustomRoles.length > 0) {
        return NextResponse.json(
          { error: 'Custom role does not belong to the specified drive: ' + invalidCustomRoles.join(', ') },
          { status: 400 }
        );
      }
      if (unauthorizedCustomRoles.length > 0) {
        return NextResponse.json(
          { error: 'You may only mint tokens with your own assigned custom role in these drives: ' + unauthorizedCustomRoles.join(', ') },
          { status: 403 }
        );
      }
    }

    const { token: rawToken, hash: tokenHash, tokenPrefix } = generateToken('mcp');

    // Determine if this token is scoped (fail-closed security)
    const isScoped = uniqueDriveScopes.length > 0;

    // Use transaction to ensure token and drive scopes are created atomically
    const newToken = await sessionRepository.createMcpTokenWithDriveScopes({
      userId,
      tokenHash,
      tokenPrefix,
      name,
      isScoped,
      drives: uniqueDriveScopes,
    });

    // Fetch drive names for consistent response format with GET
    let driveScopeNames: { id: string; name: string }[] = [];
    if (uniqueDriveScopes.length > 0) {
      driveScopeNames = await sessionRepository.findDrivesByIds(uniqueDriveScopes.map(d => d.id));
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
      driveScopes: driveScopeNames,
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