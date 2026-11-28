/**
 * POST /api/auth/agent/signin — an AI agent signs in at the BROWSER door with
 * its `ps_agent_*` secret (Agent Signup Phase 3, ADR 0008, threat model T3).
 *
 * Controls, in order: the deployment gate (closed → 404), zod on the body, the
 * login-CSRF token (before any bucket is spent), the per-IP AGENT_SIGNIN limit
 * (LOGIN's shape: guessing a secret is credential stuffing), then
 * `verifyAgentSecret` — shape check, lookup by `hashToken(secret)`, the frozen
 * `decideAgentSignin`. The decision is typed so the route can audit the real
 * reason and count a failure against a matched account's lockout; on the wire
 * every refusal collapses (`collapseAgentSigninDecision`) to ONE constant 401,
 * so an unknown, revoked, suspended or locked agent are indistinguishable.
 *
 * The IP bucket is deliberately NOT reset on success (unlike passkey login): a
 * caller holding one valid secret could otherwise interleave it with guesses
 * and never run out of attempts.
 *
 * On success: lockout counters cleared, prior sessions on this device revoked,
 * the passkey-signup session chain (`startAgentBrowserSession`), and the home
 * drive provisioned (idempotent; signup's provisioning may have failed).
 */
import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { getClientIP, revokeSessionsForLogin, validateLoginCSRFToken } from '@/lib/auth';
import { agentNoStoreJson, agentNotFound, agentRateLimited, isAgentDoorOpen } from '@/lib/agent-auth/door';
import { agentRedirectUrl, startAgentBrowserSession } from '@/lib/agent-auth/browser-session';
import { authRepository } from '@/lib/repositories/auth-repository';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { checkDistributedRateLimit, DISTRIBUTED_RATE_LIMITS } from '@pagespace/lib/security/distributed-rate-limit';
import { recordFailedLoginAttempt, resetFailedLoginAttempts } from '@pagespace/lib/auth/account-lockout';
import { AGENT_SIGNIN_WIRE_ERROR, collapseAgentSigninDecision } from '@pagespace/lib/auth/agent/signin-decision';
import { agentRateLimitAddress } from '@pagespace/lib/auth/agent/token-rate-limit-keys';
import { provisionHomeDriveIfNeeded } from '@pagespace/lib/onboarding/home-drive';
import { AgentIdentityStoreError, verifyAgentSecret } from '@pagespace/lib/services/agent-identities';
import { loggers } from '@pagespace/lib/logging/logger-config';

export const dynamic = 'force-dynamic';

const signinSchema = z.object({
  // Bounded only: the shape check lives in verifyAgentSecret so a malformed
  // secret gets the SAME 401 as an unknown one, not a distinguishable 400.
  secret: z.string().min(1).max(256),
  csrfToken: z.string().min(1).max(512),
  platform: z.literal('web').optional(),
  deviceId: z.string().min(1).max(128).optional(),
  deviceName: z.string().max(256).optional(),
  next: z.string().max(2048).optional(),
});

/** The one refusal every failed sign-in becomes on the wire. */
function invalidCredentials(): NextResponse {
  return agentNoStoreJson({ error: AGENT_SIGNIN_WIRE_ERROR }, 401);
}

export async function POST(request: Request) {
  try {
    return await signin(request);
  } catch (error) {
    if (!(error instanceof AgentIdentityStoreError)) throw error;
    auditRequest(request, { eventType: 'auth.login.failure', resourceType: 'agent_identity', details: { agentAuthEvent: 'browser_signin_refused', reason: 'store_failed', operation: error.operation, code: error.redacted.code }, riskScore: 0.1 });
    return agentNoStoreJson({ error: 'temporarily_unavailable' }, 503);
  }
}

async function signin(request: Request) {
  if (!isAgentDoorOpen()) {
    auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'agent_identity', details: { reason: 'agent_signup_disabled', door: 'browser_signin' }, riskScore: 0.1 });
    return agentNotFound();
  }

  const raw: unknown = await request.json().catch(() => null);
  const parsed = signinSchema.safeParse(raw);
  if (!parsed.success) return agentNoStoreJson({ error: 'invalid_request' }, 400);
  const body = parsed.data;

  if (!validateLoginCSRFToken(body.csrfToken)) {
    auditRequest(request, { eventType: 'security.suspicious.activity', resourceType: 'agent_identity', details: { reason: 'agent_signin_csrf_invalid' }, riskScore: 0.6 });
    return agentNoStoreJson({ error: 'invalid_csrf' }, 403);
  }

  const ip = getClientIP(request);
  const limit = await checkDistributedRateLimit(`agent-signin:ip:${agentRateLimitAddress(ip)}`, DISTRIBUTED_RATE_LIMITS.AGENT_SIGNIN);
  if (!limit.allowed) {
    auditRequest(request, { eventType: 'security.rate.limited', resourceType: 'agent_identity', details: { agentAuthEvent: 'browser_signin_rate_limited' }, riskScore: 0.5 });
    return agentRateLimited(limit.retryAfter);
  }

  const verified = await verifyAgentSecret({ secret: body.secret, now: new Date() });
  const wire = collapseAgentSigninDecision(verified.decision);
  if (!wire.ok || verified.userId === null) {
    // Only a secret that MATCHED an account can count toward that account's
    // lockout; an unknown secret names nobody.
    if (verified.userId !== null) await recordFailedLoginAttempt(verified.userId);
    auditRequest(request, {
      eventType: 'auth.login.failure',
      resourceType: 'agent_identity',
      ...(verified.userId !== null && { userId: verified.userId, resourceId: verified.userId }),
      details: { agentAuthEvent: 'browser_signin_refused', reason: verified.decision.status },
      riskScore: 0.4,
    });
    return invalidCredentials();
  }

  const userId = verified.userId;
  await resetFailedLoginAttempts(userId);

  const user = await authRepository.findUserById(userId);
  if (!user) return invalidCredentials();

  await revokeSessionsForLogin(userId, body.deviceId, 'agent_secret_login', 'agent_secret');

  const session = await startAgentBrowserSession({
    request,
    userId,
    tokenVersion: user.tokenVersion,
    clientIP: ip,
    deviceId: body.deviceId,
    deviceName: body.deviceName,
  });
  if (!session.ok) return agentNoStoreJson({ error: 'temporarily_unavailable' }, 503);

  try {
    await provisionHomeDriveIfNeeded(userId);
  } catch (error) {
    loggers.auth.error('Failed to provision Home drive on agent browser sign-in', error as Error, { userId });
  }

  auditRequest(request, {
    eventType: 'auth.login.success',
    userId,
    sessionId: session.sessionId,
    resourceType: 'agent_identity',
    resourceId: userId,
    details: { method: 'agent_secret' },
  });

  return NextResponse.json({
    success: true,
    agentId: userId,
    accountType: 'agent',
    csrfToken: session.csrfToken,
    ...(session.deviceToken && { deviceToken: session.deviceToken }),
    redirectUrl: agentRedirectUrl(body.next),
  }, { status: 200, headers: session.headers });
}
