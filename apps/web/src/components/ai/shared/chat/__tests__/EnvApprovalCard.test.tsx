/**
 * GA wave 2, leaf 5 — the approval card renders the FROZEN request the server
 * hands it (as the machine signed it), and a click posts the owner's decision
 * then submits the route's answer as the tool result under the tool's own
 * name — never as an ask_user answer.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuthMock(...args) }));
/** The owner's authenticator (hardening B): Allow must obtain a real assertion before it posts. */
const startAuthenticationMock = vi.hoisted(() => vi.fn());
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication: (...args: unknown[]) => startAuthenticationMock(...args) }));

import { AskUserAnswerProvider } from '../ask-user/AskUserAnswerContext';
import { EnvApprovalCard, frozenRequestRows } from '../env-approval/EnvApprovalCard';

const PENDING = {
  challengeId: 'ch_1',
  envId: 'env_1',
  principal: { userId: 'user_owner', sessionId: 'sess_1', conversationId: 'conv_1' },
  expiresAt: 1_800_000_030_000,
  request: { op: 'exec', cmd: 'sh', args: ['-c', 'git status'], cwd: '/home/o/proj', paths: [], env: { CI: '1' }, timeoutMs: 120_000, maxBytes: 1_048_576, clamped: true },
  // One challenge per SCOPE: the challenge binds the scope the owner picks (Codex P1 on #2599).
  webauthn: {
    available: true,
    rpId: 'pagespace.test',
    challenges: { once: 'Y2hhbC1vbmNl', session: 'Y2hhbC1zZXNz', '30d': 'Y2hhbC0zMGQ', until_revoked: 'Y2hhbC1mb3JldmVy' },
    allowCredentials: [{ id: 'cred-a', type: 'public-key' as const }],
  },
};

