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

  describe('Given a pending member row (acceptedAt === null)', () => {
    it('renders a Pending badge', () => {
      renderRow(null);
      expect(screen.getByText('Pending')).toBeInTheDocument();
    });

    it('hides the Member Settings button', () => {
      renderRow(null);
      expect(screen.queryByRole('button', { name: /member settings/i })).not.toBeInTheDocument();
    });

    it.each([['OWNER' as const], ['ADMIN' as const]])(
      'exposes a Revoke button to %s and fires onRemove on click',
      async (role) => {
        const onRemove = vi.fn();
        renderRow(null, { currentUserRole: role, onRemove });
        await userEvent.setup().click(screen.getByRole('button', { name: /revoke invitation/i }));
        expect(onRemove).toHaveBeenCalledOnce();
      }
    );

    it('does NOT expose a Revoke button to MEMBER', () => {
      renderRow(null, { currentUserRole: 'MEMBER' });
      expect(screen.queryByRole('button', { name: /revoke invitation/i })).not.toBeInTheDocument();
    });

    it('does NOT render a Resend button (resend was retired with the broad-sweep cutover)', () => {
      renderRow(null);
      expect(screen.queryByRole('button', { name: /resend invitation/i })).not.toBeInTheDocument();
    });
  });

  describe('Given an accepted member row (acceptedAt !== null)', () => {
    it('does NOT render a Pending badge and shows Member Settings + Remove for OWNER', async () => {
      const onRemove = vi.fn();
      renderRow('2026-05-02T00:00:00Z', { onRemove });
      expect(screen.queryByText('Pending')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /member settings/i })).toBeInTheDocument();
      await userEvent.setup().click(screen.getByRole('button', { name: /remove member/i }));
      expect(onRemove).toHaveBeenCalledOnce();
    });

    it('does NOT render a Remove button for OWNER role', () => {
      renderRow('2026-05-02T00:00:00Z', { role: 'OWNER' });
      expect(screen.queryByRole('button', { name: /remove member/i })).not.toBeInTheDocument();
    });
  });
});
