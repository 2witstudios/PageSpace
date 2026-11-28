/**
 * POST /api/agent/claim — an agent asks to be claimed (ADR 0008 Decisions 3,
 * 8; auth.md "Fund"; Agent Signup Phase 4). Public and unauthenticated by
 * protocol design, like the device-authorization endpoint it mirrors: the
 * caller proves itself with the `claim_token` it was handed at registration
 * (hash-only at rest), and the answer is a short user code a HUMAN enters at
 * `/claim` while the agent polls the claim grant on `/api/oauth/token`.
 *
 * Controls, in order: the deployment gate (closed → 404), the per-IP
 * AGENT_CLAIM_INIT limit, zod on the body, the same limit keyed on the
 * presented token (one agent cannot flood the user-code space from many IPs),
 * then `startAgentClaim`. An unknown, already claimed or revoked token answers
 * the SAME 400 a malformed body does — no oracle on which agents exist or who
 * owns them. A database failure is a constant 503 (its query binds the token's
 * hash, so the error itself is never logged or rethrown verbatim).
 */
import { z } from 'zod/v4';
import { getClientIP } from '@/lib/auth';
import { agentIssuer, agentNoStoreJson, agentNotFound, agentRateLimited, isAgentDoorOpen } from '@/lib/agent-auth/door';
import { agentClaimPageUrl } from '@/lib/agent-auth/claim-page';
import { startAgentClaim } from '@/lib/repositories/agent-claim-repository';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { agentRateLimitAddress } from '@pagespace/lib/auth/agent/token-rate-limit-keys';
import { hashToken } from '@pagespace/lib/auth/token-utils';
import { isDatabaseError, redactDbError } from '@pagespace/lib/logging/db-error-redaction';
import { loggers } from '@pagespace/lib/logging/logger-config';

export const dynamic = 'force-dynamic';

const claimRequestSchema = z.object({ claim_token: z.string().min(1).max(256) });

const INVALID_REQUEST = { error: 'invalid_request' } as const;

export async function POST(request: Request) {
  try {
    return await claim(request);
  } catch (error) {
    if (!isDatabaseError(error)) throw error;
    loggers.auth.error('Agent claim start failed', redactDbError(error));
    auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'agent_claim', details: { agentAuthEvent: 'claim_start_refused', reason: 'store_failed' }, riskScore: 0.1 });
    return agentNoStoreJson({ error: 'temporarily_unavailable' }, 503);
  }
}

async function claim(request: Request) {
  if (!isAgentDoorOpen()) {
    auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'agent_claim', details: { reason: 'agent_signup_disabled' }, riskScore: 0.1 });
    return agentNotFound();
  }

  const ipLimit = await checkDistributedRateLimit(`agent-claim-init:ip:${agentRateLimitAddress(getClientIP(request))}`, DISTRIBUTED_RATE_LIMITS.AGENT_CLAIM_INIT);
  if (!ipLimit.allowed) {
    auditRequest(request, { eventType: 'security.rate.limited', resourceType: 'agent_claim', details: { agentAuthEvent: 'claim_start_rate_limited', bucket: 'ip' }, riskScore: 0.5 });
    return agentRateLimited(ipLimit.retryAfter);
  }

  const refuse = (reason: string) => {
    auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'agent_claim', details: { agentAuthEvent: 'claim_start_refused', reason }, riskScore: 0.4 });
    return agentNoStoreJson(INVALID_REQUEST, 400);
  };

  const raw: unknown = await request.json().catch(() => null);
  const parsed = claimRequestSchema.safeParse(raw);
  if (!parsed.success) return refuse('invalid_request');
  const claimToken = parsed.data.claim_token;

  // Keyed on a digest of the token, never the token: rate-limit keys are stored.
  const tokenBucket = `agent-claim-init:token:${hashToken(`agent-claim-rate-limit:${claimToken}`).slice(0, 32)}`;
  const tokenLimit = await checkDistributedRateLimit(tokenBucket, DISTRIBUTED_RATE_LIMITS.AGENT_CLAIM_INIT);
  if (!tokenLimit.allowed) {
    auditRequest(request, { eventType: 'security.rate.limited', resourceType: 'agent_claim', details: { agentAuthEvent: 'claim_start_rate_limited', bucket: 'token' }, riskScore: 0.5 });
    return agentRateLimited(tokenLimit.retryAfter);
  }

  const started = await startAgentClaim({ claimToken, now: new Date() });
  if (started.outcome !== 'ok') return refuse('claim_token_not_claimable');

  auditRequest(request, {
    eventType: 'data.write',
    userId: started.agentUserId,
    resourceType: 'agent_claim',
    resourceId: started.agentUserId,
    details: { agentAuthEvent: 'claim_started', expiresIn: started.expiresInSeconds },
  });

  const verificationUri = agentClaimPageUrl(agentIssuer());
  return agentNoStoreJson({
    user_code: started.userCode,
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(started.userCode)}`,
    expires_in: started.expiresInSeconds,
    interval: started.intervalSeconds,
  }, 200);
}
