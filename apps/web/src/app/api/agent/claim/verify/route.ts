/**
 * POST /api/agent/claim/verify — the /claim screen's read-only lookup (Agent
 * Signup Phase 4; mirrors /api/oauth/device_authorization/verify). Session
 * only: a human signs in as themselves before they can be shown — let alone
 * agree to pay for — an agent. Short human-typed codes are brute-forceable, so
 * it is rate-limited per IP AND per session. It names the agent (name, when it
 * was created, its self-reported source); every code that cannot be acted on
 * is the one `invalid_code`. A signed-in agent is told `not_human` — a fact
 * about the caller, not about the code.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError, getClientIP } from '@/lib/auth';
import { agentNotFound, isAgentDoorOpen } from '@/lib/agent-auth/door';
import { verifyAgentClaimUserCode } from '@/lib/repositories/agent-claim-repository';
import { normalizeUserCode } from '@pagespace/lib/auth/oauth/user-code';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const bodySchema = z.object({ userCode: z.string().min(1).max(32) });

export async function POST(req: Request) {
  if (!isAgentDoorOpen()) return agentNotFound();

  const auth = await authenticateRequestWithOptions(req, { allow: ['session'], requireCSRF: false });
  if (isAuthError(auth)) return auth.error;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });

  const ip = getClientIP(req);
  const [ipLimit, sessionLimit] = await Promise.all([
    checkDistributedRateLimit(`agent-claim-verify:ip:${ip}`, DISTRIBUTED_RATE_LIMITS.OAUTH_VERIFY),
    checkDistributedRateLimit(`agent-claim-verify:session:${auth.userId}`, DISTRIBUTED_RATE_LIMITS.OAUTH_VERIFY),
  ]);
  if (!ipLimit.allowed || !sessionLimit.allowed) {
    auditRequest(req, { eventType: 'security.rate.limited', userId: auth.userId, details: { agentAuthEvent: 'claim_verify_rate_limited' } });
    const retryAfter = Math.max(ipLimit.retryAfter ?? 0, sessionLimit.retryAfter ?? 0);
    return NextResponse.json({ error: 'rate_limited', retryAfter }, { status: 429 });
  }

  const userCode = normalizeUserCode(parsed.data.userCode);
  const result = await verifyAgentClaimUserCode({ userCode, claimerUserId: auth.userId, now: new Date() });

  if (result.outcome === 'not_human') {
    auditRequest(req, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'agent_claim', details: { agentAuthEvent: 'claim_verify_refused', reason: 'not_human' } });
    return NextResponse.json({ error: 'not_human' }, { status: 403 });
  }
  if (result.outcome !== 'ok') {
    auditRequest(req, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'agent_claim', details: { agentAuthEvent: 'claim_verify_refused', reason: 'invalid_code' } });
    return NextResponse.json({ error: 'invalid_code' }, { status: 400 });
  }

  return NextResponse.json({
    userCode,
    agent: { name: result.agent.name, createdAt: result.agent.createdAt.toISOString(), source: result.agent.source },
  });
}
