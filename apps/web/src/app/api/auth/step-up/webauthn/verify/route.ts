/**
 * POST /api/auth/step-up/webauthn/verify (Phase 8 task d2wicbqyia6u30axz8j2j4ab)
 *
 * Verifies the WebAuthn assertion started by `webauthn/options` and, on
 * success, mints a single-use step-up grant bound to `actionBinding`. Every
 * ceremony failure — missing/expired/used challenge, wrong-owner credential,
 * failed crypto verification, mismatched binding — collapses to the same
 * generic `step_up_invalid` 401 so a caller can never learn which one
 * happened (see `step-up-decisions.ts`'s constant-shape verdict rationale).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { verifyWebauthnStepUp } from '@pagespace/lib/auth/step-up-service';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';

const bodySchema = z.object({
  response: z.record(z.string(), z.unknown()),
  expectedChallenge: z.string().min(1),
  actionBinding: z.record(z.string(), z.string().nullish()),
});

export async function POST(req: NextRequest) {
  const auth = await authenticateRequestWithOptions(req, { allow: ['session'], requireCSRF: true });
  if (isAuthError(auth)) return auth.error;

  const rateLimit = await checkDistributedRateLimit(
    `step_up_verify:${auth.userId}`,
    DISTRIBUTED_RATE_LIMITS.PASSKEY_AUTH,
  );
  if (!rateLimit.allowed) {
    auditRequest(req, {
      eventType: 'security.rate.limited',
      userId: auth.userId,
      details: { reason: 'step_up_verify_rate_limit' },
    });
    return NextResponse.json({ error: 'Too many requests', retryAfter: rateLimit.retryAfter }, { status: 429 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const result = await verifyWebauthnStepUp({
    userId: auth.userId,
    response: body.response,
    expectedChallenge: body.expectedChallenge,
    actionBinding: body.actionBinding,
  });

  if (!result.ok) {
    auditRequest(req, {
      eventType: 'authz.access.denied',
      userId: auth.userId,
      details: { reason: 'step_up_webauthn_invalid' },
    });
    return NextResponse.json({ error: 'step_up_invalid' }, { status: 401 });
  }

  auditRequest(req, {
    eventType: 'auth.mfa.verified',
    userId: auth.userId,
    details: { method: 'webauthn_stepup' },
  });

  return NextResponse.json(
    { stepUpToken: result.data.stepUpToken },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}
