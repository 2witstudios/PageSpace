/**
 * OAuth 2.1 token endpoint — authorization_code + PKCE grant (RFC 6749
 * §3.2, §4.1.3, §5.1; task suty9f9jbha82c0831e9rjec) and refresh_token grant
 * with rotation + reuse detection (RFC 6749 §6; ADR 0003 §3.3-3.4; task
 * l8zlp3353f2cunjd33foq41l). A thin shell: it parses the form-encoded
 * request, resolves the client, and delegates the entire grant decision to
 * `exchangeAuthorizationCode` / `refreshTokenGrant`, which in turn call the
 * pure decision functions (`decideCodeExchange`, `decideRefreshRotation`) —
 * no grant logic is reimplemented here.
 *
 * Zero-trust posture: every grant-validity rejection — unknown client,
 * unknown/expired/already-consumed code, redirect_uri mismatch, PKCE
 * failure, malformed client authentication, unknown/expired/revoked/reused
 * refresh token — returns the SAME constant-shape body
 * (`{"error": "invalid_grant"}`, or `"invalid_request"` for malformed
 * syntax) with `Cache-Control: no-store`. No response ever differentiates
 * one failure reason from another; that differentiation is exactly the
 * error oracle OAuth 2.1's fail-closed posture forbids. `invalid_scope` is
 * the one deliberate exception: it only fires once the presented refresh
 * token has already proven valid, so naming it leaks nothing about the
 * credential itself.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getRegisteredClient, type RegisteredClient } from '@pagespace/lib/auth/oauth/clients';
import { ACCESS_TOKEN_TTL_SECONDS } from '@pagespace/lib/auth/oauth/issue-tokens';
import {
  ensureOAuthClientRow,
  exchangeAuthorizationCode,
  refreshTokenGrant,
} from '@/lib/repositories/oauth-repository';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

function noStoreJson(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

const INVALID_REQUEST = { error: 'invalid_request' };
const INVALID_GRANT = { error: 'invalid_grant' };
const INVALID_SCOPE = { error: 'invalid_scope' };

type ResolvedClient = { client: RegisteredClient; clientDbId: string };
type ClientResolution = ResolvedClient | { rejection: NextResponse };

/**
 * Resolve and validate the requesting client — shared by both grants.
 * Unknown client_id and a public client presenting a client_secret are the
 * SAME two rejections (`invalid_grant` / `invalid_request`) either grant
 * produces; one guard, not two divergent copies.
 */
async function resolveClient(form: URLSearchParams, clientId: string): Promise<ClientResolution> {
  const client = getRegisteredClient(clientId);
  if (!client) {
    return { rejection: noStoreJson(INVALID_GRANT, 400) };
  }

  // Public-client confusion guard: the CLI is a public client (ADR 0003) —
  // it never has a secret, and a request presenting one is rejected outright
  // rather than silently ignored.
  const clientSecret = form.get('client_secret');
  if (client.type === 'public' && clientSecret) {
    return { rejection: noStoreJson(INVALID_REQUEST, 400) };
  }

  const clientDbId = await ensureOAuthClientRow(client);
  return { client, clientDbId };
}

async function handleAuthorizationCodeGrant(req: NextRequest, form: URLSearchParams): Promise<NextResponse> {
  const code = form.get('code');
  const redirectUri = form.get('redirect_uri');
  const clientId = form.get('client_id');
  const codeVerifier = form.get('code_verifier');

  if (!code || !redirectUri || !clientId || !codeVerifier) {
    return noStoreJson(INVALID_REQUEST, 400);
  }

  const resolved = await resolveClient(form, clientId);
  if ('rejection' in resolved) return resolved.rejection;
  const { client, clientDbId } = resolved;

  const result = await exchangeAuthorizationCode({
    code,
    redirectUri,
    codeVerifier,
    clientDbId,
    now: new Date(),
  });

  if (result.outcome !== 'ok') {
    auditRequest(req, {
      eventType: 'authz.access.denied',
      details: { clientId: client.clientId, oauthEvent: 'code_exchange_rejected' },
    });
    return noStoreJson(INVALID_GRANT, 400);
  }

  auditRequest(req, {
    eventType: 'auth.token.created',
    userId: result.userId,
    details: { clientId: client.clientId, oauthEvent: 'code_exchange' },
  });

  return noStoreJson(
    {
      access_token: result.tokens.accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: result.tokens.refreshToken,
      scope: result.scopes.join(' '),
    },
    200,
  );
}

async function handleRefreshTokenGrant(req: NextRequest, form: URLSearchParams): Promise<NextResponse> {
  const refreshToken = form.get('refresh_token');
  const clientId = form.get('client_id');

  if (!refreshToken || !clientId) {
    return noStoreJson(INVALID_REQUEST, 400);
  }

  const resolved = await resolveClient(form, clientId);
  if ('rejection' in resolved) return resolved.rejection;
  const { client, clientDbId } = resolved;

  const result = await refreshTokenGrant({
    refreshToken,
    clientDbId,
    requestedScope: form.get('scope'),
    now: new Date(),
  });

  if (result.outcome === 'invalid_scope') {
    auditRequest(req, {
      eventType: 'authz.access.denied',
      details: { clientId: client.clientId, oauthEvent: 'refresh_scope_escalation' },
    });
    return noStoreJson(INVALID_SCOPE, 400);
  }

  if (result.outcome !== 'ok') {
    auditRequest(req, {
      eventType: 'authz.access.denied',
      details: { clientId: client.clientId, oauthEvent: 'refresh_rejected' },
    });
    return noStoreJson(INVALID_GRANT, 400);
  }

  auditRequest(req, {
    eventType: 'auth.token.created',
    userId: result.userId,
    details: { clientId: client.clientId, oauthEvent: 'refresh_rotated' },
  });

  return noStoreJson(
    {
      access_token: result.tokens.accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: result.tokens.refreshToken,
      scope: result.scopes.join(' '),
    },
    200,
  );
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/x-www-form-urlencoded')) {
    return noStoreJson(INVALID_REQUEST, 400);
  }

  const form = new URLSearchParams(await req.text());
  const grantType = form.get('grant_type');

  if (grantType === 'authorization_code') {
    return handleAuthorizationCodeGrant(req, form);
  }
  if (grantType === 'refresh_token') {
    return handleRefreshTokenGrant(req, form);
  }

  return noStoreJson({ error: 'unsupported_grant_type' }, 400);
}
