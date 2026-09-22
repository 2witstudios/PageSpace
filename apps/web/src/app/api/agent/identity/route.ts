/**
 * POST /api/agent/identity — the agent API door's registration endpoint (ADR 0007;
 * auth.md "Register"). Public and unauthenticated: the caller is an AI agent
 * that holds no identity yet; this call creates one.
 *
 * Controls, in order: the deployment gate (closed → 404, revealing nothing), the
 * per-IP AGENT_SIGNUP and AGENT_SIGNUP_DAILY limits, zod on the body, then the
 * frozen Phase 0 decision over the facts — challenge lookup, PoW verified
 * against the difficulty STORED on the challenge, ToS acceptance.
 * `createAgentAccount` consumes the challenge atomically with the account
 * insert, so a replay that races past the lookup still creates nothing.
 *
 * Wire shape: a bad proof is 403 `pow_invalid` (re-solve, don't re-fetch);
 * every other failure is ONE 400 body. The response is the only place the
 * `ps_agent_*` secret ever leaves the server (threat model §3): it is never
 * logged or audited.
 */
import { z } from 'zod/v4';
import { getClientIP } from '@/lib/auth';
import { agentIssuer, agentNoStoreJson, agentNotFound, agentRateLimited, isAgentDoorOpen } from '@/lib/agent-auth/door';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { verifyPowSolution, POW_NONCE_MAX_LENGTH } from '@pagespace/lib/auth/agent/pow';
import { decideAgentSignup } from '@pagespace/lib/auth/agent/signup-decision';
import { buildServerMetadata, AGENT_ASSERTION_GRANT_TYPE } from '@pagespace/lib/auth/oauth/metadata';
import { PAGESPACE_AGENT_CLIENT_ID } from '@pagespace/lib/auth/oauth/clients';
import { createAgentAccount, findAgentSignupChallenge } from '@pagespace/lib/services/agent-identities';

export const dynamic = 'force-dynamic';

const DEFAULT_AGENT_NAME = 'Agent';

const identityRequestSchema = z.object({
  type: z.literal('anonymous'),
  name: z.string().trim().min(1).max(80).optional(),
  source: z.string().trim().min(1).max(120).optional(),
  // Accepted and bounded for auth.md compatibility; nothing is stored or granted from it.
  capabilities: z.array(z.string().max(40)).max(10).optional(),
  // A boolean, not literal(true): `false` reaches decideAgentSignup, which reports
  // tos_required only after the PoW is paid for (Phase 0 precedence).
  tos_accepted: z.boolean(),
  pow: z.object({
    challenge: z.string().min(1).max(256),
    nonce: z.string().min(1).max(POW_NONCE_MAX_LENGTH),
  }),
});

const INVALID_REQUEST = { error: 'invalid_request' } as const;

export async function POST(request: Request) {
  if (!isAgentDoorOpen()) {
    auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'agent_identity', details: { reason: 'agent_signup_disabled' }, riskScore: 0.1 });
    return agentNotFound();
  }

  const ip = getClientIP(request);
  const hourly = await checkDistributedRateLimit(`agent-signup:ip:${ip}`, DISTRIBUTED_RATE_LIMITS.AGENT_SIGNUP);
  const daily = hourly.allowed
    ? await checkDistributedRateLimit(`agent-signup-daily:ip:${ip}`, DISTRIBUTED_RATE_LIMITS.AGENT_SIGNUP_DAILY)
    : null;
  if (!hourly.allowed || (daily && !daily.allowed)) {
    const limited = !hourly.allowed ? hourly : daily;
    auditRequest(request, { eventType: 'security.rate.limited', resourceType: 'agent_identity', details: { agentAuthEvent: 'signup_rate_limited', window: !hourly.allowed ? 'hourly' : 'daily' }, riskScore: 0.5 });
    return agentRateLimited(limited?.retryAfter);
  }

  const refuse = (reason: string) => {
    auditRequest(request, { eventType: 'auth.login.failure', resourceType: 'agent_identity', details: { agentAuthEvent: 'signup_refused', reason }, riskScore: 0.4 });
    return agentNoStoreJson(INVALID_REQUEST, 400);
  };

  const raw: unknown = await request.json().catch(() => null);
  const parsed = identityRequestSchema.safeParse(raw);
  if (!parsed.success) return refuse('invalid_request');
  const body = parsed.data;

  const now = new Date();
  const challenge = await findAgentSignupChallenge({ challenge: body.pow.challenge, now });
  const powValid = challenge.found
    && verifyPowSolution({ challenge: body.pow.challenge, nonce: body.pow.nonce, difficultyBits: challenge.difficultyBits });

  const decision = decideAgentSignup({ enabled: true, challenge, powValid, tosAccepted: body.tos_accepted });
  if (decision.status === 'pow_invalid') {
    auditRequest(request, { eventType: 'auth.login.failure', resourceType: 'agent_identity', details: { agentAuthEvent: 'signup_refused', reason: 'pow_invalid' }, riskScore: 0.4 });
    return agentNoStoreJson({ error: 'pow_invalid' }, 403);
  }
  if (decision.status !== 'ok' || challenge.id === null) return refuse(decision.status);

  const created = await createAgentAccount({
    name: body.name ?? DEFAULT_AGENT_NAME,
    source: body.source ?? null,
    tosAcceptedAt: now,
    createdByIp: ip,
    challengeId: challenge.id,
    now,
  });
  if (!created.ok) return refuse('challenge_consumed_concurrently');

  const { userId, secret, claimToken } = created.data;
  auditRequest(request, {
    eventType: 'auth.token.created',
    userId,
    resourceType: 'agent_identity',
    resourceId: userId,
    details: { agentAuthEvent: 'agent_registered', source: body.source ?? null, difficultyBits: decision.difficultyBits },
  });

  const metadata = buildServerMetadata({ issuer: agentIssuer() });
  return agentNoStoreJson({
    identity_assertion: secret,
    agent_id: userId,
    claim_token: claimToken,
    account_type: 'agent',
    token_endpoint: metadata.token_endpoint,
    grant_type: AGENT_ASSERTION_GRANT_TYPE,
    client_id: PAGESPACE_AGENT_CLIENT_ID,
    claim_endpoint: metadata.agent_auth.claim_endpoint,
  }, 200);
}
