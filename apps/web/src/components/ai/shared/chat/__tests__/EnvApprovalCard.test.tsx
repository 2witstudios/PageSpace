/**
 * GA wave 2, leaf 5 — the approval card renders the FROZEN request the server
 * hands it (as the machine signed it), and a click posts the owner's decision
 * then submits the route's answer as the tool result under the tool's own
 * name — never as an ask_user answer.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('frozenRequestRows prints the same fields the daemon prompt does: principal, op, command, cwd, paths, env, limits', () => {
    const rows = frozenRequestRows(PENDING);
    expect(rows.map(([label]) => label)).toEqual(['principal', 'op', 'command', 'cwd', 'env', 'limits']);
    expect(rows).toContainEqual(['command', 'sh -c git status']);
    expect(rows).toContainEqual(['env', 'CI=1']);
    expect(rows).toContainEqual(['limits', 'timeout 120000 ms, output 1048576 bytes (clamped to the machine policy)']);
    expect(frozenRequestRows({ ...PENDING, request: { ...PENDING.request, paths: ['/a', '/b'], env: {} } })).toContainEqual(['paths', '/a, /b']);
  });

  it('fetches the frozen request from the approvals route and renders it verbatim; Allow posts the chosen scope and submits the route\'s answer under request_env_approval', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) return jsonResponse(PENDING);
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
  });

  it('Deny posts a deny and submits denied', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === undefined) return jsonResponse(PENDING);
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
