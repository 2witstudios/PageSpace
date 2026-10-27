import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ============================================================================
// Smoke tests for the connections "Add Connection" tab invite branch.
//
// L2 hardening: /api/connections/search returns a generic `{ user: null }` for
// every non-actionable outcome (no account / self / existing relationship), so
// the UI must treat them identically — surface the same neutral CTA and, after
// the follow-up invite, the same uniform confirmation — rather than echoing the
// distinguishing state and letting a user recover what the search concealed.
// ============================================================================

vi.mock('@/hooks/useAuth', () => ({
  useAuth: vi.fn(() => ({ user: { id: 'user_123' } })),
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: vi.fn(() => null),
}));

vi.mock('@/stores/useNotificationStore', () => ({
  useNotificationStore: {
    getState: vi.fn(() => ({
      notifications: [],
      updateNotification: vi.fn(),
    })),
  },
}));

vi.mock('swr', () => ({
  default: vi.fn(() => ({ data: { connections: [] }, error: null })),
  mutate: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
  post: vi.fn(),
}));

import ConnectionsPage from '../page';
import { fetchWithAuth, post } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';

describe('ConnectionsPage — Add Connection tab invite branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderAndGetTab() {
    render(<ConnectionsPage />);
    const discoverTab = screen.getByRole('tab', { name: /Add Connection/i });
    return discoverTab;
  }

  // Helper: the search endpoint now always returns a generic { user: null }
  // for non-actionable outcomes.
  function mockGenericNullSearch() {
    vi.mocked(fetchWithAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ user: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }

  it('given a generic { user: null } search result, surfaces the neutral send-request CTA', async () => {
    const user = userEvent.setup();
    mockGenericNullSearch();

    const discoverTab = renderAndGetTab();
    await user.click(discoverTab);

    const input = screen.getByPlaceholderText('Enter email address');
    await user.type(input, 'unknown@example.com');
    await user.click(screen.getByRole('button', { name: /Find User/i }));

    await waitFor(() => {
      expect(screen.getByText('Send a connection request')).toBeInTheDocument();
      // Neutral copy: must NOT assert the account does/doesn't exist.
      expect(screen.queryByText(/not on PageSpace yet/i)).not.toBeInTheDocument();
      expect(screen.queryByText('User not found')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Send request/i })).toBeInTheDocument();
    });
  });

  it('given user clicks the CTA, POSTs to /api/connections/invite and shows the uniform confirmation', async () => {
    const user = userEvent.setup();
    mockGenericNullSearch();
    vi.mocked(post).mockResolvedValueOnce({
      kind: 'invited',
      inviteId: 'invite_abc',
      email: 'unknown@example.com',
      message: 'Connection invite sent to unknown@example.com',
    });

    const discoverTab = renderAndGetTab();
    await user.click(discoverTab);

    const input = screen.getByPlaceholderText('Enter email address');
    await user.type(input, 'unknown@example.com');
    await user.click(screen.getByRole('button', { name: /Find User/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Send request/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Send request/i }));

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith('/api/connections/invite', {
        email: 'unknown@example.com',
      });
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringMatching(/connection request is on its way/i)
      );
    });
  });

  it('treats an existing-relationship result identically: same neutral CTA, no distinguishing error (L2)', async () => {
    const user = userEvent.setup();
    // Already-connected / pending / blocked all return the SAME generic shape.
    mockGenericNullSearch();

    const discoverTab = renderAndGetTab();
    await user.click(discoverTab);

    const input = screen.getByPlaceholderText('Enter email address');
    await user.type(input, 'existing@example.com');
    await user.click(screen.getByRole('button', { name: /Find User/i }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Send request/i })).toBeInTheDocument();
    });
    // No state-revealing error toast is shown.
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('given the invite POST fails with a state-revealing error, still shows the uniform confirmation (does not leak)', async () => {
    const user = userEvent.setup();
    mockGenericNullSearch();
    // The invite endpoint returns a distinguishing 409; the UI must NOT surface it.
    vi.mocked(post).mockRejectedValueOnce(
      new Error('An invitation is already pending for this email.')
    );

    const discoverTab = renderAndGetTab();
    await user.click(discoverTab);

    const input = screen.getByPlaceholderText('Enter email address');
    await user.type(input, 'unknown@example.com');
    await user.click(screen.getByRole('button', { name: /Find User/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Send request/i })).toBeInTheDocument()
    );

    await user.click(screen.getByRole('button', { name: /Send request/i }));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringMatching(/connection request is on its way/i)
      );
    });
    // The distinguishing "already pending" detail must never reach the user.
    expect(toast.error).not.toHaveBeenCalled();
  });
});
