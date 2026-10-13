// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import ConnectionsPage from './page';
import { post } from '@/retained/lib/auth/auth-fetch';

const swr = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));

vi.mock('swr', () => ({
  default: (key: string) => ({ data: swr.data[key], error: undefined, isLoading: false }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/retained/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'me' }, isLoading: false }),
}));

vi.mock('@/retained-adapters/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('@/retained/hooks/useSocket', () => ({ useSocket: () => null }));

vi.mock('@/retained/stores/useNotificationStore', () => ({
  useNotificationStore: { getState: () => ({ notifications: [], updateNotification: vi.fn() }) },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  post: vi.fn(async () => ({})),
  patch: vi.fn(async () => ({})),
  del: vi.fn(async () => ({})),
  fetchWithAuth: vi.fn(),
}));

const requester = {
  id: 'p1',
  status: 'PENDING',
  requestedAt: '2026-10-10T10:00:00Z',
  acceptedAt: null,
  requestMessage: 'Let us work together',
  user: { id: 'u-ada', name: 'Ada Lovelace', email: 'ada@example.com', image: null, username: 'ada', displayName: null, bio: null, avatarUrl: null },
  isRequester: false,
};

const outgoing = {
  ...requester,
  id: 'p2',
  requestMessage: null,
  user: { ...requester.user, id: 'u-grace', name: 'Grace Hopper', email: 'grace@example.com', username: 'grace' },
  isRequester: true,
};

const accepted = {
  id: 'c1',
  status: 'ACCEPTED',
  requestedAt: '2026-09-01T10:00:00Z',
  acceptedAt: '2026-09-02T10:00:00Z',
  requestMessage: null,
  user: { ...requester.user, id: 'u-alan', name: 'Alan Turing', email: 'alan@example.com', username: 'alan' },
  isRequester: false,
};

const setup = (data: Record<string, unknown>) => {
  swr.data = data;
  return render(<ConnectionsPage />);
};

describe('ConnectionsPage (/account/connections)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  test('renders the board h1 and lede', () => {
    setup({});
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Connections');
    expect(screen.getByText('People you’ve connected with can message you directly and be added to your drives.')).toBeTruthy();
  });

  test('renders incoming pending rows with Accept and Decline', () => {
    setup({ '/api/connections?status=PENDING': { connections: [requester] } });
    const section = screen.getByRole('region', { name: 'Pending 1' });
    expect(within(section).getByRole('button', { name: 'Accept request' })).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Decline request' })).toBeTruthy();
    expect(within(section).getByText('“Let us work together”')).toBeTruthy();
  });

  test('renders outgoing pending rows as Sent · awaiting reply', () => {
    setup({ '/api/connections?status=PENDING': { connections: [outgoing] } });
    const section = screen.getByRole('region', { name: 'Pending 1' });
    expect(within(section).getByText('Sent · awaiting reply')).toBeTruthy();
    expect(within(section).queryByRole('button', { name: 'Accept request' })).toBeNull();
  });

  test('renders Your connections with Filter, Message and More actions for each person', () => {
    setup({ '/api/connections?status=ACCEPTED': { connections: [accepted] } });
    const section = screen.getByRole('region', { name: 'Your connections 1' });
    expect(within(section).getByLabelText('Filter connections')).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Message' })).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'More actions for Alan Turing' })).toBeTruthy();
  });

  test('filter narrows the accepted list by name', () => {
    setup({
      '/api/connections?status=ACCEPTED': {
        connections: [accepted, { ...accepted, id: 'c2', user: { ...accepted.user, id: 'u-ada2', name: 'Ada Lovelace', displayName: null, username: 'ada2', email: 'ada2@example.com' } }],
      },
    });
    fireEvent.change(screen.getByLabelText('Filter connections'), { target: { value: 'ada' } });
    expect(screen.queryByText('Alan Turing')).toBeNull();
    expect(screen.getAllByText('Ada Lovelace').length).toBeGreaterThan(0);
  });

  test('the Blocked section shows its empty line when no one is blocked', () => {
    setup({ '/api/connections?status=BLOCKED': { connections: [] } });
    const section = screen.getByRole('region', { name: 'Blocked 0' });
    expect(within(section).getByText(/No one is blocked/)).toBeTruthy();
  });

  test('sending a request posts to /api/connections/invite with the email', async () => {
    setup({});
    fireEvent.change(screen.getByLabelText('Send a connection request'), { target: { value: 'Ada@Example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await vi.waitFor(() => {
      expect(post).toHaveBeenCalledWith('/api/connections/invite', { email: 'ada@example.com' });
    });
  });
});
