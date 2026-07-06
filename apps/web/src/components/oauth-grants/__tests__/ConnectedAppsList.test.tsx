import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  useOAuthGrants: vi.fn(),
  post: vi.fn(),
  del: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/hooks/useOAuthGrants', () => ({
  useOAuthGrants: mocks.useOAuthGrants,
}));
vi.mock('@/lib/auth/auth-fetch', () => ({
  post: mocks.post,
  del: mocks.del,
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { ConnectedAppsList } from '../ConnectedAppsList';
import { startAuthentication } from '@simplewebauthn/browser';

const GRANT = {
  id: 'grant-1',
  clientName: 'pagespace CLI',
  scopeDescriptions: ['Full access to your PageSpace account'],
  createdAt: '2026-01-01T00:00:00.000Z',
};

const refetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  window.location.hash = '';
  mocks.useOAuthGrants.mockReturnValue({ grants: [GRANT], isLoading: false, isError: null, refetch });
});

describe('ConnectedAppsList', () => {
  it('shows a loading state', () => {
    mocks.useOAuthGrants.mockReturnValue({ grants: undefined, isLoading: true, isError: null, refetch });
    const { container } = render(<ConnectedAppsList />);
    expect(container.querySelectorAll('[data-slot="skeleton"], .animate-pulse').length).toBeGreaterThan(0);
  });

  it('shows an error state', () => {
    mocks.useOAuthGrants.mockReturnValue({ grants: undefined, isLoading: false, isError: new Error('boom'), refetch });
    render(<ConnectedAppsList />);
    expect(screen.getByText(/failed to load connected apps/i)).toBeInTheDocument();
  });

  it('shows an empty state when there are no grants', () => {
    mocks.useOAuthGrants.mockReturnValue({ grants: [], isLoading: false, isError: null, refetch });
    render(<ConnectedAppsList />);
    expect(screen.getByText(/no connected apps/i)).toBeInTheDocument();
  });

  it('renders each grant with its client name and scope descriptions', () => {
    render(<ConnectedAppsList />);
    expect(screen.getByText('pagespace CLI')).toBeInTheDocument();
    expect(screen.getByText(/full access to your pagespace account/i)).toBeInTheDocument();
  });

  it('revokes via a WebAuthn step-up ceremony after confirming', async () => {
    mocks.post.mockImplementation((url: string) => {
      if (url === '/api/auth/step-up/webauthn/options') {
        return Promise.resolve({ options: { challenge: 'srv-challenge' }, challengeId: 'chal-1' });
      }
      if (url === '/api/auth/step-up/webauthn/verify') {
        return Promise.resolve({ stepUpToken: 'ps_stepup_test' });
      }
      throw new Error(`unexpected post to ${url}`);
    });
    vi.mocked(startAuthentication).mockResolvedValue({} as never);
    mocks.del.mockResolvedValue({ message: 'Grant revoked successfully' });

    render(<ConnectedAppsList />);
    await userEvent.click(screen.getByRole('button', { name: /^revoke$/i }));
    await userEvent.click(screen.getByRole('button', { name: /revoke access/i }));

    await waitFor(() => {
      expect(mocks.del).toHaveBeenCalledWith('/api/account/oauth-grants/grant-1', { stepUpToken: 'ps_stepup_test' });
    });
    expect(mocks.toastSuccess).toHaveBeenCalled();
    expect(refetch).toHaveBeenCalled();
  });

  it('falls back to a magic link when the user has no passkey, and remembers which grant is pending', async () => {
    vi.mocked(startAuthentication).mockRejectedValue(new Error('no_passkey'));
    mocks.post.mockImplementation((url: string) => {
      if (url === '/api/auth/step-up/webauthn/options') {
        return Promise.resolve({ options: { challenge: 'srv-challenge' }, challengeId: 'chal-1' });
      }
      if (url === '/api/auth/step-up/magic-link/request') {
        return Promise.resolve({ ok: true });
      }
      throw new Error(`unexpected post to ${url}`);
    });

    render(<ConnectedAppsList />);
    await userEvent.click(screen.getByRole('button', { name: /^revoke$/i }));
    await userEvent.click(screen.getByRole('button', { name: /revoke access/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /check email/i })).toBeInTheDocument();
    });
    expect(sessionStorage.getItem('pagespace:pendingOAuthGrantRevokeId')).toBe('grant-1');
    expect(mocks.del).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /revoke access/i })).not.toBeInTheDocument();
  });

  it('resets the button instead of getting stuck when the magic-link fallback request itself fails', async () => {
    vi.mocked(startAuthentication).mockRejectedValue(new Error('no_passkey'));
    mocks.post.mockImplementation((url: string) => {
      if (url === '/api/auth/step-up/webauthn/options') {
        return Promise.resolve({ options: { challenge: 'srv-challenge' }, challengeId: 'chal-1' });
      }
      if (url === '/api/auth/step-up/magic-link/request') {
        return Promise.reject(new Error('network error'));
      }
      throw new Error(`unexpected post to ${url}`);
    });

    render(<ConnectedAppsList />);
    await userEvent.click(screen.getByRole('button', { name: /^revoke$/i }));
    await userEvent.click(screen.getByRole('button', { name: /revoke access/i }));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalled();
    });
    expect(screen.queryByRole('button', { name: /check email/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^revoke$/i })).not.toBeDisabled();
    expect(sessionStorage.getItem('pagespace:pendingOAuthGrantRevokeId')).toBeNull();
  });

  it('completes the revoke automatically when a magic-link step-up token comes back in the URL hash', async () => {
    sessionStorage.setItem('pagespace:pendingOAuthGrantRevokeId', 'grant-1');
    window.location.hash = '#step_up_token=ps_stepup_from_email';
    mocks.del.mockResolvedValue({ message: 'Grant revoked successfully' });

    render(<ConnectedAppsList />);

    await waitFor(() => {
      expect(mocks.del).toHaveBeenCalledWith('/api/account/oauth-grants/grant-1', {
        stepUpToken: 'ps_stepup_from_email',
      });
    });
    expect(sessionStorage.getItem('pagespace:pendingOAuthGrantRevokeId')).toBeNull();
  });
});
