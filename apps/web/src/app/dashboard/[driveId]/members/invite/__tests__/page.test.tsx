import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('next/navigation', () => ({
  useParams: () => ({ driveId: 'drive-1' }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

const mockToast = vi.fn();
vi.mock('@/hooks/useToast', () => ({ useToast: () => ({ toast: mockToast }) }));

const mockPost = vi.fn();
const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  post: (...a: unknown[]) => mockPost(...a),
  fetchWithAuth: (...a: unknown[]) => mockFetchWithAuth(...a),
}));

vi.mock('@/components/members/PermissionsGrid', () => ({
  PermissionsGrid: () => <div data-testid="permissions-grid" />,
}));
vi.mock('@/hooks/useDebounce', () => ({ useDebounce: <T,>(v: T) => v }));

import InviteMemberPage from '../page';

const okJson = (d: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(d) });

const setupRolesAndSearch = () => {
  mockFetchWithAuth.mockImplementation((url: string) =>
    url.includes('/roles') ? okJson({ roles: [] }) : okJson({ users: [] })
  );
};

const triggerEmailInvite = async (email: string) => {
  const user = userEvent.setup();
  await user.type(await screen.findByPlaceholderText(/search by username/i), email);
  await user.click(await screen.findByRole('button', { name: new RegExp(`invite ${email}`, 'i') }));
  await user.click(await screen.findByRole('button', { name: /invite member/i }));
  return user;
};

describe('InviteMemberPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupRolesAndSearch();
  });

  it('Given an admin types an email with no matching user, the CTA fires handleInviteEmail and surfaces pending state', async () => {
    const user = userEvent.setup();
    render(<InviteMemberPage />);
    await user.type(await screen.findByPlaceholderText(/search by username/i), 'newuser@example.com');
    await user.click(
      await screen.findByRole('button', { name: /invite newuser@example.com/i })
    );
    expect(screen.getByText('newuser@example.com')).toBeInTheDocument();
    expect((await screen.findAllByText(/will receive an email invitation/i)).length).toBeGreaterThan(0);
  });

  it('Given Invite is clicked with a pending email, POSTs { email, role, customRoleId, permissions }', async () => {
    mockPost.mockResolvedValue({ kind: 'invited', email: 'newuser@example.com' });
    render(<InviteMemberPage />);
    await triggerEmailInvite('newuser@example.com');

    await waitFor(() => expect(mockPost).toHaveBeenCalledTimes(1));
    expect(mockPost.mock.calls[0][0]).toBe('/api/drives/drive-1/members/invite');
    expect(mockPost.mock.calls[0][1]).toMatchObject({
      email: 'newuser@example.com',
      role: 'MEMBER',
      customRoleId: null,
      permissions: [],
    });
  });

  it('Given the response has kind: invited, toast shows "Invitation sent to [email]"', async () => {
    mockPost.mockResolvedValue({ kind: 'invited', email: 'a@b.com' });
    render(<InviteMemberPage />);
    await triggerEmailInvite('a@b.com');

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Invitation sent to a@b.com' })
      )
    );
  });

  it('Given the response has kind: added, toast shows "Member invited successfully"', async () => {
    mockPost.mockResolvedValue({ kind: 'added', memberId: 'm-1' });
    render(<InviteMemberPage />);
    await triggerEmailInvite('existing@example.com');

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Member invited successfully' })
      )
    );
  });

  it('Given the response is 409 (already pending), toast shows the conflict message', async () => {
    mockPost.mockRejectedValue(new Error('An invitation is already pending for this email.'));
    render(<InviteMemberPage />);
    await triggerEmailInvite('newuser@example.com');

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'An invitation is already pending for this email.',
          variant: 'destructive',
        })
      )
    );
  });

  it('Snapshots the email at submit time so the toast renders the right address even if state churns', async () => {
    let resolvePost!: (v: { kind: 'invited' }) => void;
    mockPost.mockImplementation(() => new Promise((resolve) => { resolvePost = resolve; }));

    render(<InviteMemberPage />);
    await triggerEmailInvite('snapshot@example.com');

    resolvePost({ kind: 'invited' });

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Invitation sent to snapshot@example.com' })
      )
    );
  });
});
