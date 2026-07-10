/**
 * POST /api/auth/step-up/webauthn/options (Phase 8 task d2wicbqyia6u30axz8j2j4ab)
 *
 * Starts a WebAuthn step-up ceremony scoped to the caller's OWN registered
 * passkeys and to a specific pending action (`actionBinding` — e.g. the
 * mcp-tokens body being minted, or the OAuth consent parameters being
 * approved). Session-authenticated only: a step-up gate that itself accepted
 * a bearer OAuth token would just move the hole it's meant to close.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { beginWebauthnStepUp } from '@pagespace/lib/auth/step-up-service';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';

const bodySchema = z.object({
  actionBinding: z.record(z.string(), z.string().nullish()),
});

export async function POST(req: NextRequest) {
  const auth = await authenticateRequestWithOptions(req, { allow: ['session'], requireCSRF: true });
  if (isAuthError(auth)) return auth.error;

  const rateLimit = await checkDistributedRateLimit(
    `step_up_options:${auth.userId}`,
    DISTRIBUTED_RATE_LIMITS.PASSKEY_OPTIONS,
  );
  if (!rateLimit.allowed) {
    auditRequest(req, {
      eventType: 'security.rate.limited',
      userId: auth.userId,
      details: { reason: 'step_up_options_rate_limit' },
    });
    return NextResponse.json({ error: 'Too many requests', retryAfter: rateLimit.retryAfter }, { status: 429 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const result = await beginWebauthnStepUp({ userId: auth.userId, actionBinding: body.actionBinding });

  if (!result.ok) {
    if (result.error.code === 'NO_PASSKEY') {
      return NextResponse.json({ error: 'no_passkey' }, { status: 404 });
    }
    loggers.auth.warn('Step-up webauthn options failed', { error: result.error.code });
    return NextResponse.json({ error: 'step_up_failed' }, { status: 500 });
  }

  auditRequest(req, {
    eventType: 'auth.mfa.challenged',
    userId: auth.userId,
    details: { method: 'webauthn_stepup' },
  });

  return NextResponse.json(
    { options: result.data.options, challengeId: result.data.challengeId },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}
