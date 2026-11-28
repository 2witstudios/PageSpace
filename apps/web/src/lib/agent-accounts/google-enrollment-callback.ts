/**
 * The Google callback for connecting an agent account (slice 3). Reached from
 * `/api/agent-accounts/oauth/google/callback`, or from the Google Calendar
 * callback when it sees an `aa1.` state (the URI Google already knows).
 *
 * The person's session cookie may be `SameSite=Strict` and so absent on this
 * cross-site redirect: the signed state names the person, the binding cookie
 * proves this browser started it, and PKCE ties the code to both. Every
 * outcome is a redirect back to where the person started, with one word.
 */
import { NextResponse } from 'next/server';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isOnPrem } from '@pagespace/lib/deployment-mode';
import { credentialActor } from '@pagespace/lib/permissions/access-actor';
import { secureCompare } from '@pagespace/lib/auth/secure-compare';
import { getAccountAuthority } from './account-authority-client';
import { codeVerifierFor, ENROLLMENT_COOKIE, googleRedirectUri, readEnrollmentState } from './google-enrollment-flow';

const baseUrl = () => process.env.WEB_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';
const FALLBACK_RETURN = '/settings/agent-accounts';

/** A redirect to the person's own path on THIS site; anything that resolves elsewhere goes to the fallback. */
function back(returnTo: string, outcome: string): NextResponse {
  const base = new URL(baseUrl());
  let url = new URL(FALLBACK_RETURN, base);
  try {
    const candidate = new URL(returnTo, base);
    if (candidate.origin === base.origin && !/[\\\x00-\x1F\x7F]/.test(returnTo)) url = candidate;
  } catch {
    // keep the fallback
  }
  url.searchParams.set('agentAccount', outcome);
  const response = NextResponse.redirect(url);
  // The binding cookie is single-use: cleared whatever the outcome.
  response.headers.append('set-cookie', `${ENROLLMENT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  return response;
}

function cookieOf(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return null;
}

export async function handleAgentAccountGoogleCallback(request: Request): Promise<Response> {
  if (isOnPrem()) return Response.json({ error: 'Not available' }, { status: 404 });
  const secret = process.env.OAUTH_STATE_SECRET;
  const fallback = FALLBACK_RETURN;
  const params = new URL(request.url).searchParams;
  const state = secret ? readEnrollmentState({ secret, state: params.get('state') ?? '', now: Date.now() }) : null;
  if (secret === undefined || state === null) return back(fallback, 'expired');
  const returnTo = state.returnTo.startsWith('/') && !state.returnTo.startsWith('//') ? state.returnTo : fallback;

  // This browser started this flow: its binding cookie carries the state's nonce. A browser that did not is
  // sent to the fixed page, never to the state's path (a link someone else minted).
  const nonce = cookieOf(request, ENROLLMENT_COOKIE);
  if (nonce === null || !secureCompare(nonce, state.nonce)) return back(fallback, 'expired');
  const error = params.get('error');
  if (error !== null) return back(returnTo, error === 'access_denied' ? 'cancelled' : 'refused');
  const code = params.get('code');
  if (code === null || code.length === 0 || code.length > 4_096) return back(returnTo, 'refused');

  const authority = getAccountAuthority();
  if (authority === null) return back(returnTo, 'not_configured');
  try {
    const result = await authority.completeOAuthEnrollment({
      actor: credentialActor(state.userId, null),
      owner: state.owner,
      input: state.input,
      code,
      codeVerifier: codeVerifierFor(secret, state.nonce),
      redirectUri: googleRedirectUri(),
    });
    if (!result.ok) {
      loggers.api.warn('Agent account Google connect refused', { reason: result.reason, detail: 'detail' in result ? result.detail : undefined });
      return back(returnTo, result.reason === 'provider_refused' ? result.detail : result.reason);
    }
    auditRequest(request, { eventType: 'authz.permission.granted', userId: state.userId, resourceType: 'agent_account', resourceId: result.account.id, details: { change: 'connect', provider: 'google' } });
    return back(returnTo, 'connected');
  } catch (failure) {
    loggers.api.error('Error connecting a Google agent account', failure as Error);
    return back(returnTo, 'failed');
  }
}
