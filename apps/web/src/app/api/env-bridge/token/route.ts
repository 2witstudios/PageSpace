/**
 * Env-bridge socket token — `/api/env-bridge/token`, two steps.
 *
 *   GET  ?enrollmentId=…                       → { nonce, expiresAt }
 *   POST { enrollmentId, nonce, signature }    → { token, expiresInMs, envId }
 *
 * The daemon never presents a stored secret: it asks for a nonce, signs it with
 * the private key that never left its keychain, and the server verifies the
 * signature against the key pinned at enrollment before minting a short-lived
 * `env:bridge` token (Local Environments epic, invariant 2). The nonce is
 * consumed by compare-and-set, so a replayed signature mints nothing.
 *
 * UNAUTHENTICATED by design (the token this mints IS the machine's auth).
 * Rate-limited per IP and per enrollment; off ⇒ 404; every refusal audited.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getClientIP } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit } from '@pagespace/lib/security/distributed-rate-limit';
import { isLocalEnvsEnabled } from '@pagespace/lib/services/drive-envs/local-envs-enabled';
import { issueEnvChallenge, redeemEnvChallenge } from '@/lib/drive-envs/drive-envs-runtime';

/** A daemon reconnects rarely; a reconnect storm from one machine is still a handful a minute. */
const TOKEN_RATE_LIMIT_PER_IP = { maxAttempts: 30, windowMs: 60_000 };
const TOKEN_RATE_LIMIT_PER_ENROLLMENT = { maxAttempts: 10, windowMs: 60_000 };

const enrollmentIdSchema = z.string().min(1).max(128);

const redeemSchema = z
  .object({
    enrollmentId: enrollmentIdSchema,
    nonce: z.string().min(1).max(256),
    signature: z.string().min(1).max(512),
  })
  .strict();

const ISSUE_STATUS = { not_found: 404, not_enrolled: 409, revoked: 410 } as const;
const REDEEM_STATUS = {
  not_found: 404,
  not_enrolled: 409,
  revoked: 410,
  no_challenge: 409,
  race: 409,
  malformed: 400,
  wrong_enrollment: 401,
  nonce_mismatch: 401,
  used: 401,
  expired: 401,
  bad_signature: 401,
} as const;

async function limited(request: Request, enrollmentId: string | null, step: 'challenge' | 'redeem'): Promise<NextResponse | null> {
  const ip = getClientIP(request);
  const ipLimit = await checkDistributedRateLimit(`env-bridge-token:ip:${ip}`, TOKEN_RATE_LIMIT_PER_IP);
  if (!ipLimit.allowed) {
    auditRequest(request, { eventType: 'security.rate.limited', details: { route: 'env-bridge/token', step, scope: 'ip' } });
    return NextResponse.json({ error: 'Too many token requests' }, { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfter || 60) } });
  }
  if (enrollmentId !== null) {
    const enrollmentLimit = await checkDistributedRateLimit(`env-bridge-token:enrollment:${enrollmentId}`, TOKEN_RATE_LIMIT_PER_ENROLLMENT);
    if (!enrollmentLimit.allowed) {
      auditRequest(request, { eventType: 'security.rate.limited', details: { route: 'env-bridge/token', step, scope: 'enrollment', enrollmentId } });
      return NextResponse.json({ error: 'Too many token requests' }, { status: 429, headers: { 'Retry-After': String(enrollmentLimit.retryAfter || 60) } });
    }
  }
  return null;
}

export async function GET(request: Request) {
  if (!isLocalEnvsEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const enrollmentId = enrollmentIdSchema.safeParse(new URL(request.url).searchParams.get('enrollmentId'));
  if (!enrollmentId.success) return NextResponse.json({ error: 'enrollmentId is required' }, { status: 400 });

  const refused = await limited(request, enrollmentId.data, 'challenge');
  if (refused) return refused;

  const result = await issueEnvChallenge({ enrollmentId: enrollmentId.data });
  if (!result.ok) {
    auditRequest(request, {
      eventType: 'authz.access.denied',
      resourceType: 'drive_env_enrollment',
      resourceId: enrollmentId.data,
      riskScore: 0.2,
      details: { route: 'env-bridge/token', step: 'challenge', reason: result.reason },
    });
    return NextResponse.json({ error: `Challenge refused: ${result.reason}`, reason: result.reason }, { status: ISSUE_STATUS[result.reason] });
  }
  return NextResponse.json({ nonce: result.nonce, expiresAt: result.expiresAt.toISOString() });
}

export async function POST(request: Request) {
  if (!isLocalEnvsEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body = await request.json().catch(() => null);
  const parsed = redeemSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'enrollmentId, nonce and signature are required' }, { status: 400 });

  const refused = await limited(request, parsed.data.enrollmentId, 'redeem');
  if (refused) return refused;

  const result = await redeemEnvChallenge({ enrollmentId: parsed.data.enrollmentId, response: parsed.data });
  if (!result.ok) {
    auditRequest(request, {
      eventType: 'auth.login.failure',
      resourceType: 'drive_env_enrollment',
      resourceId: parsed.data.enrollmentId,
      riskScore: result.reason === 'bad_signature' || result.reason === 'used' ? 0.6 : 0.3,
      details: { route: 'env-bridge/token', step: 'redeem', reason: result.reason },
    });
    return NextResponse.json({ error: `Token refused: ${result.reason}`, reason: result.reason }, { status: REDEEM_STATUS[result.reason] });
  }

  auditRequest(request, {
    eventType: 'auth.token.created',
    resourceType: 'drive_env',
    resourceId: result.envId,
    details: { route: 'env-bridge/token', enrollmentId: parsed.data.enrollmentId, tokenType: 'env-bridge' },
  });
  return NextResponse.json({ token: result.token, expiresInMs: result.expiresInMs, envId: result.envId });
}
