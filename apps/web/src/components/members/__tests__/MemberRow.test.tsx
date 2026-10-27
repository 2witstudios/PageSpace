import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemberRow } from '../MemberRow';

const buildMember = (acceptedAt: string | null, role = 'MEMBER') => ({
  id: 'dm-1',
  userId: 'user-1',
  role,
  invitedAt: '2026-05-01T00:00:00Z',
  acceptedAt,
  user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
  profile: { displayName: 'Test User', username: 'testuser' },
  customRole: null,
  permissionCounts: { view: 2, edit: 1, share: 0 },
});

const renderRow = (
  acceptedAt: string | null,
  opts: {
    currentUserRole?: 'OWNER' | 'ADMIN' | 'MEMBER';
    onRemove?: () => void;
    role?: string;
  } = {}
) =>
  render(
    <MemberRow
      member={buildMember(acceptedAt, opts.role)}
      driveId="drive-1"
      currentUserRole={opts.currentUserRole ?? 'OWNER'}
      onRemove={opts.onRemove ?? vi.fn()}
    />
  );

describe('MemberRow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows Member Settings + Remove for OWNER on a regular row', async () => {
    const onRemove = vi.fn();
    renderRow('2026-05-02T00:00:00Z', { onRemove });
    expect(screen.queryByText('Pending')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /member settings/i })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /remove member/i }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('does not render a Remove button for OWNER role member', () => {
    renderRow('2026-05-02T00:00:00Z', { role: 'OWNER' });
    expect(screen.queryByRole('button', { name: /remove member/i })).not.toBeInTheDocument();
  });

  it('hides Member Settings + Remove for non-managers', () => {
    renderRow('2026-05-02T00:00:00Z', { currentUserRole: 'MEMBER' });
    expect(screen.queryByRole('button', { name: /member settings/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove member/i })).not.toBeInTheDocument();
  });

  // Pending invites no longer share this component — they live in
  // PendingInviteRow + PendingInvitesSection, fed by a separate API field.
  // drive_members rows always have acceptedAt set post-cutover.
});
