/**
 * /api/auth/reauthenticate (D-OW-45; SEC-2/SEC-3)
 *
 * When an org's sign-in policy refuses the current session (strong sign-in; maximum age), the client re-runs a sign-in
 * ceremony through the existing step-up flow and this stamps the evidence that ceremony earned onto the CURRENT
 * session — the person stays signed in, and their org drives open again.
 *
 *   GET  → the action binding to run the step-up ceremony against. It names this session (by a hash of its id), so a
 *          grant earned here can only ever re-authenticate this session.
 *   POST { stepUpToken } → consumes the single-use grant (server-verified: WebAuthn with user verification required,
 *          or an emailed link) and stamps its evidence. The client never says what it proved.
 *
 * Session-only (a bearer token re-authenticating itself would move the hole), CSRF-protected on POST.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { consumeStepUpGrant } from '@pagespace/lib/auth/step-up-service';
import { reauthenticateSession } from '@pagespace/lib/auth/reauthentication';
import { reauthenticationActionBinding } from '@/lib/auth/reauthentication-binding';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';

const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate' };

const bodySchema = z.object({ stepUpToken: z.string().min(1) });

export async function GET(req: Request) {
  const auth = await authenticateRequestWithOptions(req, { allow: ['session'], requireCSRF: false });
  if (isAuthError(auth)) return auth.error;
  if (auth.tokenType !== 'session') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ actionBinding: reauthenticationActionBinding(auth.sessionId) }, { headers: NO_STORE });
}

export async function POST(req: Request) {
  const auth = await authenticateRequestWithOptions(req, { allow: ['session'], requireCSRF: true });
  if (isAuthError(auth)) return auth.error;
  if (auth.tokenType !== 'session') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rateLimit = await checkDistributedRateLimit(`reauthenticate:${auth.userId}`, DISTRIBUTED_RATE_LIMITS.PASSKEY_AUTH);
  if (!rateLimit.allowed) {
    return NextResponse.json({ error: 'Too many requests', retryAfter: rateLimit.retryAfter }, { status: 429 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });

  const grant = await consumeStepUpGrant({
    userId: auth.userId,
    token: parsed.data.stepUpToken,
    actionBinding: reauthenticationActionBinding(auth.sessionId),
  });
  if (!grant.ok) {
    auditRequest(req, { eventType: 'authz.access.denied', userId: auth.userId, details: { reason: 'reauthenticate_grant_invalid' } });
    return NextResponse.json({ error: 'step_up_required' }, { status: 401 });
  }

  const result = await reauthenticateSession({ sessionId: auth.sessionId, userId: auth.userId, fresh: grant.authentication });
  if (!result.ok) {
    if (result.reason === 'weaker_than_current') {
      return NextResponse.json(
        { error: 'This session already holds a passkey sign-in. Use your passkey to confirm it is you.', code: 'weaker_than_current' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  auditRequest(req, {
    eventType: 'auth.mfa.verified',
    userId: auth.userId,
    sessionId: auth.sessionId,
    details: { method: 'session_reauthentication', assurance: result.authentication.assurance },
  });
  return NextResponse.json({ assurance: result.authentication.assurance, authenticatedAt: new Date(result.authentication.authenticatedAtMs).toISOString() }, { headers: NO_STORE });
}
