import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { sessionRepository } from '@/lib/repositories/session-repository';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getActorInfo, logTokenActivity } from '@pagespace/lib/monitoring/activity-logger';
import { normalizeDriveScopes, computeMcpTokenActionBinding } from '@pagespace/lib/auth/mcp-token-scopes';
import { validateDriveScopeAccess } from '@pagespace/lib/services/drive-service';
import { rejectScopedOAuth } from '../scope-guard';
import { requireStepUpGrant } from '../step-up-gate';

// 'oauth' lets the pagespace CLI (`pagespace keys revoke`) authenticate
// with an OAuth access token instead of a session cookie. Revocation only
// ever narrows access, so it stays outside the step-up gate below — see
// the sibling mcp-tokens/route.ts for the read/write route this pairs with.
const AUTH_OPTIONS_DELETE = { allow: ['session', 'oauth'] as const, requireCSRF: true };

// PATCH widens an EXISTING mcp_* token's drive scopes — architecturally the
// same escalation shape as POST /api/auth/mcp-tokens (Phase 8 credential
// minting security correction), so it gets the same session-only + step-up
// gate and drops 'oauth' bearer auth entirely.
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
  // Required at runtime (checked explicitly below, not via zod — no .min(1)
  // either, so an empty string fails the same falsy check a missing field
  // does) so a request missing only this field still reports the SAME
  // validation errors on drives/driveIds it always has — no separate error
  // shape leaks whether a caller forgot the step-up token specifically.
  stepUpToken: z.string().optional(),
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
    const { drives: rawDrives, driveIds: rawDriveIds, stepUpToken } = parsed.data;

    // Normalize using pure function
    const driveScopes = normalizeDriveScopes(rawDrives, rawDriveIds);

    // Step-up gate (Phase 8): widening an existing token's drive scopes is a
    // credential escalation, same as minting a new one — require a live
    // step-up grant bound to exactly this tokenId + target scopes before
    // anything is read or written. `name: tokenId` reuses the mint binding
    // helper's identifying-string slot to scope the grant to this token.
    const stepUpRejection = await requireStepUpGrant({
      req,
      userId,
      stepUpToken,
      actionBinding: computeMcpTokenActionBinding({ op: 'update', name: tokenId, driveScopes }),
      missingReason: 'mcp_token_update_missing_step_up',
      invalidReason: 'mcp_token_update_step_up_invalid',
    });
    if (stepUpRejection) return stepUpRejection;

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