import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ============================================================================
// Smoke tests for the connections "Add Connection" tab invite branch.
// Focuses on: user-not-found → invite CTA surface, and invite POST payload.
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

  it('given user search returns no match, surfaces the invite-to-PageSpace CTA', async () => {
    const user = userEvent.setup();

    vi.mocked(fetchWithAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ user: null, error: 'No user found with this email address' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const discoverTab = renderAndGetTab();
    await user.click(discoverTab);

    const input = screen.getByPlaceholderText('Enter email address');
    await user.type(input, 'unknown@example.com');
    await user.click(screen.getByRole('button', { name: /Find User/i }));

    await waitFor(() => {
      expect(screen.getByText('User not found')).toBeInTheDocument();
      expect(screen.getByText(/unknown@example.com is not on PageSpace yet/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Invite to PageSpace/i })).toBeInTheDocument();
    });
  });

  it('given user clicks the invite CTA, POSTs to /api/connections/invite with correct email', async () => {
    const user = userEvent.setup();

    vi.mocked(fetchWithAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ user: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
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
      expect(screen.getByRole('button', { name: /Invite to PageSpace/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Invite to PageSpace/i }));

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith('/api/connections/invite', {
        email: 'unknown@example.com',
      });
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining('unknown@example.com')
      );
    });
  });

  it('given invite returns 409 (already pending), shows appropriate error toast', async () => {
    const user = userEvent.setup();

    vi.mocked(fetchWithAuth).mockResolvedValueOnce(
      new Response(JSON.stringify({ user: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.mocked(post).mockRejectedValueOnce(
      new Error('An invitation is already pending for this email.')
    );

    const discoverTab = renderAndGetTab();
    await user.click(discoverTab);

    const input = screen.getByPlaceholderText('Enter email address');
    await user.type(input, 'unknown@example.com');
    await user.click(screen.getByRole('button', { name: /Find User/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Invite to PageSpace/i })).toBeInTheDocument()
    );

    await user.click(screen.getByRole('button', { name: /Invite to PageSpace/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('already have a pending connection invite')
      );
    });
  });
});
