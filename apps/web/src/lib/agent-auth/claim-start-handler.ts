/**
 * The one claim-start handler behind both claim doors (ADR 0008 Decision 3,
 * auth.md "Fund", security review addendum):
 *
 *   bearer  — `POST /api/agent/claim`, the agent's own `pagespace-agent` access token;
 *   session — `POST /api/agent/claim/session`, the agent's browser session (CSRF-checked).
 *
 * Controls, in order: the deployment gate (closed → 404), the per-IP
 * AGENT_CLAIM_INIT limit (bearer door — it is reachable without a session),
 * authentication, `resolveClaimCaller` (only the agent itself, on the
 * credential its door accepts — a human, a former owner, another client's
 * token all get the same 404), AGENT_CLAIM_INIT per agent (shared by both
 * doors), then the start. The body carries nothing: a claim token is not a
 * credential, and a request that still sends one is refused (400), so a stale
 * client learns at once instead of half-working.
 */
import { authenticateRequestWithOptions, getClientIP, isAuthError, type AuthenticateOptions } from '@/lib/auth';
import { agentIssuer, agentNoStoreJson, agentNotFound, agentRateLimited, isAgentDoorOpen } from './door';
import { agentClaimPageUrl } from './claim-page';
import { resolveClaimCaller } from './claim-caller';
import { startOwnAgentClaim } from './claim-start';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { agentRateLimitAddress } from '@pagespace/lib/auth/agent/token-rate-limit-keys';
import { CLAIM_POLL_INTERVAL_SECONDS, CLAIM_TTL_SECONDS } from '@pagespace/lib/auth/agent/claim-decision';
import type { ClaimDoor } from '@pagespace/lib/auth/agent/caller-policy';
import { AgentIdentityStoreError } from '@pagespace/lib/services/agent-identities';

const AUTH_OPTIONS: Record<ClaimDoor, AuthenticateOptions> = {
  bearer: { allow: ['oauth'], requireCSRF: false },
  session: { allow: ['session'], requireCSRF: true },
};

/** True when the request body is empty or an empty JSON object — the only body a claim start takes. */
async function bodyIsEmpty(request: Request): Promise<boolean> {
  const text = await request.text().catch(() => '');
  if (text.trim() === '') return true;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
  } catch {
    return false;
  }
}

export async function handleOwnClaimStart(request: Request, door: ClaimDoor): Promise<Response> {
  try {
    return await startClaim(request, door);
  } catch (error) {
    if (!(error instanceof AgentIdentityStoreError)) throw error;
    auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'agent_claim', details: { agentAuthEvent: 'claim_start_refused', reason: 'store_failed', door, operation: error.operation, code: error.redacted.code }, riskScore: 0.1 });
    return agentNoStoreJson({ error: 'temporarily_unavailable' }, 503);
  }
}

async function startClaim(request: Request, door: ClaimDoor): Promise<Response> {
  if (!isAgentDoorOpen()) {
    auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'agent_claim', details: { reason: 'agent_signup_disabled', door }, riskScore: 0.1 });
    return agentNotFound();
  }

  if (door === 'bearer') {
    const ipLimit = await checkDistributedRateLimit(`agent-claim-init:ip:${agentRateLimitAddress(getClientIP(request))}`, DISTRIBUTED_RATE_LIMITS.AGENT_CLAIM_INIT);
    if (!ipLimit.allowed) {
      auditRequest(request, { eventType: 'security.rate.limited', resourceType: 'agent_claim', details: { agentAuthEvent: 'claim_start_rate_limited', bucket: 'ip', door }, riskScore: 0.5 });
      return agentRateLimited(ipLimit.retryAfter);
    }
  }

  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS[door]);
  if (isAuthError(auth)) return auth.error;

  const refuse = (reason: string) => {
    auditRequest(request, { eventType: 'authz.access.denied', userId: auth.userId, resourceType: 'agent_claim', resourceId: auth.userId, details: { agentAuthEvent: 'claim_start_refused', reason, door }, riskScore: 0.4 });
    return agentNotFound();
  };

  const caller = await resolveClaimCaller(auth, door);
  if (!caller.ok) return refuse('not_the_agent_itself');

  if (!(await bodyIsEmpty(request))) {
    auditRequest(request, { eventType: 'authz.access.denied', userId: caller.agentUserId, resourceType: 'agent_claim', details: { agentAuthEvent: 'claim_start_refused', reason: 'unexpected_body', door }, riskScore: 0.2 });
    return agentNoStoreJson({ error: 'invalid_request' }, 400);
  }

  const limit = await checkDistributedRateLimit(`agent-claim-init:agent:${caller.agentUserId}`, DISTRIBUTED_RATE_LIMITS.AGENT_CLAIM_INIT);
  if (!limit.allowed) {
    auditRequest(request, { eventType: 'security.rate.limited', userId: caller.agentUserId, resourceType: 'agent_claim', details: { agentAuthEvent: 'claim_start_rate_limited', bucket: 'agent', door }, riskScore: 0.4 });
    return agentRateLimited(limit.retryAfter);
  }

  const started = await startOwnAgentClaim({ agentUserId: caller.agentUserId, now: new Date() });
  if (!started.ok && started.error === 'already_claimed') {
    // The agent asking about ITSELF: it already knows its owner from /api/auth/me.
    return agentNoStoreJson({ error: 'already_claimed' }, 409);
  }
  if (!started.ok) return refuse(started.error);

  auditRequest(request, {
    eventType: 'data.write',
    userId: caller.agentUserId,
    resourceType: 'agent_claim',
    resourceId: caller.agentUserId,
    details: { agentAuthEvent: 'claim_started', door, expiresIn: CLAIM_TTL_SECONDS },
  });

  const verificationUri = agentClaimPageUrl(agentIssuer());
  return agentNoStoreJson({
    user_code: started.userCode,
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(started.userCode)}`,
    expires_in: CLAIM_TTL_SECONDS,
    interval: CLAIM_POLL_INTERVAL_SECONDS,
  }, 200);
}
