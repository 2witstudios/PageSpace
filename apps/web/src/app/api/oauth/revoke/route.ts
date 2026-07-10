/**
 * OAuth 2.1 token revocation endpoint (RFC 7009; Phase 1 task
 * qyqgrjbvntpsdh578k0yiwgr). A thin shell: parses the form-encoded request,
 * resolves the client, and delegates the actual revocation to
 * `revokeOAuthToken`, which decides refresh-vs-access-token semantics.
 *
 * Zero-trust posture: an unknown token, a token belonging to a different
 * client, an already-revoked token, or an unknown client_id ALL produce the
 * SAME 200 response with an empty body — revocation endpoints never confirm
 * token existence (RFC 7009 §2.2: "the authorization server responds with
 * HTTP status code 200 if the token has been revoked successfully or if the
 * client submitted an invalid token"). Only malformed requests (missing
 * `token` or `client_id`) get a distinct `invalid_request`, matching the
 * token endpoint's precedent for malformed syntax vs credential-shaped
 * rejections.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getRegisteredClient } from '@pagespace/lib/auth/oauth/clients';
import { ensureOAuthClientRow, revokeOAuthToken } from '@/lib/repositories/oauth-repository';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { getClientIP } from '@pagespace/lib/security/client-ip';

function noStoreJson(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function noStoreEmpty(): NextResponse {
  return new NextResponse(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}

const INVALID_REQUEST = { error: 'invalid_request' };

export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/x-www-form-urlencoded')) {
    return noStoreJson(INVALID_REQUEST, 400);
  }

  const form = new URLSearchParams(await req.text());
  const token = form.get('token');
  const clientId = form.get('client_id');

  if (!token || !clientId) {
    return noStoreJson(INVALID_REQUEST, 400);
  }

  // Unauthenticated by protocol (RFC 7009 forbids an oracle on outcome, so
  // there's no credential to gate on) — per-IP + per-claimed-client is the
  // only defense against endpoint flooding.
  const ip = getClientIP(req);
  const [ipLimit, clientLimit] = await Promise.all([
    checkDistributedRateLimit(`oauth-revoke:ip:${ip}`, DISTRIBUTED_RATE_LIMITS.OAUTH_REVOKE),
    checkDistributedRateLimit(`oauth-revoke:client:${clientId}`, DISTRIBUTED_RATE_LIMITS.OAUTH_REVOKE),
  ]);
  if (!ipLimit.allowed || !clientLimit.allowed) {
    auditRequest(req, {
      eventType: 'security.rate.limited',
      details: { clientId, oauthEvent: 'revoke_rate_limited' },
    });
    return noStoreJson({ error: 'rate_limited', retryAfter: Math.max(ipLimit.retryAfter ?? 0, clientLimit.retryAfter ?? 0) }, 429);
  }

  const client = getRegisteredClient(clientId);
  if (!client) {
    // No oracle: an unknown client_id is indistinguishable from an unknown token.
    return noStoreEmpty();
  }

  const clientDbId = await ensureOAuthClientRow(client);
  await revokeOAuthToken({ token, clientDbId, now: new Date() });

  auditRequest(req, {
    eventType: 'auth.token.revoked',
    details: { clientId: client.clientId, oauthEvent: 'revoke' },
  });

  return noStoreEmpty();
}
