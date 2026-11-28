/**
 * POST /api/agent/claim/decision — a human approves or denies a claim at
 * /claim (ADR 0008 Decisions 3, 7, 8; Agent Signup Phase 4; mirrors
 * /api/oauth/device_authorization/decision). Session + CSRF, re-rate-limited
 * and re-normalised from scratch — nothing from the earlier /verify call is
 * trusted. The frozen `decideClaimApproval` runs inside
 * `recordAgentClaimDecision` under FOR UPDATE, which on approval sets the
 * owner and `claimedAt` and stamps the agent's `emailVerified` (D-31 option
 * A) in one transaction. Approval mints nothing: the agent learns its owner
 * by polling the claim grant with its OWN access token.
 *
 * Wire: approval → `auth.agent.claimed`. Unknown, expired, settled and
 * already-claimed codes are the one `invalid_code` (no oracle on who owns an
 * agent); a non-human claimer is `not_human`.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError, getClientIP } from '@/lib/auth';
import { agentNotFound, isAgentDoorOpen } from '@/lib/agent-auth/door';
import { recordAgentClaimDecision } from '@/lib/repositories/agent-claim-repository';
import { normalizeUserCode } from '@pagespace/lib/auth/oauth/user-code';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const bodySchema = z.object({
  userCode: z.string().min(1).max(32),
  action: z.enum(['approve', 'deny']),
});

export async function POST(req: Request) {
  if (!isAgentDoorOpen()) return agentNotFound();

  const auth = await authenticateRequestWithOptions(req, { allow: ['session'], requireCSRF: true });
  if (isAuthError(auth)) return auth.error;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });

  const ip = getClientIP(req);
  const [ipLimit, sessionLimit] = await Promise.all([
    checkDistributedRateLimit(`agent-claim-decide:ip:${ip}`, DISTRIBUTED_RATE_LIMITS.OAUTH_VERIFY),
    checkDistributedRateLimit(`agent-claim-decide:session:${auth.userId}`, DISTRIBUTED_RATE_LIMITS.OAUTH_VERIFY),
  ]);
  if (!ipLimit.allowed || !sessionLimit.allowed) {
    auditRequest(req, { eventType: 'security.rate.limited', userId: auth.userId, details: { agentAuthEvent: 'claim_decision_rate_limited' } });
    const retryAfter = Math.max(ipLimit.retryAfter ?? 0, sessionLimit.retryAfter ?? 0);
    return NextResponse.json({ error: 'rate_limited', retryAfter }, { status: 429 });
  }

  const result = await recordAgentClaimDecision({
    userCode: normalizeUserCode(parsed.data.userCode),
    action: parsed.data.action,
    claimerUserId: auth.userId,
    now: new Date(),
  });

  if (result.outcome === 'approved') {
    auditRequest(req, {
      eventType: 'auth.agent.claimed',
      userId: auth.userId,
      resourceType: 'agent_identity',
      resourceId: result.agentUserId,
      details: { agentAuthEvent: 'agent_claimed' },
    });
    return NextResponse.json({ ok: true, action: 'approved' });
  }

  if (result.outcome === 'denied') {
    auditRequest(req, {
      eventType: 'authz.access.denied',
      userId: auth.userId,
      resourceType: 'agent_identity',
      resourceId: result.agentUserId,
      details: { agentAuthEvent: 'claim_denied_by_human' },
    });
    return NextResponse.json({ ok: true, action: 'denied' });
  }

  const reason = result.outcome === 'refused' ? result.decision.status : 'not_found';
  auditRequest(req, {
    eventType: 'authz.access.denied',
    userId: auth.userId,
    resourceType: 'agent_identity',
    resourceId: result.outcome === 'refused' ? result.agentUserId : undefined,
    details: { agentAuthEvent: 'claim_decision_refused', reason },
  });
  if (reason === 'not_human') return NextResponse.json({ error: 'not_human' }, { status: 403 });
  return NextResponse.json({ error: 'invalid_code' }, { status: 400 });
}
