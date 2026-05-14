import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

type PendingInviteFixture = {
  id: string;
  email: string;
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  invitedByName: string;
  createdAt: string;
  expiresAt: string;
};

const okMembers = (
  members: ReturnType<typeof member>[],
  currentUserRole = 'OWNER',
  pendingInvites: PendingInviteFixture[] = [],
) =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ currentUserRole, members, pendingInvites }),
  });

const okAgentMembers = (currentUserRole = 'OWNER') =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ agentMembers: [], currentUserRole }),
  });

const okRoles = () =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ roles: [] }),
  });

// fetchMembers() fires 3 parallel requests on each invocation.
// On initial mount, DriveShareLinkSection adds 1 more for /roles (keyed on driveId, not socket events).
const MEMBER_FETCHES = 3;
const FETCHES_PER_CALL = MEMBER_FETCHES + 1;

const urlAwareMock = (
  members: ReturnType<typeof member>[],
  currentUserRole = 'OWNER',
  pendingInvites: PendingInviteFixture[] = [],
) =>
  (url: string) => {
    if (url.endsWith('/agents/members')) return okAgentMembers(currentUserRole);
    if (url.endsWith('/roles')) return okRoles();
    return okMembers(members, currentUserRole, pendingInvites);
  };

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

  const samplePending = (overrides: Partial<PendingInviteFixture> = {}): PendingInviteFixture => ({
    id: 'inv_1',
    email: 'invitee@example.com',
    role: 'MEMBER',
    invitedByName: 'Alice',
    createdAt: '2026-05-01T00:00:00Z',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  });

  it('Given accepted members and pending invites, renders both sections with correct counts', async () => {
    mockFetchWithAuth.mockImplementation(
      urlAwareMock(
        [member({ userId: 'a1' }), member({ userId: 'a2' })],
        'OWNER',
        [samplePending(), samplePending({ id: 'inv_2', email: 'b@example.com' })],
      )
    );
    render(<DriveMembers driveId="drive-1" />);

    expect(await screen.findByText('Members (2)')).toBeInTheDocument();
    expect(screen.getByText('Pending invitations (2)')).toBeInTheDocument();
  });

  it('Renders no pending section when API returns an empty pendingInvites array', async () => {
    mockFetchWithAuth.mockImplementation(urlAwareMock([member({ userId: 'm1' })]));
    render(<DriveMembers driveId="drive-1" />);
    await screen.findByText(/members \(/i);
    expect(screen.queryByText(/pending invitations/i)).not.toBeInTheDocument();
  });

  it('Given the component mounts, subscribes to all three drive member events', async () => {
    mockFetchWithAuth.mockImplementation(urlAwareMock([]));
    render(<DriveMembers driveId="drive-1" />);
    await screen.findByText('Members (0)');
    EVENTS.forEach((e) => expect(socket.__count(e)).toBe(1));
  });

  it.each(EVENTS)('Given %s fires for current driveId, refetches the member list', async (event) => {
    mockFetchWithAuth.mockImplementation(urlAwareMock([]));
    render(<DriveMembers driveId="drive-1" />);
    await screen.findByText('Members (0)');
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(FETCHES_PER_CALL);

    socket.__emit(event, { driveId: 'drive-1' });
    // Socket event only re-triggers fetchMembers() (3 requests); /roles is keyed on driveId, not socket events.
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalledTimes(FETCHES_PER_CALL + MEMBER_FETCHES));
  });

  it('Does NOT refetch when the event is for a different driveId', async () => {
    mockFetchWithAuth.mockImplementation(urlAwareMock([]));
    render(<DriveMembers driveId="drive-1" />);
    await screen.findByText('Members (0)');
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(FETCHES_PER_CALL);

    socket.__emit('drive:member_added', { driveId: 'other' });
    await new Promise((r) => setTimeout(r, 20));
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(FETCHES_PER_CALL);
  });

  it('Given the component unmounts, unsubscribes from all three events', async () => {
    mockFetchWithAuth.mockImplementation(urlAwareMock([]));
    const { unmount } = render(<DriveMembers driveId="drive-1" />);
    await screen.findByText('Members (0)');
    EVENTS.forEach((e) => expect(socket.__count(e)).toBe(1));

    unmount();
    EVENTS.forEach((e) => expect(socket.__count(e)).toBe(0));
  });

});
