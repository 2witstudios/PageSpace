import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

const { fetchWithAuth, del } = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), del: vi.fn() }));
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth, del }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'user_me' } }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { BlockedUsersList } from '../BlockedUsersList';

const person = (id: string, name: string) => ({ id, name, email: `${id}@x.test`, image: null, username: null, displayName: name, bio: null, avatarUrl: null });

describe('BlockedUsersList', () => {
  beforeEach(() => {
    del.mockReset().mockResolvedValue({});
    fetchWithAuth.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          connections: [
            { id: 'c1', status: 'BLOCKED', blockedBy: 'user_me', user: person('user_sam', 'Sam') },
            { id: 'c2', status: 'BLOCKED', blockedBy: 'user_kim', user: person('user_kim', 'Kim') },
          ],
        }),
    });
  });

  const renderList = () =>
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <BlockedUsersList />
      </SWRConfig>,
    );

  it('given users I blocked and users who blocked me, should list only the ones I blocked', async () => {
    renderList();
    expect(await screen.findByText('Sam')).toBeTruthy();
    expect(screen.queryByText('Kim')).toBeNull();
  });

  it('given I unblock someone, should lift the block', async () => {
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: 'Unblock Sam' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/users/user_sam/block'));
  });
});
