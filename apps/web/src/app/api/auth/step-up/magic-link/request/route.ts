/**
 * POST /api/auth/step-up/magic-link/request (Phase 8 task d2wicbqyia6u30axz8j2j4ab)
 *
 * The passkey-less fallback ceremony: emails a fresh, single-use, action-bound
 * magic link to the caller's OWN registered address (never an attacker-chosen
 * one — the address comes from the authenticated userId, not the request
 * body). `next` reuses the sign-in surface's same-origin allowlist so this
 * can't become a second, drifting open-redirect surface.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { isSafeNextPath, SIGNIN_NEXT_ALLOWED_PREFIXES } from '@/lib/auth/url-utils';
import { requestMagicLinkStepUp } from '@pagespace/lib/auth/step-up-service';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { authenticateRequestWithOptions } from '@/lib/auth/request-auth';
import { isAuthError } from '@/lib/auth/auth-core';

const bodySchema = z.object({
  actionBinding: z.record(z.string(), z.string().nullish()),
  next: z.string().min(1).optional(),
});

export async function POST(req: NextRequest) {
  const auth = await authenticateRequestWithOptions(req, { allow: ['session'], requireCSRF: true });
  if (isAuthError(auth)) return auth.error;

  const rateLimit = await checkDistributedRateLimit(
    `step_up_magic_link:${auth.userId}`,
    DISTRIBUTED_RATE_LIMITS.MAGIC_LINK,
  );
  if (!rateLimit.allowed) {
    auditRequest(req, {
      eventType: 'security.rate.limited',
      userId: auth.userId,
      details: { reason: 'step_up_magic_link_rate_limit' },
    });
    return NextResponse.json({ error: 'Too many requests', retryAfter: rateLimit.retryAfter }, { status: 429 });
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const next =
    body.next && isSafeNextPath({ path: body.next, allowedPrefixes: SIGNIN_NEXT_ALLOWED_PREFIXES })
      ? body.next
      : undefined;

  const result = await requestMagicLinkStepUp({ userId: auth.userId, actionBinding: body.actionBinding, next });

  if (!result.ok) {
    return NextResponse.json({ error: 'step_up_failed' }, { status: 500 });
  }

  auditRequest(req, {
    eventType: 'auth.mfa.challenged',
    userId: auth.userId,
    details: { method: 'magic_link_stepup' },
  });

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } });
}
