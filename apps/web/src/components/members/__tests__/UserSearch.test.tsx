import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserSearch } from '../UserSearch';

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth } from '@/lib/auth/auth-fetch';

const respondWith = (users: Array<Record<string, unknown>>) => {
  vi.mocked(fetchWithAuth).mockResolvedValue(
    new Response(JSON.stringify({ users }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }) as never
  );
};

describe('UserSearch invite-by-email affordance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given a 2+ character email-format query with zero results, renders an "Invite … to PageSpace" CTA surfacing the typed email', async () => {
    respondWith([]);
    const user = userEvent.setup();

    render(<UserSearch onSelect={vi.fn()} onInviteEmail={vi.fn()} />);
    await user.type(screen.getByPlaceholderText(/Search by username/i), 'newcomer@example.com');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Invite newcomer@example\.com to PageSpace/i })).toBeInTheDocument();
    });
  });

  it('given a 2+ character non-email query with zero results, renders today\'s "no users found" message and no CTA', async () => {
    respondWith([]);
    const user = userEvent.setup();

    render(<UserSearch onSelect={vi.fn()} onInviteEmail={vi.fn()} />);
    await user.type(screen.getByPlaceholderText(/Search by username/i), 'jane');

    await waitFor(() => {
      expect(screen.getByText(/No users found/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Invite .* to PageSpace/i })).not.toBeInTheDocument();
  });

  it('given the invite CTA is clicked, invokes onInviteEmail with the lowercased trimmed email', async () => {
    respondWith([]);
    const onInviteEmail = vi.fn();
    const user = userEvent.setup();

    render(<UserSearch onSelect={vi.fn()} onInviteEmail={onInviteEmail} />);
    await user.type(screen.getByPlaceholderText(/Search by username/i), '  Newcomer@Example.COM  ');

    const cta = await screen.findByRole('button', {
      name: /Invite newcomer@example\.com to PageSpace/i,
    });
    await user.click(cta);

    expect(onInviteEmail).toHaveBeenCalledWith('newcomer@example.com');
  });

  it('given onInviteEmail prop is omitted, never renders the CTA even when query looks like an email', async () => {
    respondWith([]);
    const user = userEvent.setup();

    render(<UserSearch onSelect={vi.fn()} />);
    await user.type(screen.getByPlaceholderText(/Search by username/i), 'newcomer@example.com');

    await waitFor(() => {
      expect(screen.getByText(/No users found/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Invite .* to PageSpace/i })).not.toBeInTheDocument();
  });
});
