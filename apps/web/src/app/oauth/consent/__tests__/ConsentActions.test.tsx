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
