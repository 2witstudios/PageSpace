import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { OAUTH_ACCESS_TOKEN_PREFIX } from '@/lib/auth/token-prefixes';
import { resolveCallerCredential } from '@/lib/agent-auth/caller-credential';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { sessionRepository } from '@/lib/repositories/session-repository';
import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getActorInfo, logTokenActivity } from '@pagespace/lib/monitoring/activity-logger';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import { validateDriveScopeAccess } from '@pagespace/lib/services/drive-service';
import { rejectScopedOAuth } from './scope-guard';

// 'oauth' lets the pagespace CLI (which never holds a session cookie —
// `pagespace keys list` authenticates with an OAuth access token from
// `pagespace login`) call GET directly. CSRF is already skipped for
// Bearer-token auth (`authenticateRequestWithOptions`), so this is not a
// CSRF-relevant change. Minting (POST) is for a session — the web UI's own
// already-authenticated "Create Token" button; the CLI mints through the
// OAuth authorize/consent flow (`/api/oauth/authorize`) with its own step-up
// gate — plus ONE bearer: an AI agent's own account-scoped access token
// minted by the pagespace-agent jwt-bearer grant (ADR 0007 Decision 6, agents
// mint mcp_ keys; `classifyCallerCredential`). A headless agent has no
// session and no browser, so without this it could never obtain a content
// credential. Every other OAuth token — every human's, a token the agent gave
// another client, a narrow scope — gets exactly the refusal a bearer has
// always had here. CSRF still applies to sessions only.
const AUTH_OPTIONS_READ = { allow: ['session', 'oauth'] as const, requireCSRF: false };
const AUTH_OPTIONS_MINT = { allow: ['session', 'oauth'] as const, requireCSRF: true };

// An agent's live mcp_ keys are capped: AGENT_KEY_MINT bounds the RATE, this
// bounds how many a leaked agent secret could stockpile before the owner
// revokes (revocation kills them all, but fewer live keys is less exposure).
// The session path is uncapped, as before.
const AGENT_MAX_LIVE_KEYS = 20;

/** The response a bearer token has always received from POST here (it was `allow: ['session']`). */
function oauthNotPermitted(): NextResponse {
  return NextResponse.json({ error: 'OAuth tokens are not permitted for this endpoint' }, { status: 401 });
}

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
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_MINT);
  if (isAuthError(auth)) {
    // An unusable ps_at_ gets the same answer as a usable non-agent one: no new
    // oracle on OAuth token validity from a route that never accepted them.
    return req.headers.get('authorization')?.startsWith(`Bearer ${OAUTH_ACCESS_TOKEN_PREFIX}`) ? oauthNotPermitted() : auth.error;
  }
  const userId = auth.userId;

  // The agent path (ADR 0007 D6). Everything after this block is the session
  // path's own scoping, applied to the caller — no second scoping rule.
  const viaAgent = auth.tokenType !== 'session';
  const refuseAgent = (reason: string) => {
    if (viaAgent) auditRequest(req, { eventType: 'authz.access.denied', userId, resourceType: 'mcp_token', details: { method: 'agent', reason } });
  };
  if (viaAgent) {
    if ((await resolveCallerCredential(auth)) !== 'agent_grant_token') {
      refuseAgent('not_agent_grant_credential');
      return oauthNotPermitted();
    }
    const limit = await checkDistributedRateLimit(`agent-key-mint:user:${userId}`, DISTRIBUTED_RATE_LIMITS.AGENT_KEY_MINT);
    if (!limit.allowed) {
      auditRequest(req, { eventType: 'security.rate.limited', userId, resourceType: 'mcp_token', details: { method: 'agent' } });
      const retryAfter = Math.max(0, Math.ceil(limit.retryAfter ?? 0));
      return NextResponse.json({ error: 'rate_limited', retryAfter }, { status: 429, headers: { 'Retry-After': String(retryAfter) } });
    }
    if ((await sessionRepository.countActiveMcpTokens(userId)) >= AGENT_MAX_LIVE_KEYS) {
      refuseAgent('live_key_limit');
      return NextResponse.json({ error: 'key_limit_reached', limit: AGENT_MAX_LIVE_KEYS }, { status: 409 });
    }
  }

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
        refuseAgent('invalid_drive_scope');
        return NextResponse.json(
          { error: 'You do not have access to these drives: ' + invalidDriveIds.join(', ') },
          { status: 403 }
        );
      }
      if (unauthorizedRoles.length > 0) {
        refuseAgent('unauthorized_role');
        return NextResponse.json(
          { error: 'You do not have permission to grant ADMIN role in these drives: ' + unauthorizedRoles.join(', ') },
          { status: 403 }
        );
      }
      if (invalidCustomRoles.length > 0) {
        refuseAgent('invalid_custom_role');
        return NextResponse.json(
          { error: 'Custom role does not belong to the specified drive: ' + invalidCustomRoles.join(', ') },
          { status: 400 }
        );
      }
      if (unauthorizedCustomRoles.length > 0) {
        refuseAgent('unauthorized_custom_role');
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
    auditRequest(req, { eventType: 'auth.token.created', userId, details: { tokenType: 'mcp', ...(viaAgent ? { method: 'agent' } : {}) } });

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
      refuseAgent('invalid_request');
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to create MCP token' }, { status: 500 });
  }
}

// GET: List user's MCP tokens (without the actual token values)
export async function GET(req: NextRequest) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const scopeRejection = rejectScopedOAuth(auth);
  if (scopeRejection) return scopeRejection;
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