/**
 * Slice 3 — the Google callback. Pinned: a state this browser did not start
 * (no or another binding cookie) is refused before the authority is called;
 * a cancelled consent says so; a good one hands the authority the code and
 * the PKCE verifier derived for THIS state, and clears the binding cookie.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAuthority = vi.hoisted(() => ({ completeOAuthEnrollment: vi.fn() }));
vi.mock('./../account-authority-client', () => ({ getAccountAuthority: () => mockAuthority }));
vi.mock('@pagespace/lib/logging/logger-config', () => ({ loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } } }));
vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));
vi.mock('@pagespace/lib/deployment-mode', () => ({ isOnPrem: () => false }));

import { handleAgentAccountGoogleCallback } from '../google-enrollment-callback';
import { codeVerifierFor, createEnrollmentState, ENROLLMENT_COOKIE } from '../google-enrollment-flow';

const SECRET = 'state-secret-for-tests-0123456789abcdef';
const input = { name: 'Agent Google', services: ['gmail.read'], ownership: 'dedicated' as const, acknowledged: false, autoApproveReads: true };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OAUTH_STATE_SECRET = SECRET;
  process.env.WEB_APP_URL = 'https://pagespace.test';
});

const callback = (query: Record<string, string>, cookie?: string) =>
  handleAgentAccountGoogleCallback(new Request(`https://pagespace.test/api/integrations/google-calendar/callback?${new URLSearchParams(query).toString()}`, { headers: cookie === undefined ? {} : { cookie: `${ENROLLMENT_COOKIE}=${cookie}` } }));
const outcomeOf = (response: Response) => new URL(response.headers.get('location') ?? 'https://x').searchParams.get('agentAccount');

describe('handleAgentAccountGoogleCallback', () => {
  it('given a state another browser started, should refuse as expired without calling the authority', async () => {
    const { state } = createEnrollmentState({ secret: SECRET, userId: 'user_1', owner: { kind: 'user' }, input, returnTo: '/settings/agent-accounts', now: Date.now() });
    const responses = [await callback({ state, code: 'c' }), await callback({ state, code: 'c' }, 'someone-elses-nonce')];
    expect({ outcomes: responses.map(outcomeOf), called: mockAuthority.completeOAuthEnrollment.mock.calls.length }).toEqual({ outcomes: ['expired', 'expired'], called: 0 });
  });

  it('given the person cancelled on Google, should say so', async () => {
    const { state, nonce } = createEnrollmentState({ secret: SECRET, userId: 'user_1', owner: { kind: 'user' }, input, returnTo: '/settings/agent-accounts', now: Date.now() });
    expect(outcomeOf(await callback({ state, error: 'access_denied' }, nonce))).toBe('cancelled');
  });

  it('given a good code from the browser that started it, should hand the authority the code and THIS state\'s verifier, return to where it started and clear the cookie', async () => {
    mockAuthority.completeOAuthEnrollment.mockResolvedValue({ ok: true, account: { id: 'acct_1' }, email: 'agent@example.com' });
    const { state, nonce } = createEnrollmentState({ secret: SECRET, userId: 'user_1', owner: { kind: 'agent_page', agentPageId: 'page_a' }, input, returnTo: '/p/page_a?tab=settings', now: Date.now() });
    const response = await callback({ state, code: 'the-code' }, nonce);
    const call = mockAuthority.completeOAuthEnrollment.mock.calls[0]?.[0];
    const location = new URL(response.headers.get('location') ?? '');
    expect({
      path: `${location.pathname}?tab=${location.searchParams.get('tab')}`,
      outcome: location.searchParams.get('agentAccount'),
      code: call?.code,
      verifier: call?.codeVerifier === codeVerifierFor(SECRET, nonce),
      owner: call?.owner,
      actor: call?.actor?.userId,
      cleared: response.headers.get('set-cookie')?.includes(`${ENROLLMENT_COOKIE}=;`),
    }).toEqual({ path: '/p/page_a?tab=settings', outcome: 'connected', code: 'the-code', verifier: true, owner: { kind: 'agent_page', agentPageId: 'page_a' }, actor: 'user_1', cleared: true });
  });

  it('given Google refusing the code, should return its reason word', async () => {
    mockAuthority.completeOAuthEnrollment.mockResolvedValue({ ok: false, reason: 'provider_refused', detail: 'no_refresh_token' });
    const { state, nonce } = createEnrollmentState({ secret: SECRET, userId: 'user_1', owner: { kind: 'user' }, input, returnTo: '/settings/agent-accounts', now: Date.now() });
    expect(outcomeOf(await callback({ state, code: 'c' }, nonce))).toBe('no_refresh_token');
  });
});
