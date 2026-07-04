/**
 * CSRF-protected approve/deny decision for the /activate screen (task
 * mwexjazwha2uhw5bmvc9a7kw). Re-normalizes, re-rate-limits, and re-validates
 * the user code from scratch — never trusts an earlier /verify call — then
 * records the decision via `decideDeviceApproval` (task 4, not
 * reimplemented).
 *
 * Approval additionally enforces the SAME grant-authority caps the
 * authorization-code consent screen enforces (ADR 0002 Decision 2, P1b): the
 * device code's requested scopes are re-checked against the approving user's
 * actual drive access immediately before `recordDeviceApproval`, so a user
 * cannot approve a scope (e.g. `drive:<id>:admin`) they have no authority to
 * grant. A code that can't be looked up here is left to `recordDeviceApproval`
 * to reject on its own terms (not_found/expired/already_settled).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError, getClientIP } from '@/lib/auth';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { normalizeUserCode } from '@pagespace/lib/auth/oauth/user-code';
import { parseScopeList, checkGrantAuthority } from '@pagespace/lib/auth/oauth/scopes';
import { resolveGrantAuthority } from '@/lib/auth/oauth-grant-authority';
import { recordDeviceApproval, verifyDeviceUserCode } from '@/lib/repositories/oauth-repository';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const bodySchema = z.object({
  userCode: z.string().min(1).max(32),
  action: z.enum(['approve', 'deny']),
});

export async function POST(req: NextRequest) {
  const auth = await authenticateRequestWithOptions(req, { allow: ['session'], requireCSRF: true });
  if (isAuthError(auth)) return auth.error;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const ip = getClientIP(req);
  const [ipLimit, sessionLimit] = await Promise.all([
    checkDistributedRateLimit(`oauth-device-decide:ip:${ip}`, DISTRIBUTED_RATE_LIMITS.OAUTH_VERIFY),
    checkDistributedRateLimit(`oauth-device-decide:session:${auth.userId}`, DISTRIBUTED_RATE_LIMITS.OAUTH_VERIFY),
  ]);

  if (!ipLimit.allowed || !sessionLimit.allowed) {
    auditRequest(req, {
      eventType: 'security.rate.limited',
      userId: auth.userId,
      details: { oauthEvent: 'device_decision_rate_limited' },
    });
    const retryAfter = Math.max(ipLimit.retryAfter ?? 0, sessionLimit.retryAfter ?? 0);
    return NextResponse.json({ error: 'rate_limited', retryAfter }, { status: 429 });
  }

  const normalized = normalizeUserCode(body.userCode);

  if (body.action === 'approve') {
    const lookup = await verifyDeviceUserCode({ userCode: normalized, now: new Date() });
    if (lookup.outcome === 'ok') {
      const parsed = parseScopeList(lookup.scopes.join(' '));
      const authority =
        parsed.ok && checkGrantAuthority(parsed.scopes, await resolveGrantAuthority(parsed.scopes, auth.userId));

      if (!authority || !authority.ok) {
        auditRequest(req, {
          eventType: 'authz.access.denied',
          userId: auth.userId,
          details: { oauthEvent: 'device_decision_scope_denied' },
        });
        return NextResponse.json({ error: 'invalid_scope' }, { status: 400 });
      }
    }
  }

  const result = await recordDeviceApproval({
    userCode: normalized,
    action: body.action,
    userId: auth.userId,
    now: new Date(),
  });

  if (result.outcome === 'not_found' || result.outcome === 'invalid') {
    auditRequest(req, {
      eventType: 'authz.access.denied',
      userId: auth.userId,
      details: { oauthEvent: 'device_decision_rejected' },
    });
    return NextResponse.json({ error: 'invalid_code' }, { status: 400 });
  }

  auditRequest(req, {
    eventType: result.outcome === 'approved' ? 'authz.access.granted' : 'authz.access.denied',
    userId: auth.userId,
    details: { oauthEvent: result.outcome === 'approved' ? 'device_approved' : 'device_denied' },
  });

  return NextResponse.json({ ok: true, action: result.outcome });
}
