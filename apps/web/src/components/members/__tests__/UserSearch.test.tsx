import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserSearch } from '../UserSearch';

const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...a: unknown[]) => mockFetchWithAuth(...a),
}));
vi.mock('@/hooks/useDebounce', () => ({
  useDebounce: <T,>(v: T) => v,
}));

const emptyOk = () =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({ users: [] }) });

const typeQuery = async (text: string) => {
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText(/search by username/i), text);
  return user;
};

describe('UserSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchWithAuth.mockImplementation(emptyOk);
  });

  it('Given a 2+ char query matching email regex with zero results AND onInviteEmail provided, renders an "Invite [email] to PageSpace" button (lowercased + trimmed)', async () => {
    render(<UserSearch onSelect={vi.fn()} onInviteEmail={vi.fn()} />);
    await typeQuery('  Mixed.Case@Example.COM  ');
    expect(
      await screen.findByRole('button', { name: /invite mixed\.case@example\.com to pagespace/i })
    ).toBeInTheDocument();
  });

  it('Given a 2+ char query that does NOT match email regex with zero results, renders "no users found"', async () => {
    render(<UserSearch onSelect={vi.fn()} onInviteEmail={vi.fn()} />);
    await typeQuery('just-a-name');
    expect(await screen.findByText(/no users found/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /invite/i })).not.toBeInTheDocument();
  });

  it('Given an email query but no onInviteEmail prop, hides the CTA', async () => {
    render(<UserSearch onSelect={vi.fn()} />);
    await typeQuery('newuser@example.com');
    await waitFor(() => expect(screen.getByText(/no users found/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /invite/i })).not.toBeInTheDocument();
  });

  it('Given the invite CTA is clicked, calls onInviteEmail(normalizedEmail)', async () => {
    const onInviteEmail = vi.fn();
    render(<UserSearch onSelect={vi.fn()} onInviteEmail={onInviteEmail} />);
    const user = await typeQuery('  Foo@Bar.com  ');
    await user.click(await screen.findByRole('button', { name: /invite foo@bar\.com/i }));
    expect(onInviteEmail).toHaveBeenCalledWith('foo@bar.com');
  });
});
