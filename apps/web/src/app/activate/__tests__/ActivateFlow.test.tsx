/**
 * The /activate screen's step-up behaviour. A step-up grant is single-use and
 * short-lived, so the interesting cases are all about what happens when the
 * one we hold turns out to be dead — the screen must never trap the user in a
 * loop that can only re-submit it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
}));

const postMock = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  post: (...args: unknown[]) => postMock(...args),
}));

import { ActivateFlow } from '../ActivateFlow';
import { startAuthentication } from '@simplewebauthn/browser';

const MINT_VERIFY = {
  userCode: 'ABCDEFGH',
  clientName: 'PageSpace CLI',
  firstParty: true,
  scopeDescriptions: ['Create a key named "remote-key"'],
  requiresStepUp: true,
  stepUpActionBinding: { userCode: 'ABCDEFGH', scope: 'drive:drv1:member name:remote-key offline_access' },
};

const LOGIN_VERIFY = {
  userCode: 'ABCDEFGH',
  clientName: 'PageSpace CLI',
  firstParty: true,
  scopeDescriptions: ['Manage your access keys'],
  requiresStepUp: false,
  stepUpActionBinding: null,
};

/** Drives the screen from the code entry box to the consent step. */
async function reachConsent() {
  render(<ActivateFlow initialUserCode="ABCD-EFGH" />);
  await userEvent.click(screen.getByRole('button', { name: /continue/i }));
  await screen.findByRole('button', { name: /allow/i });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ActivateFlow — step-up on credential-escalating grants', () => {
  /**
   * Regression guard. The approval request is the first place a stale grant
   * is detected (the decision route answers `step_up_required`). If the screen
   * keeps the token after that failure, the `!token` guard skips the ceremony
   * on every retry and re-submits the same dead token forever — a silent dead
   * end, most easily reached by following a magic link that has since expired.
   */
  it('drops a rejected step-up token so the next attempt runs a fresh ceremony', async () => {
    vi.mocked(startAuthentication).mockResolvedValue({ id: 'cred' } as never);
    let decisionCalls = 0;
    postMock.mockImplementation((url: string) => {
      if (url === '/api/oauth/device_authorization/verify') return Promise.resolve(MINT_VERIFY);
      if (url === '/api/auth/step-up/webauthn/options') {
        return Promise.resolve({ options: { challenge: 'srv-challenge' }, challengeId: 'chal-1' });
      }
      if (url === '/api/auth/step-up/webauthn/verify') {
        return Promise.resolve({ stepUpToken: `grant-${decisionCalls + 1}` });
      }
      if (url === '/api/oauth/device_authorization/decision') {
        decisionCalls += 1;
        // The server rejects the first grant as stale.
        if (decisionCalls === 1) return Promise.reject(new Error('step_up_required'));
        return Promise.resolve({ ok: true, action: 'approve' });
      }
      throw new Error(`unexpected post to ${url}`);
    });

    await reachConsent();
    await userEvent.click(screen.getByRole('button', { name: /allow/i }));
    await screen.findByText(/something went wrong/i);

    // Second attempt: a NEW ceremony must run and a NEW grant be submitted.
    await userEvent.click(screen.getByRole('button', { name: /^allow$/i }));

    await waitFor(() => {
      expect(screen.getByText(/device connected/i)).toBeInTheDocument();
    });

    expect(startAuthentication).toHaveBeenCalledTimes(2);
    const submitted = postMock.mock.calls
      .filter(([url]) => url === '/api/oauth/device_authorization/decision')
      .map(([, body]) => (body as { stepUpToken?: string }).stepUpToken);
    expect(submitted).toEqual(['grant-1', 'grant-2']);
  });

  it('runs the ceremony and submits the grant for an escalating grant', async () => {
    vi.mocked(startAuthentication).mockResolvedValue({ id: 'cred' } as never);
    postMock.mockImplementation((url: string) => {
      if (url === '/api/oauth/device_authorization/verify') return Promise.resolve(MINT_VERIFY);
      if (url === '/api/auth/step-up/webauthn/options') {
        return Promise.resolve({ options: { challenge: 'srv-challenge' }, challengeId: 'chal-1' });
      }
      if (url === '/api/auth/step-up/webauthn/verify') return Promise.resolve({ stepUpToken: 'fresh-grant' });
      if (url === '/api/oauth/device_authorization/decision') return Promise.resolve({ ok: true, action: 'approve' });
      throw new Error(`unexpected post to ${url}`);
    });

    await reachConsent();
    await userEvent.click(screen.getByRole('button', { name: /allow/i }));

    await waitFor(() => {
      expect(screen.getByText(/device connected/i)).toBeInTheDocument();
    });

    // Bound to the tuple the decision route recomputes server-side.
    expect(postMock).toHaveBeenCalledWith(
      '/api/auth/step-up/webauthn/options',
      expect.objectContaining({ actionBinding: MINT_VERIFY.stepUpActionBinding }),
    );
    expect(postMock).toHaveBeenCalledWith(
      '/api/oauth/device_authorization/decision',
      expect.objectContaining({ stepUpToken: 'fresh-grant' }),
    );
  });

  // `login --device` must be unchanged by the step-up work.
  it('never runs a ceremony for a plain login grant', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/api/oauth/device_authorization/verify') return Promise.resolve(LOGIN_VERIFY);
      if (url === '/api/oauth/device_authorization/decision') return Promise.resolve({ ok: true, action: 'approve' });
      throw new Error(`unexpected post to ${url}`);
    });

    await reachConsent();
    await userEvent.click(screen.getByRole('button', { name: /allow/i }));

    await waitFor(() => {
      expect(screen.getByText(/device connected/i)).toBeInTheDocument();
    });

    expect(startAuthentication).not.toHaveBeenCalled();
    expect(postMock).toHaveBeenCalledWith(
      '/api/oauth/device_authorization/decision',
      expect.not.objectContaining({ stepUpToken: expect.anything() }),
    );
  });

  it('never runs a ceremony to DENY, however escalating the grant', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/api/oauth/device_authorization/verify') return Promise.resolve(MINT_VERIFY);
      if (url === '/api/oauth/device_authorization/decision') return Promise.resolve({ ok: true, action: 'deny' });
      throw new Error(`unexpected post to ${url}`);
    });

    await reachConsent();
    await userEvent.click(screen.getByRole('button', { name: /deny/i }));

    await waitFor(() => {
      expect(screen.getByText(/access denied/i)).toBeInTheDocument();
    });

    expect(startAuthentication).not.toHaveBeenCalled();
  });
});
