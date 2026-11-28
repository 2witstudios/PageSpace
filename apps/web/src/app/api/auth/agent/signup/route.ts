/**
 * POST /api/auth/agent/signup — the agent BROWSER door's registration (Agent
 * Signup Phase 3, ADR 0008). The browser twin of `POST /api/agent/identity`:
 * a computer-use agent on `/auth/agent?mode=signup` solves the proof of work in
 * a web worker and posts it here, and leaves signed in.
 *
 * Controls, in order: the deployment gate (closed → 404, revealing nothing),
 * zod on the body, the login-CSRF token (before any bucket is spent, like
 * passkey signup), the per-IP AGENT_SIGNUP and AGENT_SIGNUP_DAILY limits —
 * the SAME buckets the API door spends, so using both doors never doubles an
 * IP's allowance — then the frozen Phase 0 decision over the facts (challenge
 * lookup, PoW verified against the STORED difficulty, ToS). `createAgentAccount`
 * consumes the challenge atomically and enforces the deployment-wide budget.
 *
 * Then the passkey-signup session chain without its email-shaped steps
 * (`startAgentBrowserSession`). This response is the only one that ever
 * carries the `ps_agent_*` secret (threat model §3): never logged or audited.
 * If the session cannot start after the account is committed, the secret is
 * still returned (it exists nowhere else) and the agent is sent to sign in.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { getClientIP, validateLoginCSRFToken } from '@/lib/auth';
import { agentNoStoreJson, agentNotFound, agentRateLimited, isAgentDoorOpen } from '@/lib/agent-auth/door';
import { agentRedirectUrl, startAgentBrowserSession, type AgentBrowserSession } from '@/lib/agent-auth/browser-session';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit, refundDistributedRateLimitAttempt, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { verifyPowSolution, POW_NONCE_MAX_LENGTH } from '@pagespace/lib/auth/agent/pow';
import { decideAgentSignup } from '@pagespace/lib/auth/agent/signup-decision';
import { agentRateLimitAddress } from '@pagespace/lib/auth/agent/token-rate-limit-keys';
import { AgentIdentityStoreError, createAgentAccount, findAgentSignupChallenge } from '@pagespace/lib/services/agent-identities';
import { loggers } from '@pagespace/lib/logging/logger-config';

export const dynamic = 'force-dynamic';

/** createAgentAccount inserts every agent at tokenVersion 1. */
const NEW_AGENT_TOKEN_VERSION = 1;

const signupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  source: z.string().trim().min(1).max(120).optional(),
  // A boolean, not literal(true): `false` reaches decideAgentSignup, which reports
  // tos_required only after the PoW is paid for (Phase 0 precedence).
  tosAccepted: z.boolean(),
  pow: z.object({
    challenge: z.string().min(1).max(256),
    nonce: z.string().min(1).max(POW_NONCE_MAX_LENGTH),
  }),
  csrfToken: z.string().min(1).max(512),
  // Web only: the desktop shell signs in through its own external-browser handoff.
  platform: z.literal('web').optional(),
  deviceId: z.string().min(1).max(128).optional(),
  deviceName: z.string().max(256).optional(),
  next: z.string().max(2048).optional(),
});

const INVALID_REQUEST = { error: 'invalid_request' } as const;

export async function POST(request: Request) {
  try {
    return await signup(request);
  } catch (error) {
    if (!(error instanceof AgentIdentityStoreError)) throw error;
    auditRequest(request, { eventType: 'auth.login.failure', resourceType: 'agent_identity', details: { agentAuthEvent: 'browser_signup_refused', reason: 'store_failed', operation: error.operation, code: error.redacted.code }, riskScore: 0.1 });
    return agentNoStoreJson({ error: 'temporarily_unavailable' }, 503);
  }
}

