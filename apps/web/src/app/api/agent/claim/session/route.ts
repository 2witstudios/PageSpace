/**
 * POST /api/agent/claim/session — an AI agent signed in by SESSION asks for a
 * claim link to hand a human (Agent Signup Phase 3: the unfunded banner's
 * "share your claim link", the Settings identity card's "Copy claim link", the
 * post-signup reveal card).
 *
 * The API door's equivalent is `POST /api/agent/claim {claim_token}` (Phase 4).
 * An agent that signed in at the browser door holds a cookie, not its claim
 * token, so here the session is the proof: SESSION only (never a bearer — an
 * OAuth grant the agent gave another client must not start claims), CSRF
 * enforced, the caller must be an agent, AGENT_CLAIM_INIT per agent. Same
 * response shape as the API door, so `/claim?user_code=` is the one human page.
 */
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { agentIssuer, agentNoStoreJson, agentNotFound, agentRateLimited, isAgentDoorOpen } from '@/lib/agent-auth/door';
import { startAgentClaimForSession } from '@/lib/agent-auth/claim-start';
import { authRepository } from '@/lib/repositories/auth-repository';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { AgentIdentityStoreError } from '@pagespace/lib/services/agent-identities';
import { CLAIM_POLL_INTERVAL_SECONDS, CLAIM_TTL_SECONDS } from '@pagespace/lib/auth/agent/claim-decision';

export const dynamic = 'force-dynamic';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

export async function POST(request: Request) {
  try {
    return await startClaim(request);
  } catch (error) {
    if (!(error instanceof AgentIdentityStoreError)) throw error;
    auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'agent_identity', details: { agentAuthEvent: 'claim_start_refused', reason: 'store_failed', operation: error.operation, code: error.redacted.code }, riskScore: 0.1 });
    return agentNoStoreJson({ error: 'temporarily_unavailable' }, 503);
  }
}

async function startClaim(request: Request) {
  if (!isAgentDoorOpen()) return agentNotFound();

  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;

  const refuse = (reason: string) => {
    auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'agent_identity', resourceId: auth.userId, details: { agentAuthEvent: 'claim_start_refused', reason, door: 'session' }, riskScore: 0.3 });
    return agentNotFound();
  };

  const user = await authRepository.findUserById(auth.userId);
  if (!user || user.accountType !== 'agent') return refuse('not_agent');

  const limit = await checkDistributedRateLimit(`agent-claim-init:agent:${auth.userId}`, DISTRIBUTED_RATE_LIMITS.AGENT_CLAIM_INIT);
  if (!limit.allowed) {
    auditRequest(request, { eventType: 'security.rate.limited', userId: auth.userId, resourceType: 'agent_identity', details: { agentAuthEvent: 'claim_start_rate_limited', door: 'session' }, riskScore: 0.4 });
    return agentRateLimited(limit.retryAfter);
  }

  const now = new Date();
  const started = await startAgentClaimForSession({ agentUserId: auth.userId, now });
  if (!started.ok && started.error === 'already_claimed') {
    // The agent asking about ITSELF: it already knows its owner from /api/auth/me.
    return agentNoStoreJson({ error: 'already_claimed' }, 409);
  }
  if (!started.ok) return refuse(started.error);

  auditRequest(request, {
    eventType: 'auth.token.created',
    userId: auth.userId,
    resourceType: 'agent_identity',
    resourceId: auth.userId,
    details: { agentAuthEvent: 'claim_started', door: 'session' },
  });

  const verificationUri = `${agentIssuer()}/claim`;
  return agentNoStoreJson({
    user_code: started.userCode,
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(started.userCode)}`,
    expires_in: CLAIM_TTL_SECONDS,
    interval: CLAIM_POLL_INTERVAL_SECONDS,
  }, 200);
}
