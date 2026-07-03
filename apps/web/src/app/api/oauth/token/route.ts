/**
 * OAuth 2.1 token endpoint — authorization_code + PKCE grant (RFC 6749
 * §3.2, §4.1.3, §5.1; task suty9f9jbha82c0831e9rjec). A thin shell: it
 * parses the form-encoded request, resolves the client, and delegates the
 * entire grant decision to `exchangeAuthorizationCode`, which in turn calls
 * `decideCodeExchange` (task 4) — no grant logic is reimplemented here.
 *
 * Zero-trust posture: every rejection — unknown client, unknown/expired/
 * already-consumed code, redirect_uri mismatch, PKCE failure, malformed
 * client authentication — returns the SAME constant-shape body
 * (`{"error": "invalid_grant"}`, or `"invalid_request"` for malformed
 * syntax) with `Cache-Control: no-store`. No response ever differentiates
 * one failure reason from another; that differentiation is exactly the
 * error oracle OAuth 2.1's fail-closed posture forbids.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getRegisteredClient } from '@pagespace/lib/auth/oauth/clients';
import { ACCESS_TOKEN_TTL_SECONDS } from '@pagespace/lib/auth/oauth/issue-tokens';
import { ensureOAuthClientRow, exchangeAuthorizationCode } from '@/lib/repositories/oauth-repository';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

function noStoreJson(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

const INVALID_REQUEST = { error: 'invalid_request' };
const INVALID_GRANT = { error: 'invalid_grant' };

export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/x-www-form-urlencoded')) {
    return noStoreJson(INVALID_REQUEST, 400);
  }

  const form = new URLSearchParams(await req.text());
  const grantType = form.get('grant_type');
  if (grantType !== 'authorization_code') {
    return noStoreJson({ error: 'unsupported_grant_type' }, 400);
  }

  const code = form.get('code');
  const redirectUri = form.get('redirect_uri');
  const clientId = form.get('client_id');
  const codeVerifier = form.get('code_verifier');
  const clientSecret = form.get('client_secret');

  if (!code || !redirectUri || !clientId || !codeVerifier) {
    return noStoreJson(INVALID_REQUEST, 400);
  }

  const client = getRegisteredClient(clientId);
  if (!client) {
    return noStoreJson(INVALID_GRANT, 400);
  }

  // Public-client confusion guard: the CLI is a public client (ADR 0003) —
  // it never has a secret, and a request presenting one is rejected outright
  // rather than silently ignored.
  if (client.type === 'public' && clientSecret) {
    return noStoreJson(INVALID_REQUEST, 400);
  }

  const clientDbId = await ensureOAuthClientRow(client);

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
