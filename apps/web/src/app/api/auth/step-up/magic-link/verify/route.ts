/**
 * GET /api/auth/step-up/magic-link/verify (Phase 8 task d2wicbqyia6u30axz8j2j4ab)
 *
 * The click-through target of the step-up confirmation email. Unlike
 * `/api/auth/magic-link/verify`, success here never creates a session — it
 * only mints a step-up grant (via `completeMagicLinkStepUp`) and, when the
 * link carried a safe `next` path, redirects there with the grant attached
 * so the page that triggered the step-up (e.g. the OAuth consent screen) can
 * pick it up and complete its own mint request.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { getClientIP } from '@/lib/auth';
import { isSafeNextPath, SIGNIN_NEXT_ALLOWED_PREFIXES } from '@/lib/auth/auth-helpers';
import { verifyMagicLinkToken } from '@pagespace/lib/auth/magic-link-service';
import { completeMagicLinkStepUp } from '@pagespace/lib/auth/step-up-service';
import { parseMagicLinkStepUpNext } from '@pagespace/lib/auth/step-up-decisions';
import { resolveAppUrl } from '@pagespace/lib/services/email-service';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';

const querySchema = z.object({ token: z.string().min(1) });

function renderResultPage({ success }: { success: boolean }): NextResponse {
  const heading = success ? 'Confirmed' : 'Link invalid or expired';
  const body = success
    ? 'You can return to the tab where you started this action.'
    : 'This confirmation link is invalid, expired, or already used. Please try again from where you started.';
  return new NextResponse(
    `<!doctype html><html><head><title>PageSpace</title></head><body><h1>${heading}</h1><p>${body}</p></body></html>`,
    { status: success ? 200 : 400, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

export async function GET(req: NextRequest) {
  const clientIP = getClientIP(req);
  const rateLimit = await checkDistributedRateLimit(
    `step_up_magic_link_verify:ip:${clientIP}`,
    DISTRIBUTED_RATE_LIMITS.OAUTH_VERIFY,
  );
  if (!rateLimit.allowed) {
    auditRequest(req, {
      eventType: 'security.rate.limited',
      details: { reason: 'step_up_magic_link_verify_rate_limit' },
    });
    return renderResultPage({ success: false });
  }

  const { searchParams } = new URL(req.url);
  const parsedQuery = querySchema.safeParse({ token: searchParams.get('token') });
  if (!parsedQuery.success) {
    return renderResultPage({ success: false });
  }

  const magicLinkResult = await verifyMagicLinkToken({ token: parsedQuery.data.token });
  if (!magicLinkResult.ok) {
    auditRequest(req, {
      eventType: 'authz.access.denied',
      details: { reason: 'step_up_magic_link_invalid' },
    });
    return renderResultPage({ success: false });
  }

  const { userId, metadata } = magicLinkResult.data;
  const stepUpResult = await completeMagicLinkStepUp({ userId, metadata: metadata ?? null });
  if (!stepUpResult.ok) {
    auditRequest(req, {
      eventType: 'authz.access.denied',
      userId,
      details: { reason: 'step_up_magic_link_not_step_up' },
    });
    return renderResultPage({ success: false });
  }

  auditRequest(req, {
    eventType: 'auth.mfa.verified',
    userId,
    details: { method: 'magic_link_stepup' },
  });

  const next = parseMagicLinkStepUpNext(metadata ?? null);
  const safeNext = next && isSafeNextPath({ path: next, allowedPrefixes: SIGNIN_NEXT_ALLOWED_PREFIXES }) ? next : null;

  if (!safeNext) {
    return renderResultPage({ success: true });
  }

  const redirectUrl = new URL(safeNext, resolveAppUrl());
  redirectUrl.searchParams.set('step_up_token', stepUpResult.data.stepUpToken);
  return NextResponse.redirect(redirectUrl, 302);
}
