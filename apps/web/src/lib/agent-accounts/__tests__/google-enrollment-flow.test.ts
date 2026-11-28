/**
 * Slice 3 — the browser half of connecting a Google account. Pinned: a state
 * is honoured only with its own signature, before it expires; the PKCE
 * verifier is a function of the server secret and the state's nonce (43
 * chars, RFC 7636) and its S256 challenge is what Google is shown; the
 * consent URL asks offline, with the account picker, for exactly the scopes.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { codeChallengeOf, codeVerifierFor, createEnrollmentState, ENROLLMENT_STATE_PREFIX, googleAuthorizeUrl, googleRedirectUri, readEnrollmentState } from '../google-enrollment-flow';

const SECRET = 'state-secret-for-tests-0123456789abcdef';
const NOW = 1_800_000_000_000;
const input = { name: 'Agent Google', services: ['gmail.read'], ownership: 'dedicated' as const, acknowledged: false, autoApproveReads: true };
const make = () => createEnrollmentState({ secret: SECRET, userId: 'user_1', owner: { kind: 'agent_page', agentPageId: 'page_a' }, input, returnTo: '/p/page_a', now: NOW });

describe('enrollment state', () => {
  it('given its own state before expiry, should read back the person, owner, input and nonce', () => {
    const { state, nonce } = make();
    const actual = readEnrollmentState({ secret: SECRET, state, now: NOW + 1_000 });
    expect({ prefixed: state.startsWith(ENROLLMENT_STATE_PREFIX), read: actual && { userId: actual.userId, owner: actual.owner, input: actual.input, nonce: actual.nonce === nonce } }).toEqual({
      prefixed: true,
      read: { userId: 'user_1', owner: { kind: 'agent_page', agentPageId: 'page_a' }, input, nonce: true },
    });
  });

  it('given an expired state, another secret, a tampered payload or another flow\'s state, should read nothing', () => {
    const { state } = make();
    const [payload, signature] = state.slice(ENROLLMENT_STATE_PREFIX.length).split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), userId: 'attacker' })).toString('base64url');
    const actual = [
      readEnrollmentState({ secret: SECRET, state, now: NOW + 11 * 60_000 }),
      readEnrollmentState({ secret: 'another-secret-entirely-0123456789', state, now: NOW }),
      readEnrollmentState({ secret: SECRET, state: `${ENROLLMENT_STATE_PREFIX}${forged}.${signature}`, now: NOW }),
      readEnrollmentState({ secret: SECRET, state: Buffer.from('{"data":{},"sig":"x"}').toString('base64'), now: NOW }),
    ];
    expect(actual).toEqual([null, null, null, null]);
  });
});

describe('PKCE and the consent URL', () => {
  it('given a nonce, should derive a stable 43-character verifier and its S256 challenge', () => {
    const verifier = codeVerifierFor(SECRET, 'nonce_1');
    expect({ length: verifier.length, stable: verifier === codeVerifierFor(SECRET, 'nonce_1'), differs: verifier !== codeVerifierFor(SECRET, 'nonce_2'), challenge: codeChallengeOf(verifier) === createHash('sha256').update(verifier).digest('base64url') }).toEqual({ length: 43, stable: true, differs: true, challenge: true });
  });

  it('given scopes, should ask Google offline, with the account picker, S256, for exactly those scopes', () => {
    const url = new URL(googleAuthorizeUrl({ clientId: 'cid', redirectUri: 'https://pagespace.ai/cb', scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'], state: 'aa1.x.y', codeChallenge: 'ch' }));
    const actual = Object.fromEntries(url.searchParams.entries());
    expect({ origin: url.origin, ...actual }).toEqual({
      origin: 'https://accounts.google.com',
      client_id: 'cid',
      redirect_uri: 'https://pagespace.ai/cb',
      response_type: 'code',
      scope: 'openid email https://www.googleapis.com/auth/gmail.readonly',
      access_type: 'offline',
      prompt: 'consent select_account',
      state: 'aa1.x.y',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
  });

  it('given no explicit redirect URI, should use the registered Google Calendar callback', () => {
    expect([googleRedirectUri({ WEB_APP_URL: 'https://pagespace.ai/' }), googleRedirectUri({ WEB_APP_URL: 'https://pagespace.ai', AGENT_ACCOUNTS_GOOGLE_REDIRECT_URI: 'https://pagespace.ai/api/agent-accounts/oauth/google/callback' })]).toEqual([
      'https://pagespace.ai/api/integrations/google-calendar/callback',
      'https://pagespace.ai/api/agent-accounts/oauth/google/callback',
    ]);
  });
});
