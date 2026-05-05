import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DriveMembers } from '../DriveMembers';

const mockFetchWithAuth = vi.fn();
const mockDel = vi.fn();
const mockPost = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...a: unknown[]) => mockFetchWithAuth(...a),
  del: (...a: unknown[]) => mockDel(...a),
  post: (...a: unknown[]) => mockPost(...a),
}));
const stableToast = vi.fn();
vi.mock('@/hooks/useToast', () => ({
  useToast: () => ({ toast: stableToast }),
}));

type SocketHandler = (p: { driveId: string }) => void;
type Sock = {
  on: (e: string, h: SocketHandler) => void;
  off: (e: string, h: SocketHandler) => void;
  __emit: (e: string, p: { driveId: string }) => void;
  __count: (e: string) => number;
};

const makeSocket = (): Sock => {
  const m = new Map<string, SocketHandler[]>();
  return {
    on: (e, h) => m.set(e, [...(m.get(e) ?? []), h]),
    off: (e, h) => m.set(e, (m.get(e) ?? []).filter((x) => x !== h)),
    __emit: (e, p) => (m.get(e) ?? []).forEach((h) => h(p)),
    __count: (e) => (m.get(e) ?? []).length,
  };
};

let socket: Sock;
vi.mock('@/hooks/useSocket', () => ({ useSocket: () => socket }));

const member = (overrides: { userId?: string; acceptedAt?: string | null } = {}) => ({
  id: `dm-${overrides.userId ?? 'u-1'}`,
  userId: overrides.userId ?? 'u-1',
  role: 'MEMBER',
  invitedAt: '2026-05-01T00:00:00Z',
  acceptedAt: overrides.acceptedAt === undefined ? '2026-05-02T00:00:00Z' : overrides.acceptedAt,
  user: { id: overrides.userId ?? 'u-1', email: `${overrides.userId ?? 'u-1'}@x.test`, name: 'X' },
  profile: { displayName: 'X' },
  customRole: null,
  permissionCounts: { view: 0, edit: 0, share: 0 },
});

const okMembers = (members: ReturnType<typeof member>[], currentUserRole = 'OWNER') =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ currentUserRole, members }),
  });

const EVENTS = ['drive:member_added', 'drive:member_removed', 'drive:member_role_changed'] as const;

