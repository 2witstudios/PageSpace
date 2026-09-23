/**
 * GET /api/agent/challenge — the proof-of-work challenge for the agent API door
 * (ADR 0007 Decision 10; auth.md "Prove work"). Public and unauthenticated: an
 * agent fetches this before it has any identity at all.
 *
 * The challenge is single-use, expires after POW_TTL_MS, and is stored only as
 * a hash (threat model T2). Registration consumes it atomically. It is NOT
 * bound to the caller's IP: an honest agent's egress can change between this
 * GET and the POST (dual-stack, CGNAT, multi-egress NAT), and the per-IP
 * limits already act where an account is created — so no IP is stored. PoW shapes rate; the per-IP AGENT_CHALLENGE limit bounds how many
 * rows one caller can make us write.
 */
import { getClientIP } from '@/lib/auth';
import { agentNoStoreJson, agentNotFound, agentRateLimited, isAgentDoorOpen } from '@/lib/agent-auth/door';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { POW_DIFFICULTY_BITS, POW_TTL_MS, isPowDifficultyInRange } from '@pagespace/lib/auth/agent/pow';
import { issueAgentSignupChallenge } from '@pagespace/lib/services/agent-identities';
import { loggers } from '@pagespace/lib/logging/logger-config';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  // A closed door reveals nothing, and is checked before any row or bucket is touched.
  if (!isAgentDoorOpen()) {
    auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'agent_signup_challenge', details: { reason: 'agent_signup_disabled' }, riskScore: 0.1 });
    return agentNotFound();
  }

  const ip = getClientIP(request);
  const limit = await checkDistributedRateLimit(`agent-challenge:ip:${ip}`, DISTRIBUTED_RATE_LIMITS.AGENT_CHALLENGE);
  if (!limit.allowed) {
    auditRequest(request, { eventType: 'security.rate.limited', resourceType: 'agent_signup_challenge', details: { agentAuthEvent: 'challenge_rate_limited' }, riskScore: 0.4 });
    return agentRateLimited(limit.retryAfter);
  }

  // A difficulty outside [1, 64] is a misconfigured AGENT_SIGNUP_POW_BITS. Refuse
  // rather than hand out a challenge registration would reject as out of policy.
  const difficultyBits = POW_DIFFICULTY_BITS;
  if (!isPowDifficultyInRange(difficultyBits)) {
    loggers.api.error('Agent signup challenge refused: AGENT_SIGNUP_POW_BITS is out of range', undefined, { difficultyBits });
    auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'agent_signup_challenge', details: { reason: 'pow_difficulty_misconfigured' }, riskScore: 0.1 });
    return agentNoStoreJson({ error: 'temporarily_unavailable' }, 503);
  }

  const issued = await issueAgentSignupChallenge({ difficultyBits, ttlMs: POW_TTL_MS, now: new Date() });

  auditRequest(request, { eventType: 'auth.token.created', resourceType: 'agent_signup_challenge', details: { agentAuthEvent: 'challenge_issued', difficultyBits } });

  return agentNoStoreJson({
    challenge: issued.challenge,
    difficulty_bits: difficultyBits,
    expires_in: Math.floor(POW_TTL_MS / 1000),
    algorithm: 'sha3-256',
    input: `${issued.challenge}:<nonce>`,
  }, 200);
}