async function signup(request: Request) {
  if (!isAgentDoorOpen()) {
    auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'agent_identity', details: { reason: 'agent_signup_disabled', door: 'browser' }, riskScore: 0.1 });
    return agentNotFound();
  }

  const refuse = (reason: string) => {
    auditRequest(request, { eventType: 'auth.login.failure', resourceType: 'agent_identity', details: { agentAuthEvent: 'browser_signup_refused', reason }, riskScore: 0.4 });
    return agentNoStoreJson(INVALID_REQUEST, 400);
  };

  const raw: unknown = await request.json().catch(() => null);
  const parsed = signupSchema.safeParse(raw);
  if (!parsed.success) return refuse('invalid_request');
  const body = parsed.data;

  // Stateless HMAC check before any bucket: a stale form never burns an attempt.
  if (!validateLoginCSRFToken(body.csrfToken)) {
    auditRequest(request, { eventType: 'security.suspicious.activity', resourceType: 'agent_identity', details: { reason: 'agent_signup_csrf_invalid' }, riskScore: 0.6 });
    return agentNoStoreJson({ error: 'invalid_csrf' }, 403);
  }

  const ip = getClientIP(request);
  const bucket = agentRateLimitAddress(ip);
  const hourlyKey = `agent-signup:ip:${bucket}`;
  const dailyKey = `agent-signup-daily:ip:${bucket}`;
  const hourly = await checkDistributedRateLimit(hourlyKey, DISTRIBUTED_RATE_LIMITS.AGENT_SIGNUP);
  const daily = hourly.allowed
    ? await checkDistributedRateLimit(dailyKey, DISTRIBUTED_RATE_LIMITS.AGENT_SIGNUP_DAILY)
    : null;
  if (!hourly.allowed || (daily && !daily.allowed)) {
    const limited = !hourly.allowed ? hourly : daily;
    auditRequest(request, { eventType: 'security.rate.limited', resourceType: 'agent_identity', details: { agentAuthEvent: 'browser_signup_rate_limited', window: !hourly.allowed ? 'hourly' : 'daily' }, riskScore: 0.5 });
    return agentRateLimited(limited?.retryAfter);
  }

  const now = new Date();
  const challenge = await findAgentSignupChallenge({ challenge: body.pow.challenge, now });
  const powValid = challenge.found
    && verifyPowSolution({ challenge: body.pow.challenge, nonce: body.pow.nonce, difficultyBits: challenge.difficultyBits });

  const decision = decideAgentSignup({ enabled: true, challenge, powValid, tosAccepted: body.tosAccepted });
  if (decision.status === 'pow_invalid') {
    auditRequest(request, { eventType: 'auth.login.failure', resourceType: 'agent_identity', details: { agentAuthEvent: 'browser_signup_refused', reason: 'pow_invalid' }, riskScore: 0.4 });
    return agentNoStoreJson({ error: 'pow_invalid' }, 403);
  }
  if (decision.status !== 'ok' || challenge.id === null) return refuse(decision.status);

  const created = await createAgentAccount({
    name: body.name,
    source: body.source ?? null,
    tosAcceptedAt: now,
    createdByIp: ip,
    challengeId: challenge.id,
    now,
  });
  if (!created.ok && created.error === 'signup_budget_exhausted') {
    // The deployment's budget refused this, not the caller: give back the two
    // per-IP attempts (see the API door), and answer exactly like a per-IP limit.
    await Promise.all([
      refundDistributedRateLimitAttempt(hourlyKey, DISTRIBUTED_RATE_LIMITS.AGENT_SIGNUP.windowMs),
      refundDistributedRateLimitAttempt(dailyKey, DISTRIBUTED_RATE_LIMITS.AGENT_SIGNUP_DAILY.windowMs),
    ]);
    auditRequest(request, { eventType: 'security.rate.limited', resourceType: 'agent_identity', details: { agentAuthEvent: 'browser_signup_rate_limited', window: 'global' }, riskScore: 0.5 });
    return agentRateLimited(created.retryAfterSeconds);
  }
  if (!created.ok) return refuse('challenge_consumed_concurrently');

  const { userId, secret, claimToken } = created.data;
  auditRequest(request, {
    eventType: 'auth.token.created',
    userId,
    resourceType: 'agent_identity',
    resourceId: userId,
    details: { agentAuthEvent: 'agent_registered', door: 'browser', source: body.source ?? null, difficultyBits: decision.difficultyBits },
  });

  let session: AgentBrowserSession;
  try {
    session = await startAgentBrowserSession({
      request,
      userId,
      tokenVersion: NEW_AGENT_TOKEN_VERSION,
      clientIP: ip,
      deviceId: body.deviceId,
      deviceName: body.deviceName,
    });
  } catch (error) {
    loggers.auth.error('Agent browser signup: session chain failed after the account was created', error as Error, { userId });
    session = { ok: false };
  }

  const identity = { success: true, agentId: userId, accountType: 'agent', secret, claimToken } as const;

  if (!session.ok) {
    // The account and its only copy of the secret exist: hand the secret over and
    // let the agent sign in with it, rather than lose the account.
    return agentNoStoreJson({ ...identity, sessionStarted: false, redirectUrl: '/auth/agent?mode=signin' }, 200);
  }

  auditRequest(request, {
    eventType: 'auth.login.success',
    userId,
    sessionId: session.sessionId,
    resourceType: 'agent_identity',
    resourceId: userId,
    details: { signup: true, method: 'agent_secret' },
  });

  return NextResponse.json({
    ...identity,
    csrfToken: session.csrfToken,
    ...(session.deviceToken && { deviceToken: session.deviceToken }),
    redirectUrl: agentRedirectUrl(body.next),
  }, { status: 200, headers: session.headers });
}
