/**
 * OAuth 2.1 token endpoint — authorization_code + PKCE grant (RFC 6749
 * §3.2, §4.1.3, §5.1; task suty9f9jbha82c0831e9rjec), refresh_token grant
 * with rotation + reuse detection (RFC 6749 §6; ADR 0003 §3.3-3.4; task
 * l8zlp3353f2cunjd33foq41l), and device_code grant polling (RFC 8628 §3.4-3.5;
 * task mwexjazwha2uhw5bmvc9a7kw). A thin shell: it parses the form-encoded
 * request, resolves the client, and delegates the entire grant decision to
 * `exchangeAuthorizationCode` / `refreshTokenGrant` / `pollDeviceToken`, which
 * in turn call the pure decision functions (`decideCodeExchange`,
 * `decideRefreshRotation`, `decideDevicePoll`) — no grant logic is
 * reimplemented here.
 *
 * Zero-trust posture: every grant-validity rejection on the code/refresh
 * grants — unknown client, unknown/expired/already-consumed code,
 * redirect_uri mismatch, PKCE failure, malformed client authentication,
 * unknown/expired/revoked/reused refresh token — returns the SAME
 * constant-shape body (`{"error": "invalid_grant"}`, or `"invalid_request"`
 * for malformed syntax) with `Cache-Control: no-store`. No response ever
 * differentiates one failure reason from another; that differentiation is
 * exactly the error oracle OAuth 2.1's fail-closed posture forbids.
 * `invalid_scope` is one deliberate exception on the refresh grant: it only
 * fires once the presented refresh token has already proven valid, so naming
 * it leaks nothing about the credential itself. The device_code grant is the
 * OTHER deliberate exception, by protocol design rather than by leak: RFC
 * 8628 §3.5 requires the polling CLI to distinguish authorization_pending /
 * slow_down / expired_token / access_denied so it knows whether to keep
 * polling, back off, or tell the user to restart — only an unrecognized
 * device_code falls back to the shared invalid_grant.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getClientIP } from '@/lib/auth';
import { getRegisteredClient, type RegisteredClient } from '@pagespace/lib/auth/oauth/clients';
import { ACCESS_TOKEN_TTL_SECONDS, type IssuedTokenPair } from '@pagespace/lib/auth/oauth/issue-tokens';
import {
  ensureOAuthClientRow,
  exchangeAuthorizationCode,
  refreshTokenGrant,
  pollDeviceToken,
} from '@/lib/repositories/oauth-repository';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getActorInfo, logTokenActivity } from '@pagespace/lib/monitoring/activity-logger';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';

function noStoreJson(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * RFC 6749 §5.1 success body for the two refresh-token-family grants
 * (authorization_code minting a NON-drive-scoped family, refresh_token,
 * device_code). `refresh_token` is `undefined` whenever F1 (ADR 0003,
 * offline_access gating) minted an access-only pair — `JSON.stringify` drops
 * `undefined`-valued keys, so the field is absent from the wire response
 * entirely, not merely null.
 */
function tokenSuccessBody(tokens: IssuedTokenPair, scopes: string[]): Record<string, unknown> {
  return {
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: tokens.refreshToken,
    scope: scopes.join(' '),
  };
}

/**
 * Success body for a pure drive:* authorization_code grant — deliberately
 * NOT an OAuth token pair. `exchangeAuthorizationCode`'s `ok_mcp_token`
 * outcome minted a real `mcp_tokens` row instead of a refresh-token family
 * (see `oauth-repository.ts`), so there is no `refresh_token`/`expires_in` to
 * report: an `mcp_*` token doesn't expire and has no separate refresh cycle.
 * `token_type: 'mcp'` is the CLI's signal (`exchange-code.ts`) to store this
 * as a static bearer credential, not an OAuth-refreshable one.
 */
function mcpTokenSuccessBody(mcpToken: string, scopes: string[]): Record<string, unknown> {
  return {
    access_token: mcpToken,
    token_type: 'mcp',
    scope: scopes.join(' '),
  };
}

/**
 * Success body for an `update_key` authorization_code grant — the exchange
 * applied an in-place re-scope of an existing `mcp_tokens` row
 * (`ok_mcp_update`, `oauth-repository.ts`) and minted NOTHING, so there is
 * deliberately no `access_token` of any kind here: returning the (unchanged)
 * secret would turn a scope edit into a secret-disclosure oracle. The CLI
 * needs only the PKCE-verified success signal plus the granted scope;
 * `token_type: 'mcp_update'` is its discriminator (`exchange-code.ts`), and
 * `token_id` names which key was re-scoped.
 */
