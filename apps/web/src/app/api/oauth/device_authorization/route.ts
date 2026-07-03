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

function noStoreJson(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/x-www-form-urlencoded')) {
    return noStoreJson({ error: 'invalid_request' }, 400);
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
