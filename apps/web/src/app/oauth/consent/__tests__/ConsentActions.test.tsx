import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
}));

const postMock = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  post: (...args: unknown[]) => postMock(...args),
}));

import { ConsentActions } from '../ConsentActions';
import { startAuthentication } from '@simplewebauthn/browser';

const defaultProps = {
  clientId: 'client-1',
  redirectUri: 'http://127.0.0.1:1/cb',
  responseType: 'code',
  codeChallenge: 'challenge',
  codeChallengeMethod: 'S256',
  scope: 'account',
  state: 'xyz',
};

describe('ConsentActions — email-grant auto-resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/oauth/consent?client_id=client-1#step_up_token=ps_stepup_email');
  });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('resumes the approval automatically with the emailed grant — no second Allow click, no new ceremony', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/api/oauth/authorize') {
        return Promise.resolve({ redirectUri: 'http://127.0.0.1:1/cb?code=abc' });
      }
      throw new Error(`unexpected post to ${url}`);
    });

    render(<ConsentActions {...defaultProps} />);

    await waitFor(() => {
      expect(postMock).toHaveBeenCalledWith(
        '/api/oauth/authorize',
        expect.objectContaining({ action: 'approve', stepUpToken: 'ps_stepup_email' }),
      );
    });

    // The approval resumed from the emailed grant — no fresh WebAuthn ceremony.
    expect(startAuthentication).not.toHaveBeenCalled();
    // The bearer-like token is scrubbed from the visible URL.
    expect(window.location.hash).not.toContain('step_up_token');
  });

  it('recovers from a failed auto-resume: shows the error and the next Allow click starts a fresh ceremony', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/api/oauth/authorize') {
        return Promise.reject(new Error('step_up_required'));
      }
      if (url === '/api/auth/step-up/webauthn/options') {
        return Promise.resolve({ options: { challenge: 'srv-challenge' }, challengeId: 'chal-1' });
      }
      throw new Error(`unexpected post to ${url}`);
    });
    vi.mocked(startAuthentication).mockRejectedValue(new Error('NotAllowedError: user cancelled'));

    render(<ConsentActions {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /^allow$/i })).not.toBeDisabled();

    // The consumed single-use grant must not be reused — the retry runs a
    // genuinely fresh ceremony instead of re-posting the dead token.
    await userEvent.click(screen.getByRole('button', { name: /^allow$/i }));
    await waitFor(() => {
      expect(startAuthentication).toHaveBeenCalledTimes(1);
    });
  });
});

describe('ConsentActions — WebAuthn ceremony cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postMock.mockImplementation((url: string) => {
      if (url === '/api/auth/step-up/webauthn/options') {
        return Promise.resolve({ options: { challenge: 'srv-challenge' }, challengeId: 'chal-1' });
      }
      throw new Error(`unexpected post to ${url}`);
    });
  });

  it('does not leave the Allow button stuck on "Confirming…" after a generic ceremony cancellation, and retries a fresh ceremony on the next click', async () => {
    vi.mocked(startAuthentication).mockRejectedValue(new Error('NotAllowedError: user cancelled'));

    render(<ConsentActions {...defaultProps} />);

    const allowButton = screen.getByRole('button', { name: /allow/i });
    await userEvent.click(allowButton);

    // Ceremony rejected -> outer catch surfaces the error and re-enables buttons.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /allow/i })).not.toBeDisabled();
    });

    // The button must not be stuck showing "Confirming…" once the failure has settled.
    expect(screen.queryByRole('button', { name: /confirming/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^allow$/i })).toBeInTheDocument();

    expect(startAuthentication).toHaveBeenCalledTimes(1);

    // Clicking Allow again must start a genuinely fresh ceremony, not skip it
    // because a stale stepUpToken/status was left behind.
    await userEvent.click(screen.getByRole('button', { name: /^allow$/i }));

    await waitFor(() => {
      expect(startAuthentication).toHaveBeenCalledTimes(2);
    });
  });
});
