import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { sessionRepository } from '@/lib/repositories/session-repository';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getActorInfo, logTokenActivity } from '@pagespace/lib/monitoring/activity-logger';
import { normalizeDriveScopes } from '@pagespace/lib/auth/mcp-token-scopes';
import { validateDriveScopeAccess } from '@pagespace/lib/services/drive-service';
import { rejectScopedOAuth } from '../scope-guard';

// 'oauth' lets the pagespace CLI (`pagespace keys revoke`) authenticate
// with an OAuth access token instead of a session cookie. Revocation only
// ever narrows access — see the sibling mcp-tokens/route.ts for the
// read/write route this pairs with.
const AUTH_OPTIONS_DELETE = { allow: ['session', 'oauth'] as const, requireCSRF: true };

// PATCH widens an EXISTING mcp_* token's drive scopes. Session-only — the
// CLI has no session cookie and never reaches this route; it acquires new
// scopes exclusively through the separate OAuth authorize/consent flow
// (`/api/oauth/authorize`), which has its own step-up gate. This route only
// serves the web UI's own already-authenticated "Edit scope" button.
const AUTH_OPTIONS_PATCH = { allow: ['session'] as const, requireCSRF: true };

// Schema for PATCH (editing drive scopes on an existing token)
const updateTokenScopesSchema = z.object({
  // Legacy: plain drive IDs — scope only, role inherits from owner
  driveIds: z.array(z.string()).optional(),
  // Preferred: per-drive scope with optional role downgrade
  drives: z.array(z.object({
    id: z.string(),
    role: z.enum(['ADMIN', 'MEMBER']).nullish(),
    customRoleId: z.string().optional(),
  })).optional(),
}).refine(d => !(d.drives && d.driveIds), {
  message: 'Provide drives or driveIds, not both',
}).refine(d => d.drives !== undefined || d.driveIds !== undefined, {
  message: 'Provide drives or driveIds',
});

// DELETE: Revoke an MCP token
export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ tokenId: string }> }
) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_DELETE);
  if (isAuthError(auth)) return auth.error;
  const scopeRejection = rejectScopedOAuth(auth);
  if (scopeRejection) return scopeRejection;
  const userId = auth.userId;

  const { tokenId } = await context.params;

  try {
    // Get the token first to capture its name for the audit log
    const existingToken = await sessionRepository.findMcpTokenByIdAndUser(tokenId, userId);

    if (!existingToken) {
      return NextResponse.json({ error: 'Token not found' }, { status: 404 });
    }

    // Verify the token belongs to the user and revoke it
    await sessionRepository.revokeMcpToken(tokenId, userId);

    // Log activity for audit trail (token revocation is a security event)
    const actorInfo = await getActorInfo(userId);
    logTokenActivity(userId, 'token_revoke', {
      tokenId,
      tokenType: 'mcp',
      tokenName: existingToken.name,
    }, actorInfo);
    auditRequest(req, { eventType: 'auth.token.revoked', userId, details: { tokenType: 'mcp', reason: 'user_revoked' } });

    return NextResponse.json({ message: 'Token revoked successfully' });
  } catch (error) {
    loggers.auth.error('Error revoking MCP token:', error as Error);
    return NextResponse.json({ error: 'Failed to revoke MCP token' }, { status: 500 });
  }
}

// PATCH: Update drive scopes on an existing MCP token
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ tokenId: string }> }
) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_PATCH);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const { tokenId } = await context.params;

  try {
    const body = await req.json();
    const parsed = updateTokenScopesSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }
    const { drives: rawDrives, driveIds: rawDriveIds } = parsed.data;

    // Normalize using pure function
    const driveScopes = normalizeDriveScopes(rawDrives, rawDriveIds);

    // Ownership check — token must belong to the requesting user
    const existingToken = await sessionRepository.findMcpTokenByIdAndUser(tokenId, userId);
    if (!existingToken) {
      return NextResponse.json({ error: 'Token not found' }, { status: 404 });
    }

    // Validate drive access for each scope (same logic as POST /create)
    if (driveScopes.length > 0) {
      const { invalidDriveIds, unauthorizedRoles, invalidCustomRoles, unauthorizedCustomRoles } =
        await validateDriveScopeAccess(driveScopes, userId);

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
          { error: 'You may only use your own assigned custom role in these drives: ' + unauthorizedCustomRoles.join(', ') },
          { status: 403 }
        );
      }
    }

    // Update drive scopes transactionally
    await sessionRepository.updateMcpTokenDriveScopes(tokenId, userId, driveScopes);

    // Fetch drive names for response
    let driveScopeNames: { id: string; name: string }[] = [];
    if (driveScopes.length > 0) {
      driveScopeNames = await sessionRepository.findDrivesByIds(driveScopes.map(d => d.id));
    }

    // Log activity for audit trail
    const actorInfo = await getActorInfo(userId);
    logTokenActivity(userId, 'token_update', {
      tokenId,
      tokenType: 'mcp',
      tokenName: existingToken.name,
    }, actorInfo);
    auditRequest(req, { eventType: 'auth.token.updated', userId, details: { tokenType: 'mcp', driveCount: driveScopes.length } });

    return NextResponse.json({
      id: tokenId,
      name: existingToken.name,
      driveScopes: driveScopeNames,
    });
  } catch (error) {
    loggers.auth.error('Error updating MCP token:', error as Error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to update MCP token' }, { status: 500 });
  }
}