function mcpUpdateSuccessBody(tokenId: string, scopes: string[]): Record<string, unknown> {
  return {
    token_type: 'mcp_update',
    token_id: tokenId,
    scope: scopes.join(' '),
  };
}

/**
 * Success body for an `activate_key` authorization_code grant — the exchange
 * verified ownership of the target key and changed NOTHING
 * (`ok_mcp_activate`, `oauth-repository.ts`). No secret of any kind is
 * returned: the PKCE-verified success signal is the whole product, telling
 * the requesting device (`pagespace keys use`) it may set the key as its
 * ambient default. `token_type: 'mcp_activate'` is the CLI's discriminator
 * (`exchange-code.ts`), and `token_id` names which key was approved.
 */
function mcpActivateSuccessBody(tokenId: string, scopes: string[]): Record<string, unknown> {
  return {
    token_type: 'mcp_activate',
    token_id: tokenId,
    scope: scopes.join(' '),
  };
}

const INVALID_REQUEST = { error: 'invalid_request' };
const INVALID_GRANT = { error: 'invalid_grant' };
const INVALID_SCOPE = { error: 'invalid_scope' };

/**
 * authorization_code + refresh_token grants both present a high-entropy
 * secret exactly once per legitimate use — real traffic is rare, so a tight
 * per-IP + per-client limit blunts brute-forcing a code/refresh token.
 * Returns a generic 429 (no oracle: rate-limiting isn't a credential-guessing
 * signal, unlike the grant's own invalid_grant/invalid_scope split).
 */
async function checkTokenExchangeRateLimit(req: NextRequest, clientId: string): Promise<NextResponse | null> {
  const ip = getClientIP(req);
  const [ipLimit, clientLimit] = await Promise.all([
    checkDistributedRateLimit(`oauth-token:exchange:ip:${ip}`, DISTRIBUTED_RATE_LIMITS.OAUTH_TOKEN_EXCHANGE),
    checkDistributedRateLimit(`oauth-token:exchange:client:${clientId}`, DISTRIBUTED_RATE_LIMITS.OAUTH_TOKEN_EXCHANGE),
  ]);
  if (ipLimit.allowed && clientLimit.allowed) return null;

  auditRequest(req, {
    eventType: 'security.rate.limited',
    details: { clientId, oauthEvent: 'token_exchange_rate_limited' },
  });
  return noStoreJson({ error: 'rate_limited', retryAfter: Math.max(ipLimit.retryAfter ?? 0, clientLimit.retryAfter ?? 0) }, 429);
}

/**
 * device_code polling is a distinct risk profile: RFC 8628 legitimate
 * traffic is ~1 poll per pollIntervalSeconds from a single flow, already
 * throttled per-device-code by decideDevicePoll's own slow_down. This is an
 * endpoint-level backstop against a client ignoring slow_down or scanning
 * device codes wholesale — set generous enough to never trip on real
 * traffic. Responds with the RFC 8628 slow_down contract, not a bare 429,
 * so a compliant polling client backs off instead of erroring out.
 */
async function checkDevicePollRateLimit(req: NextRequest, clientId: string): Promise<NextResponse | null> {
  const ip = getClientIP(req);
  const [ipLimit, clientLimit] = await Promise.all([
    checkDistributedRateLimit(`oauth-token:device_poll:ip:${ip}`, DISTRIBUTED_RATE_LIMITS.OAUTH_DEVICE_POLL),
    checkDistributedRateLimit(`oauth-token:device_poll:client:${clientId}`, DISTRIBUTED_RATE_LIMITS.OAUTH_DEVICE_POLL),
  ]);
  if (ipLimit.allowed && clientLimit.allowed) return null;

  auditRequest(req, {
    eventType: 'security.rate.limited',
    details: { clientId, oauthEvent: 'device_poll_rate_limited' },
  });
  return noStoreJson({ error: 'slow_down' }, 400);
}

type ResolvedClient = { client: RegisteredClient; clientDbId: string };
type ClientResolution = ResolvedClient | { rejection: NextResponse };

/**
 * Resolve and validate the requesting client — shared by all three grants.
 * Unknown client_id, a public client presenting a client_secret, and a grant
 * type outside the client's `allowedGrantTypes` (defined but previously
 * unenforced, `clients.ts:19`) all collapse to the SAME rejections
 * (`invalid_grant` / `invalid_request`) every grant produces; one guard, not
 * divergent copies per grant handler.
 */