describe('DriveMembers', () => {
  const originalConfirm = window.confirm;

  beforeEach(() => {
    vi.clearAllMocks();
    socket = makeSocket();
    window.confirm = vi.fn(() => true);
  });

  afterEach(() => {
    window.confirm = originalConfirm;
  });

  it('Given a mix of pending + accepted, renders two distinct sections with correct counts', async () => {
    mockFetchWithAuth.mockImplementation(() =>
      okMembers([
        member({ userId: 'a1' }),
        member({ userId: 'a2' }),
        member({ userId: 'p1', acceptedAt: null }),
      ])
    );
    render(<DriveMembers driveId="drive-1" />);

    expect(await screen.findByText('Members (2)')).toBeInTheDocument();
    expect(screen.getByText('Pending invitations (1)')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('Strict null check: acceptedAt undefined must NOT classify as pending', async () => {
    mockFetchWithAuth.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            currentUserRole: 'OWNER',
            members: [{ ...member({ userId: 'm1' }), acceptedAt: undefined }],
          }),
      })
    );
    render(<DriveMembers driveId="drive-1" />);
    await screen.findByText(/members \(/i);
    expect(screen.queryByText(/pending invitations/i)).not.toBeInTheDocument();
  });

  it('Given Revoke succeeds on a pending row, removes it from local state without a refetch', async () => {
    mockFetchWithAuth.mockImplementation(() =>
      okMembers([
        member({ userId: 'a1' }),
        member({ userId: 'p1', acceptedAt: null }),
      ])
    );
    mockDel.mockResolvedValue(undefined);

    render(<DriveMembers driveId="drive-1" />);
    await screen.findByText('Pending invitations (1)');
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

    await userEvent.setup().click(screen.getByRole('button', { name: /revoke invitation/i }));
    await waitFor(() =>
      expect(screen.queryByText(/pending invitations/i)).not.toBeInTheDocument()
    );
    expect(mockDel).toHaveBeenCalledWith('/api/drives/drive-1/members/p1');
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('Given the component mounts, subscribes to all three drive member events', async () => {
    mockFetchWithAuth.mockImplementation(() => okMembers([]));
    render(<DriveMembers driveId="drive-1" />);
    await screen.findByText('Members (0)');
    EVENTS.forEach((e) => expect(socket.__count(e)).toBe(1));
  });

  it.each(EVENTS)('Given %s fires for current driveId, refetches the member list', async (event) => {
    mockFetchWithAuth.mockImplementation(() => okMembers([]));
    render(<DriveMembers driveId="drive-1" />);
    await screen.findByText('Members (0)');
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

    socket.__emit(event, { driveId: 'drive-1' });
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalledTimes(2));
  });

  it('Does NOT refetch when the event is for a different driveId', async () => {
    mockFetchWithAuth.mockImplementation(() => okMembers([]));
    render(<DriveMembers driveId="drive-1" />);
    await screen.findByText('Members (0)');
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

    socket.__emit('drive:member_added', { driveId: 'other' });
    await new Promise((r) => setTimeout(r, 20));
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('Given the component unmounts, unsubscribes from all three events', async () => {
    mockFetchWithAuth.mockImplementation(() => okMembers([]));
    const { unmount } = render(<DriveMembers driveId="drive-1" />);
    await screen.findByText('Members (0)');
    EVENTS.forEach((e) => expect(socket.__count(e)).toBe(1));

    unmount();
    EVENTS.forEach((e) => expect(socket.__count(e)).toBe(0));
  });

  describe('Resend invitation', () => {
    it('Given a pending row\'s Resend is clicked, POSTs to the resend endpoint with empty body', async () => {
      mockFetchWithAuth.mockImplementation(() =>
        okMembers([member({ userId: 'p1', acceptedAt: null })])
      );
      mockPost.mockResolvedValue({});

      render(<DriveMembers driveId="drive-1" />);
      await screen.findByText('Pending invitations (1)');

      await userEvent.setup().click(screen.getByRole('button', { name: /resend invitation/i }));

      await waitFor(() =>
        expect(mockPost).toHaveBeenCalledWith('/api/drives/drive-1/members/p1/resend')
      );
    });

    it('Given a 200 response, toasts success and refetches members', async () => {
      mockFetchWithAuth.mockImplementation(() =>
        okMembers([member({ userId: 'p1', acceptedAt: null })])
      );
      mockPost.mockResolvedValue({ success: true });

      render(<DriveMembers driveId="drive-1" />);
      await screen.findByText('Pending invitations (1)');
      expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

      await userEvent.setup().click(screen.getByRole('button', { name: /resend invitation/i }));

      await waitFor(() =>
        expect(stableToast).toHaveBeenCalledWith(
          expect.objectContaining({
            description: expect.stringMatching(/invitation resent/i),
          })
        )
      );
      // Refetch fires so invitedAt-derived UI updates.
      await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalledTimes(2));
    });

    it('Given a 429 response, surfaces the rate-limit error message in a destructive toast', async () => {
      mockFetchWithAuth.mockImplementation(() =>
        okMembers([member({ userId: 'p1', acceptedAt: null })])
      );
      mockPost.mockRejectedValue(
        Object.assign(new Error('Too many resend attempts. Please try again later.'), {
          status: 429,
        })
      );

      render(<DriveMembers driveId="drive-1" />);
      await screen.findByText('Pending invitations (1)');

      await userEvent.setup().click(screen.getByRole('button', { name: /resend invitation/i }));

      await waitFor(() =>
        expect(stableToast).toHaveBeenCalledWith(
          expect.objectContaining({
            variant: 'destructive',
            description: expect.stringMatching(/too many resend/i),
          })
        )
      );
      // No refetch on failure.
      expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
    });

    it('Given a generic error, surfaces the message in a destructive toast', async () => {
      mockFetchWithAuth.mockImplementation(() =>
        okMembers([member({ userId: 'p1', acceptedAt: null })])
      );
      mockPost.mockRejectedValue(new Error('Network down'));

      render(<DriveMembers driveId="drive-1" />);
      await screen.findByText('Pending invitations (1)');

      await userEvent.setup().click(screen.getByRole('button', { name: /resend invitation/i }));

      await waitFor(() =>
        expect(stableToast).toHaveBeenCalledWith(
          expect.objectContaining({
            variant: 'destructive',
            description: expect.stringMatching(/network down/i),
          })
        )
      );
    });
  });
});