/** What `startAuthentication` hands back for the pinned credential. */
const AUTHENTICATOR_RESPONSE = { id: 'cred-a', response: { authenticatorData: 'YXV0aA', clientDataJSON: 'Y2xpZW50', signature: 'c2ln' } };
const EXPECTED_ASSERTION = { credentialId: 'cred-a', authenticatorData: 'YXV0aA', clientDataJSON: 'Y2xpZW50', signature: 'c2ln' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const part = (over: Record<string, unknown> = {}) => ({ type: 'tool-request_env_approval', toolCallId: 'call_1', state: 'input-available' as const, input: { challengeId: 'ch_1' }, ...over });

describe('EnvApprovalCard', () => {
  /** Every request goes through the auth fetch helper (session + CSRF); a raw window.fetch would be a regression. */
  let fetchMock: ReturnType<typeof vi.fn>;
  let rawFetch: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = fetchWithAuthMock;
    fetchMock.mockReset();
    rawFetch = vi.fn(async () => { throw new Error('raw fetch must not be used — it carries no CSRF token'); });
    vi.stubGlobal('fetch', rawFetch);
    startAuthenticationMock.mockReset();
    startAuthenticationMock.mockResolvedValue(AUTHENTICATOR_RESPONSE);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    expect(rawFetch).not.toHaveBeenCalled();
  });

  it('frozenRequestRows prints the same fields the daemon prompt does: principal, op, command, cwd, paths, env, limits', () => {
    const rows = frozenRequestRows(PENDING);
    expect(rows.map(([label]) => label)).toEqual(['principal', 'op', 'command', 'cwd', 'env', 'limits']);
    expect(rows).toContainEqual(['command', 'sh -c git status']);
    expect(rows).toContainEqual(['env', 'CI=1']);
    expect(rows).toContainEqual(['limits', 'timeout 120000 ms, output 1048576 bytes (clamped to the machine policy)']);
    expect(frozenRequestRows({ ...PENDING, request: { ...PENDING.request, paths: ['/a', '/b'], env: {} } })).toContainEqual(['paths', '/a, /b']);
  });

  describe('A7: an fs_write request', () => {
    const FILES = [
      { path: '/home/o/proj/src/a.ts', mode: null, bytes: 3, reason: null },
      { path: '/home/o/proj/.git/hooks/pre-commit', mode: 0o755, bytes: 12, reason: 'vcs_metadata' as const },
    ];
    const WRITE = {
      ...PENDING,
      request: { op: 'fs_write', cwd: '/home/o/proj', paths: FILES.map((file) => file.path), writeModes: [null, 0o755], env: {}, timeoutMs: 120_000, maxBytes: 1_048_576, clamped: false },
      files: FILES,
    };

    it('renders every file with its mode, its size and WHY it was escalated — and marks which ones are sensitive', () => {
      const rows = frozenRequestRows(WRITE);
      const text = rows.map(([label, value]) => `${label} ${value}`).join('\n');
      expect(rows.map(([label]) => label)).toContain('files');
      expect(text).toContain('/home/o/proj/.git/hooks/pre-commit');
      expect(text).toContain('0755');
      expect(text).toContain('12 bytes');
      // The machine's own reason, not a paraphrase composed here.
      expect(text).toContain('version-control metadata');
      // The ordinary file is shown, and is not accused of anything.
      expect(text).toContain('/home/o/proj/src/a.ts');
      expect(text).toMatch(/3 bytes/);
      expect((text.match(/version-control metadata/g) ?? []).length).toBe(1);
    });

    it('renders an exec exactly as it does today (no regression)', () => {
      expect(frozenRequestRows(PENDING).map(([label]) => label)).toEqual(['principal', 'op', 'command', 'cwd', 'env', 'limits']);
    });

    it('shows the byte count rather than the content — the frozen request never carries the bytes at all', async () => {
      fetchMock.mockImplementation(async () => jsonResponse(WRITE));
      render(
        <AskUserAnswerProvider value={{ answerableToolCallIds: new Set(['call_1']), submitAnswers: vi.fn() }}>
          <EnvApprovalCard part={part()} />
        </AskUserAnswerProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('env-approval-request')).toBeTruthy());
      const shown = screen.getByTestId('env-approval-request').textContent ?? '';
      expect(shown).toContain('.git/hooks/pre-commit');
      expect(shown).toContain('12 bytes');
      expect(shown).toContain('version-control metadata');
      expect(shown).not.toContain('would be made executable');
    });
  });

  it('fetches the frozen request from the approvals route and renders it verbatim; Allow posts the chosen scope and submits the route\'s answer under request_env_approval', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!init || init.method !== 'POST') return jsonResponse(PENDING);
      expect(url).toBe('/api/env-bridge/approvals/ch_1');
      // The Allow body now carries the owner's assertion (hardening B, leaf B3).
      expect(JSON.parse(String(init.body))).toEqual({ decision: 'allow', scope: 'until_revoked', assertion: EXPECTED_ASSERTION });
      return jsonResponse({ challengeId: 'ch_1', outcome: 'allowed', scope: 'until_revoked', exitCode: 0, stdout: 'On branch main', stderr: '', truncated: false });
    });
    const submitAnswers = vi.fn();
    render(
      <AskUserAnswerProvider value={{ answerableToolCallIds: new Set(['call_1']), submitAnswers }}>
        <EnvApprovalCard part={part()} />
      </AskUserAnswerProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('env-approval-request')).toBeTruthy());
    expect(screen.getByTestId('env-approval-request').textContent).toContain('sh -c git status');
    expect(screen.getByTestId('env-approval-request').textContent).toContain('/home/o/proj');
    expect(screen.getByTestId('env-approval-request').textContent).toContain('user user_owner, session sess_1, conversation conv_1');
    fireEvent.change(screen.getByLabelText('Remember for'), { target: { value: 'until_revoked' } });
    fireEvent.click(screen.getByTestId('env-approval-allow'));
    await waitFor(() => expect(submitAnswers).toHaveBeenCalledTimes(1));
    expect(submitAnswers).toHaveBeenCalledWith('call_1', expect.objectContaining({ challengeId: 'ch_1', outcome: 'allowed', exitCode: 0 }), 'request_env_approval');
    // Codex P1 on #2583: BOTH the GET and the POST go through fetchWithAuth (the helper that attaches the CSRF token the requireCSRF route demands).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'GET' });
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
  });

  it('Deny posts a deny and submits denied', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || init.method !== 'POST') return jsonResponse(PENDING);
      expect(JSON.parse(String(init.body))).toEqual({ decision: 'deny' });
      return jsonResponse({ challengeId: 'ch_1', outcome: 'denied' });
    });
    const submitAnswers = vi.fn();
    render(
      <AskUserAnswerProvider value={{ answerableToolCallIds: new Set(['call_1']), submitAnswers }}>
        <EnvApprovalCard part={part()} />
      </AskUserAnswerProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('env-approval-deny')).toBeTruthy());
    fireEvent.click(screen.getByTestId('env-approval-deny'));
    await waitFor(() => expect(submitAnswers).toHaveBeenCalledWith('call_1', { challengeId: 'ch_1', outcome: 'denied' }, 'request_env_approval'));
  });

  it('given the viewer is not the owner (403), shows the refusal and offers no Allow button', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Only this machine\'s owner can approve', outcome: 'not_owner' }, 403));
    render(
      <AskUserAnswerProvider value={{ answerableToolCallIds: new Set(['call_1']), submitAnswers: vi.fn() }}>
        <EnvApprovalCard part={part()} />
      </AskUserAnswerProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('env-approval-gone')).toBeTruthy());
    expect(screen.getByTestId('env-approval-gone').textContent).toContain('owner');
    expect(screen.queryByTestId('env-approval-allow')).toBeNull();
  });

  it('outside a live chat surface (no context) or when not answerable, renders read-only — no buttons, no fetch of the decision', async () => {
    fetchMock.mockResolvedValue(jsonResponse(PENDING));
    render(<EnvApprovalCard part={part()} />);
    await waitFor(() => expect(screen.getByTestId('env-approval-request')).toBeTruthy());
    expect(screen.queryByTestId('env-approval-allow')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an answered part renders the outcome and never fetches', () => {
    render(<EnvApprovalCard part={part({ state: 'output-available', output: { challengeId: 'ch_1', outcome: 'allowed', scope: '30d', exitCode: 0 } })} />);
    expect(screen.getByTestId('env-approval-answered').textContent).toContain('Approved and run on your machine');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * B3 (card) — Allow is PROVEN, not merely reported. The browser asks the
 * owner's authenticator to sign the derived challenge, and the assertion
 * rides to the machine, which is the party that verifies it.
 */
describe('EnvApprovalCard — the owner\'s passkey', () => {
  beforeEach(() => {
    fetchWithAuthMock.mockReset();
    startAuthenticationMock.mockReset();
    startAuthenticationMock.mockResolvedValue(AUTHENTICATOR_RESPONSE);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('raw fetch must not be used'); }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const renderCard = (submitAnswers = vi.fn()) => {
    render(
      <AskUserAnswerProvider value={{ answerableToolCallIds: new Set(['call_1']), submitAnswers }}>
        <EnvApprovalCard part={part()} />
      </AskUserAnswerProvider>,
    );
    return submitAnswers;
  };

  it('runs the ceremony with the challenge and allowCredentials the route derived, then posts the assertion', async () => {
    let posted: unknown;
    fetchWithAuthMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || init.method !== 'POST') return jsonResponse(PENDING);
      posted = JSON.parse(String(init.body));
      return jsonResponse({ challengeId: 'ch_1', outcome: 'allowed', scope: '30d' });
    });
    const submitAnswers = renderCard();
    await waitFor(() => expect(screen.getByTestId('env-approval-allow')).toBeTruthy());
    fireEvent.click(screen.getByTestId('env-approval-allow'));
    await waitFor(() => expect(submitAnswers).toHaveBeenCalledTimes(1));
    // The default scope is 30d, so THAT scope's challenge is what the authenticator signs.
    expect(startAuthenticationMock).toHaveBeenCalledWith({
      optionsJSON: { challenge: 'Y2hhbC0zMGQ', rpId: 'pagespace.test', allowCredentials: [{ id: 'cred-a', type: 'public-key' }], userVerification: 'preferred' },
    });
    expect(posted).toEqual({ decision: 'allow', scope: '30d', assertion: EXPECTED_ASSERTION });
  });

  it('signs the challenge for the SCOPE the owner selected, not a fixed one (Codex P1 on #2599)', async () => {
    let posted: { scope?: string } | undefined;
    fetchWithAuthMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || init.method !== 'POST') return jsonResponse(PENDING);
      posted = JSON.parse(String(init.body)) as { scope?: string };
      return jsonResponse({ challengeId: 'ch_1', outcome: 'allowed', scope: posted.scope });
    });
    const submitAnswers = renderCard();
    await waitFor(() => expect(screen.getByTestId('env-approval-allow')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Remember for'), { target: { value: 'once' } });
    fireEvent.click(screen.getByTestId('env-approval-allow'));
    await waitFor(() => expect(submitAnswers).toHaveBeenCalledTimes(1));
    expect(startAuthenticationMock.mock.calls[0]![0]).toMatchObject({ optionsJSON: { challenge: 'Y2hhbC1vbmNl' } });
    expect(posted?.scope).toBe('once');
  });

  it('refuses to sign when the route offered no challenge for the selected scope, rather than signing the wrong one', async () => {
    fetchWithAuthMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || init.method !== 'POST') return jsonResponse({ ...PENDING, webauthn: { ...PENDING.webauthn, challenges: { '30d': 'Y2hhbC0zMGQ' } } });
      throw new Error('the POST must not happen');
    });
    renderCard();
    await waitFor(() => expect(screen.getByTestId('env-approval-allow')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Remember for'), { target: { value: 'until_revoked' } });
    fireEvent.click(screen.getByTestId('env-approval-allow'));
    await waitFor(() => expect(screen.getByText(/did not offer a challenge/)).toBeTruthy());
    expect(fetchWithAuthMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(0);
  });

  it('the ceremony runs BEFORE the POST — a cancelled prompt sends nothing at all', async () => {
    fetchWithAuthMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || init.method !== 'POST') return jsonResponse(PENDING);
      throw new Error('the POST must not happen');
    });
    startAuthenticationMock.mockRejectedValue(new Error('The operation either timed out or was not allowed.'));
    renderCard();
    await waitFor(() => expect(screen.getByTestId('env-approval-allow')).toBeTruthy());
    fireEvent.click(screen.getByTestId('env-approval-allow'));
    await waitFor(() => expect(screen.getByText(/timed out or was not allowed/)).toBeTruthy());
    expect(fetchWithAuthMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(0);
  });

  it('given the machine pinned no passkey, says so on the card and refuses to send an unprovable Allow', async () => {
    fetchWithAuthMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || init.method !== 'POST') return jsonResponse({ ...PENDING, webauthn: { available: false, rpId: null, challenges: {}, allowCredentials: [] } });
      throw new Error('the POST must not happen');
    });
    renderCard();
    await waitFor(() => expect(screen.getByTestId('env-approval-no-passkey')).toBeTruthy());
    expect(screen.getByTestId('env-approval-no-passkey').textContent).toContain('pagespace env connect');
    fireEvent.click(screen.getByTestId('env-approval-allow'));
    // Twice: the standing banner on the card, and the failure the click reports.
    await waitFor(() => expect(screen.getAllByText(/cannot verify that a human clicked/)).toHaveLength(2));
    expect(startAuthenticationMock).not.toHaveBeenCalled();
    expect(fetchWithAuthMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(0);
  });

  it('DENY never runs the ceremony — refusing to run is not the dangerous direction', async () => {
    fetchWithAuthMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || init.method !== 'POST') return jsonResponse(PENDING);
      expect(JSON.parse(String(init.body))).toEqual({ decision: 'deny' });
      return jsonResponse({ challengeId: 'ch_1', outcome: 'denied' });
    });
    const submitAnswers = renderCard();
    await waitFor(() => expect(screen.getByTestId('env-approval-deny')).toBeTruthy());
    fireEvent.click(screen.getByTestId('env-approval-deny'));
    await waitFor(() => expect(submitAnswers).toHaveBeenCalledTimes(1));
    expect(startAuthenticationMock).not.toHaveBeenCalled();
  });

  it('still uses fetchWithAuth for the POST — a raw fetch answers 403 CSRF_TOKEN_MISSING (a shipped defect, never reintroduced)', async () => {
    fetchWithAuthMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      !init || init.method !== 'POST' ? jsonResponse(PENDING) : jsonResponse({ challengeId: 'ch_1', outcome: 'allowed' }),
    );
    renderCard();
    await waitFor(() => expect(screen.getByTestId('env-approval-allow')).toBeTruthy());
    fireEvent.click(screen.getByTestId('env-approval-allow'));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
    expect(fetchWithAuthMock.mock.calls[1]![1]).toMatchObject({ method: 'POST' });
  });
});
