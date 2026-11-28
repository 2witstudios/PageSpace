/**
 * Connecting a Google account to an agent, the browser half (slice 3; ADR
 * 0005 §10d). The tokens never come here: Google redirects the browser back
 * with a one-time code, and the credential plane — not this process — trades
 * it for tokens with its own OAuth client.
 *
 * Stateless, three bindings:
 * - `state` is signed (HMAC under a key derived from `OAUTH_STATE_SECRET`) and
 *   names the person, the owner, what they asked for and an expiry (10 min).
 *   Prefixed `aa1.` so a shared callback route can tell it from other flows.
 * - A `SameSite=Lax` cookie carries the state's random nonce: the callback
 *   refuses a state that the SAME browser did not start (no one can hand a
 *   person a link that connects an account they never chose).
 * - PKCE (S256): the code verifier is derived from the nonce under the same
 *   secret, so a code intercepted on the way back is useless on its own.
 */
import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { secureCompare } from '@pagespace/lib/auth/secure-compare';
import type { AccountOwnerTarget } from '@pagespace/lib/agent-accounts/account-authority-executor';
import type { GoogleEnrollmentInput } from '@pagespace/lib/agent-accounts/oauth/google-enrollment';

export const ENROLLMENT_STATE_PREFIX = 'aa1.';
export const ENROLLMENT_COOKIE = 'ps_agent_account_oauth';
export const ENROLLMENT_TTL_MS = 10 * 60_000;
const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

export type EnrollmentState = {
  readonly userId: string;
  readonly owner: AccountOwnerTarget;
  readonly input: GoogleEnrollmentInput;
  /** A same-site path to send the person back to. */
  readonly returnTo: string;
  readonly nonce: string;
  readonly expiresAt: number;
};

/** A 32-byte key per purpose, derived from the server's high-entropy state secret with HKDF (RFC 5869). */
const keyOf = (secret: string, purpose: string) => Buffer.from(hkdfSync('sha256', secret, 'pagespace-agent-account-oauth', `v1/${purpose}`, 32));
const sign = (secret: string, payload: string) => createHmac('sha256', keyOf(secret, 'state')).update(payload).digest('base64url');

/** RFC 7636 §4.1: 43–128 unreserved characters. 32 bytes of HMAC → 43 base64url characters. */
export function codeVerifierFor(secret: string, nonce: string): string {
  return createHmac('sha256', keyOf(secret, 'pkce')).update(nonce).digest('base64url');
}

export function codeChallengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function createEnrollmentState({ secret, userId, owner, input, returnTo, now }: { readonly secret: string; readonly userId: string; readonly owner: AccountOwnerTarget; readonly input: GoogleEnrollmentInput; readonly returnTo: string; readonly now: number }): { readonly state: string; readonly nonce: string } {
  const nonce = randomBytes(24).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ userId, owner, input, returnTo, nonce, expiresAt: now + ENROLLMENT_TTL_MS } satisfies EnrollmentState)).toString('base64url');
  return { state: `${ENROLLMENT_STATE_PREFIX}${payload}.${sign(secret, payload)}`, nonce };
}

/** The state's contents when its signature verifies, it has not expired and it is this flow's; otherwise null. */
export function readEnrollmentState({ secret, state, now }: { readonly secret: string; readonly state: string; readonly now: number }): EnrollmentState | null {
  if (!state.startsWith(ENROLLMENT_STATE_PREFIX)) return null;
  const [payload, signature, ...rest] = state.slice(ENROLLMENT_STATE_PREFIX.length).split('.');
  if (payload === undefined || signature === undefined || rest.length > 0 || !secureCompare(signature, sign(secret, payload))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as EnrollmentState;
    return typeof parsed.expiresAt === 'number' && parsed.expiresAt > now && typeof parsed.nonce === 'string' && typeof parsed.userId === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** Google's consent screen, asking for exactly these scopes, offline (a refresh token) and the account picker. */
export function googleAuthorizeUrl({ clientId, redirectUri, scopes, state, codeChallenge }: { readonly clientId: string; readonly redirectUri: string; readonly scopes: readonly string[]; readonly state: string; readonly codeChallenge: string }): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    // consent: always issue a refresh token; select_account: never silently reuse the person's own login.
    prompt: 'consent select_account',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Where Google sends the browser back. It must be registered on the OAuth client. Until a dedicated
 * `/api/agent-accounts/oauth/google/callback` is registered (then set `AGENT_ACCOUNTS_GOOGLE_REDIRECT_URI`),
 * the already-registered Google Calendar callback is used; it hands `aa1.` states to this flow.
 */
export function googleRedirectUri(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const explicit = env.AGENT_ACCOUNTS_GOOGLE_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const base = (env.WEB_APP_URL || env.NEXTAUTH_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}/api/integrations/google-calendar/callback`;
}
