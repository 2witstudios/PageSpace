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

import { AskUserAnswerProvider } from '../ask-user/AskUserAnswerContext';
import { EnvApprovalCard, frozenRequestRows } from '../env-approval/EnvApprovalCard';

const PENDING = {
  challengeId: 'ch_1',
  envId: 'env_1',
  principal: { userId: 'user_owner', sessionId: 'sess_1', conversationId: 'conv_1' },
  expiresAt: 1_800_000_030_000,
  request: { op: 'exec', cmd: 'sh', args: ['-c', 'git status'], cwd: '/home/o/proj', paths: [], env: { CI: '1' }, timeoutMs: 120_000, maxBytes: 1_048_576, clamped: true },
};

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
      expect(JSON.parse(String(init.body))).toEqual({ decision: 'allow', scope: 'until_revoked' });
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
