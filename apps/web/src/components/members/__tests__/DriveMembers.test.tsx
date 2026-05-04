import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
  del: vi.fn().mockResolvedValue(undefined),
  post: vi.fn().mockResolvedValue(undefined),
}));

const stableRouter = { push: vi.fn() };
vi.mock('next/navigation', () => ({
  useRouter: () => stableRouter,
}));

const stableToast = { toast: vi.fn() };
vi.mock('@/hooks/useToast', () => ({
  useToast: () => stableToast,
}));

const socketHandlers = new Map<string, Array<(payload: unknown) => void>>();
const socketEmit = vi.fn();
const fakeSocket = {
  on: (event: string, handler: (payload: unknown) => void) => {
    const list = socketHandlers.get(event) ?? [];
    list.push(handler);
    socketHandlers.set(event, list);
  },
  off: (event: string, handler: (payload: unknown) => void) => {
    const list = socketHandlers.get(event) ?? [];
    socketHandlers.set(
      event,
      list.filter((h) => h !== handler)
    );
  },
  emit: socketEmit,
};

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => fakeSocket,
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'me' }, isAuthenticated: true }),
}));

import { DriveMembers } from '../DriveMembers';
import { fetchWithAuth, del, post } from '@/lib/auth/auth-fetch';

const buildMember = (overrides: Partial<{
  id: string;
  userId: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  acceptedAt: string | null;
  email: string;
  displayName: string;
}> = {}) => ({
  id: overrides.id ?? 'mem_1',
  userId: overrides.userId ?? 'user_1',
  role: overrides.role ?? 'MEMBER',
  invitedAt: '2026-05-01T00:00:00Z',
  acceptedAt: 'acceptedAt' in overrides ? overrides.acceptedAt : '2026-05-02T00:00:00Z',
  user: {
    id: overrides.userId ?? 'user_1',
    email: overrides.email ?? 'alice@example.com',
    name: overrides.displayName ?? 'Alice',
  },
  profile: { displayName: overrides.displayName ?? 'Alice' },
  customRole: null,
  permissionCounts: { view: 0, edit: 0, share: 0 },
});

const respondWithMembers = (
  members: ReturnType<typeof buildMember>[],
  currentUserRole: 'OWNER' | 'ADMIN' | 'MEMBER' = 'OWNER'
) => {
  const body = JSON.stringify({ members, currentUserRole });
  vi.mocked(fetchWithAuth).mockImplementation(
    async () =>
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as never
  );
};

describe('DriveMembers pending invitations section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socketHandlers.clear();
    socketEmit.mockClear();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('given pending and accepted members for a drive, renders them in distinct visually grouped sections', async () => {
    respondWithMembers([
      buildMember({ id: 'mem_alice', userId: 'user_alice', email: 'alice@example.com', displayName: 'Alice' }),
      buildMember({ id: 'mem_bob', userId: 'user_bob', email: 'bob@example.com', displayName: 'Bob', acceptedAt: null }),
    ]);

    render(<DriveMembers driveId="drive_xyz" />);

    await waitFor(() => {
      expect(screen.getByText(/Pending invitations/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Members \(1\)/i)).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('bob@example.com')).toBeInTheDocument();
    expect(screen.getAllByText('Pending')).toHaveLength(1);
  });

  it('given a pending member row, exposes Revoke to owners and removes the row on success without a full refetch', async () => {
    respondWithMembers([
      buildMember({ id: 'mem_pending', userId: 'user_pending', email: 'pending@example.com', acceptedAt: null }),
    ]);
    const user = userEvent.setup();

    render(<DriveMembers driveId="drive_xyz" />);

    const revokeBtn = await screen.findByRole('button', { name: /Revoke invitation/i });
    await user.click(revokeBtn);

    await waitFor(() => {
      expect(del).toHaveBeenCalledWith('/api/drives/drive_xyz/members/user_pending');
    });
  });

  it('given an owner clicks Resend on a pending row, calls POST /api/drives/[driveId]/members/[userId]/resend', async () => {
    respondWithMembers([
      buildMember({ id: 'mem_pending', userId: 'user_pending', acceptedAt: null }),
    ]);
    const user = userEvent.setup();

    render(<DriveMembers driveId="drive_xyz" />);

    const resendBtn = await screen.findByRole('button', { name: /Resend invitation/i });
    await user.click(resendBtn);

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith('/api/drives/drive_xyz/members/user_pending/resend', {});
    });
  });

  it('given current user is a regular MEMBER, Resend action is not exposed for pending rows', async () => {
    respondWithMembers(
      [buildMember({ id: 'mem_pending', userId: 'user_pending', acceptedAt: null })],
      'MEMBER'
    );

    render(<DriveMembers driveId="drive_xyz" />);

    await waitFor(() => {
      expect(screen.getByText('Pending')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Resend invitation/i })).not.toBeInTheDocument();
  });

  it('given current user is a regular MEMBER, Revoke action is not exposed for pending rows', async () => {
    respondWithMembers(
      [buildMember({ id: 'mem_pending', userId: 'user_pending', acceptedAt: null })],
      'MEMBER'
    );

    render(<DriveMembers driveId="drive_xyz" />);

    await waitFor(() => {
      expect(screen.getByText('Pending')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Revoke invitation/i })).not.toBeInTheDocument();
  });

  it('given a drive:member_added realtime event for this drive, refetches the members list so a previously pending row moves to the accepted section', async () => {
    respondWithMembers([
      buildMember({ id: 'mem_p', userId: 'u_p', email: 'p@example.com', acceptedAt: null }),
    ]);

    render(<DriveMembers driveId="drive_xyz" />);

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    });

    respondWithMembers([
      buildMember({ id: 'mem_p', userId: 'u_p', email: 'p@example.com', acceptedAt: '2026-05-03T00:00:00Z', displayName: 'P User' }),
    ]);

    const handlers = socketHandlers.get('drive:member_added') ?? [];
    expect(handlers.length).toBeGreaterThan(0);
    handlers.forEach((handler) => handler({ driveId: 'drive_xyz', operation: 'member_added' }));

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledTimes(2);
    });
  });

  it('given a drive:member_added realtime event for an unrelated drive, does not refetch this drive\'s members', async () => {
    respondWithMembers([buildMember()]);

    render(<DriveMembers driveId="drive_xyz" />);

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledTimes(1);
    });

    const handlers = socketHandlers.get('drive:member_added') ?? [];
    handlers.forEach((handler) => handler({ driveId: 'drive_OTHER', operation: 'member_added' }));

    expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  });
});
