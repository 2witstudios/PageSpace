/**
 * RFC 8628 §3.1-3.2 device authorization endpoint (Phase 1 task 9,
 * mwexjazwha2uhw5bmvc9a7kw). Public, unauthenticated — the whole point of the
 * device grant is that the CLI has no session yet. Form-encoded POST with
 * `client_id` (+ optional `scope`) mints a `device_code` (opaque, high
 * entropy) and a `user_code` (short, unambiguous-alphabet, human-typed at
 * `/activate`) — both hashed at rest, only ever returned to the caller once.
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'crypto';
import { getRegisteredClient } from '@pagespace/lib/auth/oauth/clients';
import { parseScopeList, formatScopeSet } from '@pagespace/lib/auth/oauth/scopes';
import { generateUserCode, normalizeUserCode } from '@pagespace/lib/auth/oauth/user-code';
import { generateToken, hashToken } from '@pagespace/lib/auth/token-utils';
import { DEVICE_CODE_TTL_SECONDS, DEVICE_CODE_POLL_INTERVAL_SECONDS } from '@pagespace/lib/auth/oauth/code-lifecycle';
import { ensureOAuthClientRow, createDeviceAuthorization } from '@/lib/repositories/oauth-repository';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { getClientIP } from '@pagespace/lib/security/client-ip';

function noStoreJson(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/x-www-form-urlencoded')) {
    return noStoreJson({ error: 'invalid_request' }, 400);
  }

  // Per-IP only: unauthenticated by protocol design (the CLI has no session
  // yet), so IP is the only identity available. Bounds mass device/user-code
  // minting that would exhaust the short user-code space or flood the table.
  const ip = getClientIP(req);
  const ipLimit = await checkDistributedRateLimit(`oauth-device-init:ip:${ip}`, DISTRIBUTED_RATE_LIMITS.OAUTH_DEVICE_INIT);
  if (!ipLimit.allowed) {
    auditRequest(req, { eventType: 'security.rate.limited', details: { oauthEvent: 'device_authorization_rate_limited' } });
    return noStoreJson({ error: 'rate_limited', retryAfter: ipLimit.retryAfter ?? 0 }, 429);
  }

  const form = new URLSearchParams(await req.text());
  const clientId = form.get('client_id');
  if (!clientId) {
    return noStoreJson({ error: 'invalid_request' }, 400);
  }

  const client = getRegisteredClient(clientId);
  if (!client) {
    return noStoreJson({ error: 'invalid_client' }, 400);
  }

  const rawScope = form.get('scope');
  let scopes: string[] = [];
  if (rawScope) {
    const parsed = parseScopeList(rawScope);
    if (!parsed.ok) {
      return noStoreJson({ error: 'invalid_scope' }, 400);
    }
    // update_key/activate_key are loopback-consent-only: their ownership/
    // narration checks live on the consent screen + authorize POST, and
    // pollDeviceToken has no ok_mcp_update/ok_mcp_activate branch — reject at
    // the door rather than mint a device code that could only dead-end (fail
    // closed).
    //
    // all_drives is rejected for the same reason: pollDeviceToken has no
    // isAllDrivesGrant branch either — it mints a plain OAuth access/refresh
    // pair via issueInitialTokenPair, persisting `all_drives` verbatim into
    // `oauth_access_tokens.scopes`. `scopeSetToDriveScopes` returns zero rows
    // for all_drives (by design — "all drives" has no drive list to
    // enumerate), so such a token would carry `allowedDriveIds: []` — a shape
    // this codebase's two authorization helper families disagree on: the
    // `isScopedOAuthAuth`/`getScopedAccessLevel` path (principal-permissions.ts)
    // treats it as a scoped app member with zero drive rows and denies
    // everything (the orphaned-key shape, ADR 0002 F6); the
    // `checkMCPDriveScope`/`getAllowedDriveIds` path (index.ts) treats an
    // empty `allowedDriveIds` as full access and would grant everything.
    // Which one a given route hits depends on which helper it calls — this
    // ambiguity already exists in the codebase for any malformed empty-scope
    // OAuth token and is out of scope to resolve here. all_drives only
    // resolves unambiguously when minted as a real, unscoped
    // (`isScoped: false`) `mcp_tokens` row, which only the authorization_code
    // exchange's `isAllDrivesGrant` branch produces (`oauth-repository.ts`).
    // Rejecting at the device door means a bearer token in this ambiguous
    // shape can never be minted in the first place, sidestepping the
    // ambiguity rather than resolving it.
    // newKeyName is rejected for the identical reason: a name can never be
    // honored on a flow with no mint branch, so it must fail closed rather
    // than be silently ignored.
    if (
      parsed.scopes.updateKeyId !== null ||
      parsed.scopes.activateKeyId !== null ||
      parsed.scopes.allDrives ||
      parsed.scopes.newKeyName !== null
    ) {
      return noStoreJson({ error: 'invalid_scope' }, 400);
    }
    scopes = formatScopeSet(parsed.scopes).split(' ').filter(Boolean);
  }

  const clientDbId = await ensureOAuthClientRow(client);

  const { token: deviceCode, hash: deviceCodeHash, tokenPrefix: deviceCodePrefix } = generateToken('ps_dc');
  const userCode = generateUserCode(randomBytes);
  const userCodeHash = hashToken(normalizeUserCode(userCode));
  const userCodePrefix = userCode.substring(0, 4);
  const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_SECONDS * 1000);

  await createDeviceAuthorization({
    clientDbId,
    scopes,
    deviceCodeHash,
    deviceCodePrefix,
    userCodeHash,
    userCodePrefix,
    expiresAt,
    pollIntervalSeconds: DEVICE_CODE_POLL_INTERVAL_SECONDS,
  });

  const issuer = (process.env.WEB_APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/+$/, '');
  const verificationUri = `${issuer}/activate`;

  auditRequest(req, {
    eventType: 'auth.device.registered',
    details: { clientId: client.clientId, oauthEvent: 'device_authorization_requested' },
  });

  return noStoreJson(
    {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
      expires_in: DEVICE_CODE_TTL_SECONDS,
      interval: DEVICE_CODE_POLL_INTERVAL_SECONDS,
    },
    200,
  );
}
