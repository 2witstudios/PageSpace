/**
 * The browser door's session chain (Agent Signup Phase 3): what passkey signup
 * does once it has a user, minus every email-shaped step (no invites, no
 * verification email). Shared by `POST /api/auth/agent/signup` and
 * `POST /api/auth/agent/signin` so the two cannot drift.
 *
 * createSession → validateSession → generateCSRFToken → appendSessionCookie →
 * optional web device token, and `lastAuthAt` stamped (a session is an
 * authentication; the lifecycle sweep keys on it). The session records the agent-secret ceremony
 * (one factor, D-OW-45). Decides nothing: the routes run the frozen Phase 0
 * decisions before calling this.
 */
import { sessionService } from '@pagespace/lib/auth/session-service';
import { generateCSRFToken } from '@pagespace/lib/auth/csrf-utils';
import { SESSION_DURATION_MS } from '@pagespace/lib/auth/constants';
import { ceremonyAuthentication } from '@pagespace/lib/auth/authentication-evidence';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { recordAgentAuthentication } from '@pagespace/lib/services/agent-identities';
import { createDeviceToken } from '@/lib/auth';
import { appendSessionCookie } from '@/lib/auth/cookie-config';
import { isSafeNextPath, SIGNIN_NEXT_ALLOWED_PREFIXES } from '@/lib/auth/url-utils';

interface AgentBrowserSessionInput {
  request: Request;
  userId: string;
  /** `users.tokenVersion` — the device token carries it so a revoke kills it. */
  tokenVersion: number;
  clientIP: string;
  deviceId?: string;
  deviceName?: string;
}

export type AgentBrowserSession =
  | { ok: true; csrfToken: string; sessionId: string; headers: Headers; deviceToken: string | null }
  | { ok: false };

export async function startAgentBrowserSession(input: AgentBrowserSessionInput): Promise<AgentBrowserSession> {
  const { request, userId, deviceId } = input;
  const ipAddress = input.clientIP !== 'unknown' ? input.clientIP : undefined;
  const authentication = ceremonyAuthentication({ method: 'agent_secret' }, Date.now());

  const sessionToken = await sessionService.createSession({
    authentication,
    userId,
    type: 'user',
    scopes: ['*'],
    expiresInMs: SESSION_DURATION_MS,
    deviceId,
    createdByIp: ipAddress,
  });

  const claims = await sessionService.validateSession(sessionToken);
  if (!claims) {
    loggers.auth.error('Failed to validate newly created agent session', { userId });
    return { ok: false };
  }

  // A session is an authentication: stamp it, or the lifecycle sweep would
  // erase a browser-door agent that only ever used its cookie (security review).
  // Best effort — the store has already logged a redacted failure, and the
  // next sign-in or token refresh stamps again; losing the session is worse.
  try {
    await recordAgentAuthentication({ userId, now: new Date() });
  } catch {
    loggers.auth.warn('Failed to stamp agent authentication on session start', { userId });
  }

  const csrfToken = generateCSRFToken(claims.sessionId);

  let deviceToken: string | null = null;
  if (deviceId) {
    const userAgent = request.headers.get('user-agent') ?? undefined;
    try {
      deviceToken = await createDeviceToken({
        authentication,
        userId,
        deviceId,
        tokenVersion: input.tokenVersion,
        platform: 'web',
        deviceName: input.deviceName || userAgent || 'Web Browser',
        userAgent,
        ipAddress,
      });
    } catch (error) {
      // Silent-recovery convenience only: the session above already stands.
      loggers.auth.warn('Failed to create agent device token', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const headers = new Headers();
  headers.set('Cache-Control', 'no-store');
  appendSessionCookie(headers, sessionToken);
  const secureFlag = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  headers.append('Set-Cookie', `csrf_token=${csrfToken}; Path=/; HttpOnly=false; SameSite=Lax; Max-Age=60${secureFlag}`);

  return { ok: true, csrfToken, sessionId: claims.sessionId, headers, deviceToken };
}

/** Where the browser goes next: a validated `next`, else the dashboard. */
export function agentRedirectUrl(next: string | undefined): string {
  return next && isSafeNextPath({ path: next, allowedPrefixes: SIGNIN_NEXT_ALLOWED_PREFIXES }) ? next : '/dashboard';
}