async function resolveClient(form: URLSearchParams, clientId: string, grantType: string): Promise<ClientResolution> {
  const client = getRegisteredClient(clientId);
  if (!client) {
    return { rejection: noStoreJson(INVALID_GRANT, 400) };
  }

  if (!client.allowedGrantTypes.includes(grantType)) {
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

/**
 * The three key-shaped success outcomes, rendered identically no matter which
 * flow carried the grant. Both the loopback authorization-code exchange and
 * the RFC 8628 device poll produce them (the repository applies them through
 * one shared `applyKeyGrant`), and a client must not be able to tell the two
 * doors apart from the response body — so the serialization, the audit event
 * types, and the activity trail live here once rather than being mirrored per
 * handler. Returns `null` when the outcome is not key-shaped, leaving the
 * caller's own ok/error handling to run.
 *
 * `oauthEventPrefix` is the ONLY thing that differs between the two: the audit
 * detail records which door was used.
 */
function keyGrantSuccessResponse(
  req: NextRequest,
  clientId: string,
  result: { outcome: string; userId?: string; scopes?: string[]; mcpToken?: string; tokenId?: string },
  oauthEventPrefix: 'code_exchange' | 'device_poll',
): NextResponse | null {
  if (result.outcome === 'ok_mcp_token') {
    auditRequest(req, {
      eventType: 'auth.token.created',
      userId: result.userId,
      details: { clientId, oauthEvent: `${oauthEventPrefix}_mcp_token` },
    });
    return noStoreJson(mcpTokenSuccessBody(result.mcpToken!, result.scopes!), 200);
  }

  if (result.outcome === 'ok_mcp_update') {
    // Mirror the web Settings PATCH's audit + activity trail
    // (mcp-tokens/[tokenId]/route.ts) — same logical operation, different
    // door. Fire-and-forget end to end: getActorInfo does a user lookup +
    // PII decrypts, and it feeds only logTokenActivity (itself explicitly
    // never awaited), so none of it belongs on the response path.
    const userId = result.userId!;
    const tokenId = result.tokenId!;
    void getActorInfo(userId)
      .then((actorInfo) => {
        logTokenActivity(userId, 'token_update', { tokenId, tokenType: 'mcp' }, actorInfo);
      })
      .catch(() => {
        // Activity logging is best-effort; the audit event below is the durable record.
      });
    auditRequest(req, {
      eventType: 'auth.token.updated',
      userId,
      details: { clientId, oauthEvent: `${oauthEventPrefix}_mcp_update` },
    });
    return noStoreJson(mcpUpdateSuccessBody(tokenId, result.scopes!), 200);
  }

  if (result.outcome === 'ok_mcp_activate') {
    // Approval ceremony only — nothing was minted or changed, so this is an
    // access-granted audit event (not token.created/updated), and there is
    // no activity-trail write: the key row is untouched.
    auditRequest(req, {
      eventType: 'authz.access.granted',
      userId: result.userId,
      details: { clientId, oauthEvent: `${oauthEventPrefix}_mcp_activate` },
    });
    return noStoreJson(mcpActivateSuccessBody(result.tokenId!, result.scopes!), 200);
  }

  return null;
}

async function handleAuthorizationCodeGrant(req: NextRequest, form: URLSearchParams): Promise<NextResponse> {
  const code = form.get('code');
  const redirectUri = form.get('redirect_uri');
  const clientId = form.get('client_id');
  const codeVerifier = form.get('code_verifier');

  if (!code || !redirectUri || !clientId || !codeVerifier) {
    return noStoreJson(INVALID_REQUEST, 400);
  }

  const rateLimited = await checkTokenExchangeRateLimit(req, clientId);
  if (rateLimited) return rateLimited;

  const resolved = await resolveClient(form, clientId, 'authorization_code');
  if ('rejection' in resolved) return resolved.rejection;
  const { client, clientDbId } = resolved;

  const result = await exchangeAuthorizationCode({
    code,
    redirectUri,
    codeVerifier,
    clientDbId,
    now: new Date(),
  });

  const keyGrantResponse = keyGrantSuccessResponse(req, client.clientId, result, 'code_exchange');
  if (keyGrantResponse) return keyGrantResponse;

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

  return noStoreJson(tokenSuccessBody(result.tokens, result.scopes), 200);
}

async function handleRefreshTokenGrant(req: NextRequest, form: URLSearchParams): Promise<NextResponse> {
  const refreshToken = form.get('refresh_token');
  const clientId = form.get('client_id');

  if (!refreshToken || !clientId) {
    return noStoreJson(INVALID_REQUEST, 400);
  }

  const rateLimited = await checkTokenExchangeRateLimit(req, clientId);
  if (rateLimited) return rateLimited;

  const resolved = await resolveClient(form, clientId, 'refresh_token');
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

  return noStoreJson(tokenSuccessBody(result.tokens, result.scopes), 200);
}

/**
 * RFC 8628 §3.5 device-code poll outcomes each get their OWN error string —
 * unlike the other two grants, this is not an oracle leak. The polling CLI
 * genuinely needs to distinguish "keep waiting" from "user said no" from
 * "restart the flow", and the RFC names these outcomes explicitly. Only an
 * unrecognized device_code (never issued) falls back to invalid_grant, same
 * treatment as an unknown authorization code or refresh token.
 */
type DevicePollOutcome = Awaited<ReturnType<typeof pollDeviceToken>>['outcome'];
/** Every outcome that is a SUCCESS and therefore never appears in the error map below. */
type DevicePollSuccessOutcome = 'ok' | 'ok_mcp_token' | 'ok_mcp_update' | 'ok_mcp_activate';

const DEVICE_POLL_ERROR_BODY: Record<Exclude<DevicePollOutcome, DevicePollSuccessOutcome>, Record<string, unknown>> = {
  not_found: INVALID_GRANT,
  authorization_pending: { error: 'authorization_pending' },
  slow_down: { error: 'slow_down' },
  expired_token: { error: 'expired_token' },
  access_denied: { error: 'access_denied' },
  // Constant-shape with not_found/expired/etc — no oracle on account status.
  user_suspended: INVALID_GRANT,
  // RFC 8628 §3.5: a redeemed device_code is dead. Constant-shape rather than
  // a distinct code, so a stolen device_code can't be used to probe whether
  // the legitimate client already completed the flow.
  already_redeemed: INVALID_GRANT,
  // The device door refuses all_drives up front; this is the redemption-time
  // backstop (see pollDeviceToken). Constant-shape — the CLI already refuses
  // `--device --all-drives` locally with an actionable message, so nothing
  // legitimate ever reaches here to need a specific code.
  all_drives_unsupported: INVALID_GRANT,
  // Target key revoked between consent and redemption — same constant shape
  // the authorization-code exchange gives these.
  update_target_gone: INVALID_GRANT,
  activate_target_gone: INVALID_GRANT,
};

async function handleDeviceCodeGrant(req: NextRequest, form: URLSearchParams): Promise<NextResponse> {
  const deviceCode = form.get('device_code');
  const clientId = form.get('client_id');

  if (!deviceCode || !clientId) {
    return noStoreJson(INVALID_REQUEST, 400);
  }

  const rateLimited = await checkDevicePollRateLimit(req, clientId);
  if (rateLimited) return rateLimited;

  const resolved = await resolveClient(form, clientId, 'urn:ietf:params:oauth:grant-type:device_code');
  if ('rejection' in resolved) return resolved.rejection;
  const { client, clientDbId } = resolved;

  const result = await pollDeviceToken({ deviceCode, clientDbId, now: new Date() });

  const keyGrantResponse = keyGrantSuccessResponse(req, client.clientId, result, 'device_poll');
  if (keyGrantResponse) return keyGrantResponse;

  // `keyGrantSuccessResponse` returning null means the outcome was not one of
  // the three key-shaped successes — but it is a runtime check the type system
  // can't see through, so the remaining successes are excluded explicitly here
  // to keep the error map exhaustively typed.
  if (result.outcome === 'ok_mcp_token' || result.outcome === 'ok_mcp_update' || result.outcome === 'ok_mcp_activate') {
    throw new Error('unreachable: key-grant outcomes are rendered by keyGrantSuccessResponse');
  }

  if (result.outcome !== 'ok') {
    auditRequest(req, {
      eventType: 'authz.access.denied',
      details: { clientId: client.clientId, oauthEvent: 'device_poll_rejected', outcome: result.outcome },
    });
    return noStoreJson(DEVICE_POLL_ERROR_BODY[result.outcome], 400);
  }

  auditRequest(req, {
    eventType: 'auth.token.created',
    userId: result.userId,
    details: { clientId: client.clientId, oauthEvent: 'device_poll_granted' },
  });

  return noStoreJson(tokenSuccessBody(result.tokens, result.scopes), 200);
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
  if (grantType === 'urn:ietf:params:oauth:grant-type:device_code') {
    return handleDeviceCodeGrant(req, form);
  }

  return noStoreJson({ error: 'unsupported_grant_type' }, 400);
}
