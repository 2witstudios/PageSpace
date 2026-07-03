/**
 * OAuth 2.1 authorization endpoint (RFC 6749 §4.1.1) + consent decision
 * (Phase 1 task 6, epic page ea07mt5jvw0flihsbjce1iv9, ADR 0002).
 *
 * GET validates the request and either renders an error page (unknown
 * client / unregistered redirect_uri — never a redirect, that's the classic
 * open-redirect vulnerability), redirects to `redirect_uri?error=...` (every
 * other rejection, only once redirect_uri itself is trusted), redirects to
 * sign-in (no session), or redirects to the consent screen.
 *
 * POST is the consent screen's approve/deny decision: session + CSRF
 * required, re-validates the entire request server-side (never trusts that
 * a prior GET validated it), enforces the same grant-authority caps as
 * mcp-tokens minting (ADR 0002 Decision 2), and returns the redirect target
 * as JSON — the consent page's client component performs the actual
 * top-level browser navigation, since redirect_uri is an arbitrary loopback
 * origin `fetch()` cannot navigate to directly.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  validateAuthorizeRequest,
  type AuthorizeRequestParams,
} from '@pagespace/lib/auth/oauth/authorize-request';
import { getRegisteredClient } from '@pagespace/lib/auth/oauth/clients';
import { checkGrantAuthority, formatScopeSet, type GrantAuthority } from '@pagespace/lib/auth/oauth/scopes';
import { AUTHORIZATION_CODE_TTL_SECONDS } from '@pagespace/lib/auth/oauth/code-lifecycle';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import { getDriveAccess } from '@pagespace/lib/services/drive-service';
import { customRoleBelongsToDrive, getMemberCustomRoleId } from '@pagespace/lib/permissions/membership-queries';
import { ensureOAuthClientRow, createAuthorizationCode } from '@/lib/repositories/oauth-repository';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

function extractParams(searchParams: URLSearchParams): AuthorizeRequestParams {
  return {
    clientId: searchParams.get('client_id') ?? undefined,
    redirectUri: searchParams.get('redirect_uri') ?? undefined,
    responseType: searchParams.get('response_type') ?? undefined,
    codeChallenge: searchParams.get('code_challenge') ?? undefined,
    codeChallengeMethod: searchParams.get('code_challenge_method') ?? undefined,
    scope: searchParams.get('scope') ?? undefined,
    state: searchParams.get('state') ?? undefined,
  };
}

function renderErrorPage(message: string): NextResponse {
  return new NextResponse(
    `<!doctype html><html><head><title>Authorization error</title></head><body><h1>Authorization error</h1><p>${message}</p></body></html>`,
    { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

function buildRedirectWithParams(redirectUri: string, params: Record<string, string | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

export async function GET(req: NextRequest) {
  const { searchParams, search } = new URL(req.url);
  const params = extractParams(searchParams);
  const client = params.clientId ? getRegisteredClient(params.clientId) : null;
  const result = validateAuthorizeRequest(params, client);

  if (!result.ok) {
    if (result.kind === 'no_redirect') {
      return renderErrorPage(
        result.error === 'invalid_client' ? 'Unknown client.' : 'Invalid or unregistered redirect_uri.',
      );
    }
    return NextResponse.redirect(
      buildRedirectWithParams(result.redirectUri, { error: result.error, state: result.state }),
      302,
    );
  }

  const auth = await authenticateRequestWithOptions(req, { allow: ['session'], requireCSRF: false });
  const consentTarget = `/oauth/consent${search}`;

  if (isAuthError(auth)) {
    return NextResponse.redirect(
      new URL(`/auth/signin?next=${encodeURIComponent(consentTarget)}`, req.url),
      302,
    );
  }

  return NextResponse.redirect(new URL(consentTarget, req.url), 302);
}

const approvalSchema = z.object({
  clientId: z.string(),
  redirectUri: z.string(),
  responseType: z.string(),
  codeChallenge: z.string(),
  codeChallengeMethod: z.string(),
  scope: z.string(),
  state: z.string().optional(),
  action: z.enum(['approve', 'deny']),
});

export async function POST(req: NextRequest) {
  const auth = await authenticateRequestWithOptions(req, { allow: ['session'], requireCSRF: true });
  if (isAuthError(auth)) return auth.error;

  let body: z.infer<typeof approvalSchema>;
  try {
    body = approvalSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const params: AuthorizeRequestParams = {
    clientId: body.clientId,
    redirectUri: body.redirectUri,
    responseType: body.responseType,
    codeChallenge: body.codeChallenge,
    codeChallengeMethod: body.codeChallengeMethod,
    scope: body.scope,
    state: body.state,
  };
  const client = getRegisteredClient(body.clientId);
  const result = validateAuthorizeRequest(params, client);

  if (!result.ok) {
    if (result.kind === 'no_redirect') {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    return NextResponse.json({
      redirectUri: buildRedirectWithParams(result.redirectUri, { error: result.error, state: result.state }),
    });
  }

  if (body.action === 'deny') {
    auditRequest(req, {
      eventType: 'authz.access.denied',
      userId: auth.userId,
      details: { clientId: result.client.clientId, oauthEvent: 'consent_denied' },
    });
    return NextResponse.json({
      redirectUri: buildRedirectWithParams(result.redirectUri, { error: 'access_denied', state: result.state }),
    });
  }

  // Consent = minting: enforce the same authority caps as mcp-tokens (ADR 0002
  // Decision 2). Any violation rejects the entire request — no partial grant,
  // uniform `invalid_scope` (no oracle distinguishing "no access" from "role
  // not grantable" on an endpoint reachable pre-consent by arbitrary clients).
  const authorityMap = new Map<string, GrantAuthority extends ReadonlyMap<string, infer V> ? V : never>();
  for (const [driveId, scope] of result.scopes.drives) {
    const access = await getDriveAccess(driveId, auth.userId);
    const ownCustomRoleId = await getMemberCustomRoleId(driveId, auth.userId);
    const customRoleOk =
      scope.role.kind === 'custom' ? await customRoleBelongsToDrive(scope.role.customRoleId, driveId) : true;

    authorityMap.set(driveId, {
      isOwner: access.isOwner,
      isMember: access.isMember,
      isAdmin: access.isAdmin,
      ownCustomRoleId,
      roleBelongsToDrive: () => customRoleOk,
    });
  }

  const authority = checkGrantAuthority(result.scopes, authorityMap);
  if (!authority.ok) {
    return NextResponse.json({
      redirectUri: buildRedirectWithParams(result.redirectUri, { error: 'invalid_scope', state: result.state }),
    });
  }

  const clientDbId = await ensureOAuthClientRow(result.client);
  const { token: code, hash: codeHash, tokenPrefix: codePrefix } = generateToken('ps_ac');
  const expiresAt = new Date(Date.now() + AUTHORIZATION_CODE_TTL_SECONDS * 1000);

  await createAuthorizationCode({
    clientDbId,
    userId: auth.userId,
    redirectUri: result.redirectUri,
    codeChallenge: result.codeChallenge,
    codeChallengeMethod: 'S256',
    scopes: formatScopeSet(result.scopes).split(' ').filter(Boolean),
    codeHash,
    codePrefix,
    expiresAt,
  });

  auditRequest(req, {
    eventType: 'authz.access.granted',
    userId: auth.userId,
    details: { clientId: result.client.clientId, oauthEvent: 'consent_approved' },
  });

  return NextResponse.json({
    redirectUri: buildRedirectWithParams(result.redirectUri, { code, state: result.state }),
  });
}
