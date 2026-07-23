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
import { requireStepUpGrant } from '@/app/api/auth/mcp-tokens/step-up-gate';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const bodySchema = z.object({
  userCode: z.string().min(1).max(32),
  action: z.enum(['approve', 'deny']),
  /** Required only for key-shaped grants — see `requiresStepUp` below. */
  stepUpToken: z.string().min(1).optional(),
});

/**
 * Does approving this scope set escalate credentials rather than just log a
 * device in? Minting a key (`name:`), re-scoping one (`update_key`), or
 * making one a device's ambient default (`activate_key`) all do; a plain
 * `manage_keys offline_access` login does not.
 *
 * The loopback consent screen requires a step-up grant for EVERY consent
 * (`/api/oauth/authorize`). The device flow historically needed no step-up
 * because it could only ever produce a login grant — the door rejected
 * everything else. Now that it can produce key material, the escalating
 * subset must carry the same second factor, or `--device` would be a way to
 * mint a key with strictly less proof of presence than the browser flow
 * demands. Logins keep their existing no-step-up path so `login --device` is
 * unchanged.
 */
function requiresStepUp(scopes: ReturnType<typeof parseScopeList>): boolean {
  if (!scopes.ok) return false;
  return scopes.scopes.newKeyName !== null || scopes.scopes.updateKeyId !== null || scopes.scopes.activateKeyId !== null;
}

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
    // An empty scope list is a legitimate device-authorization request
    // (device_authorization/route.ts leaves `scopes: []` when the initial
    // POST omits `scope` entirely) — nothing to authorize, so skip straight
    // to recordDeviceApproval. `parseScopeList` rejects an empty string
    // outright (`empty_scope`), which is correct for the wire-level `scope`
    // grammar but would wrongly block approval of this valid empty case.
    if (lookup.outcome === 'ok' && lookup.scopes.length > 0) {
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

      // Bound to this exact user code AND this exact scope string, so a grant
      // obtained for one device approval can't be replayed against another —
      // the device analogue of the loopback binding's
      // clientId/redirectUri/scope/state tuple.
      if (requiresStepUp(parsed)) {
        const gate = await requireStepUpGrant({
          req,
          userId: auth.userId,
          stepUpToken: body.stepUpToken,
          actionBinding: { userCode: normalized, scope: lookup.scopes.join(' ') },
          missingReason: 'device_decision_missing_step_up',
          invalidReason: 'device_decision_step_up_invalid',
        });
        if (gate) return gate;
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
