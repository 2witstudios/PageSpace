// @vitest-environment jsdom
/**
 * The /claim screen (Agent Signup Phase 4; mirrors ActivateFlow): enter code →
 * verify → a consent that NAMES the agent (name, created, source) and says the
 * human will pay for its AI usage → approve/deny → done. Every step re-hits the
 * server; nothing here is trusted client state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const postMock = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  post: (...args: unknown[]) => postMock(...args),
}));

import { ClaimFlow } from '../ClaimFlow';

const VERIFY = {
  userCode: 'ABCDEFGH',
  agent: { name: 'Scratch Agent', createdAt: '2026-11-01T10:00:00.000Z', source: 'claude-code' },
};

async function reachConsent(initial = 'ABCD-EFGH') {
  render(<ClaimFlow initialUserCode={initial} />);
  await userEvent.click(screen.getByRole('button', { name: /continue/i }));
  await screen.findByRole('button', { name: /claim and pay/i });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each([['classic', 'false'], ['v3', 'true']])('ClaimFlow (%s)', (_label, v3) => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_IMAGO_V3_AUTH', v3);
  });

  it('given a valid code, should name the agent and say the human will pay for its AI usage', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/api/agent/claim/verify') return Promise.resolve(VERIFY);
      throw new Error(`unexpected post to ${url}`);
    });

    await reachConsent();

    expect(postMock).toHaveBeenCalledWith('/api/agent/claim/verify', { userCode: 'ABCD-EFGH' });
    expect(screen.getByText('Scratch Agent')).toBeInTheDocument();
    expect(screen.getByText('claude-code')).toBeInTheDocument();
    expect(screen.getByText(/created/i)).toBeInTheDocument();
    expect(screen.getByText(/you will pay for its ai usage/i)).toBeInTheDocument();
  });

  it('given approve, should post the decision and confirm the claim', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/api/agent/claim/verify') return Promise.resolve(VERIFY);
      if (url === '/api/agent/claim/decision') return Promise.resolve({ ok: true, action: 'approved' });
      throw new Error(`unexpected post to ${url}`);
    });

    await reachConsent();
    await userEvent.click(screen.getByRole('button', { name: /claim and pay/i }));

    await waitFor(() => expect(screen.getByText(/you now own scratch agent/i)).toBeInTheDocument());
    expect(postMock).toHaveBeenCalledWith('/api/agent/claim/decision', { userCode: 'ABCDEFGH', action: 'approve' });
  });

  it('given deny, should post the denial and say nothing was claimed', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/api/agent/claim/verify') return Promise.resolve(VERIFY);
      if (url === '/api/agent/claim/decision') return Promise.resolve({ ok: true, action: 'denied' });
      throw new Error(`unexpected post to ${url}`);
    });

    await reachConsent();
    await userEvent.click(screen.getByRole('button', { name: /^deny$/i }));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Not claimed' })).toBeInTheDocument());
    expect(postMock).toHaveBeenCalledWith('/api/agent/claim/decision', { userCode: 'ABCDEFGH', action: 'deny' });
  });

  it('given an invalid code, should say so and stay on entry', async () => {
    postMock.mockRejectedValue(new Error('invalid_code'));
    render(<ClaimFlow initialUserCode="ZZZZ-ZZZZ" />);
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByText(/invalid or has expired/i);
    expect(screen.queryByRole('button', { name: /claim and pay/i })).not.toBeInTheDocument();
  });

  it('given a signed-in agent (403), should say only a person can claim', async () => {
    postMock.mockRejectedValue(Object.assign(new Error('not_human'), { status: 403 }));
    render(<ClaimFlow initialUserCode="ABCD-EFGH" />);
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    await screen.findByText(/only a person can claim an agent/i);
  });

  it('given an empty code, should not allow continuing', () => {
    render(<ClaimFlow initialUserCode="" />);
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });
});
