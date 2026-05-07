import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PendingInviteRow, type PendingInvite } from '../PendingInviteRow';

const buildInvite = (overrides: Partial<PendingInvite> = {}): PendingInvite => ({
  id: 'inv_1',
  email: 'invitee@example.com',
  role: 'MEMBER',
  invitedByName: 'Alice',
  createdAt: '2026-05-01T00:00:00Z',
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  ...overrides,
});

describe('PendingInviteRow', () => {
  it('renders invitee email and inviter name', () => {
    render(<PendingInviteRow invite={buildInvite()} />);
    expect(screen.getByText('invitee@example.com')).toBeInTheDocument();
    expect(screen.getByText(/Invited by Alice/)).toBeInTheDocument();
  });

  it('shows Pending badge for non-expired invites', () => {
    render(<PendingInviteRow invite={buildInvite()} />);
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.queryByText('Expired')).not.toBeInTheDocument();
  });

  it('shows Expired badge for past-expiry invites', () => {
    const expiresAt = new Date(Date.now() - 1000).toISOString();
    render(<PendingInviteRow invite={buildInvite({ expiresAt })} />);
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.queryByText('Pending')).not.toBeInTheDocument();
  });

  it('renders role-specific badge: Member', () => {
    render(<PendingInviteRow invite={buildInvite({ role: 'MEMBER' })} />);
    expect(screen.getByText('Member')).toBeInTheDocument();
  });

  it('renders role-specific badge: Admin', () => {
    render(<PendingInviteRow invite={buildInvite({ role: 'ADMIN' })} />);
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  it('attaches data-invite-id for downstream interaction', () => {
    const { container } = render(<PendingInviteRow invite={buildInvite({ id: 'inv_xyz' })} />);
    const row = container.querySelector('[data-testid="pending-invite-row"]');
    expect(row).toBeInTheDocument();
    expect(row?.getAttribute('data-invite-id')).toBe('inv_xyz');
  });

  it('does not render a revoke button when canRevoke is false', () => {
    render(<PendingInviteRow invite={buildInvite()} onRevoke={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /revoke invitation/i })).not.toBeInTheDocument();
  });

  it('does not render a revoke button when onRevoke is missing', () => {
    render(<PendingInviteRow invite={buildInvite()} canRevoke />);
    expect(screen.queryByRole('button', { name: /revoke invitation/i })).not.toBeInTheDocument();
  });

  it('renders a revoke button when canRevoke + onRevoke are both provided', () => {
    render(<PendingInviteRow invite={buildInvite()} canRevoke onRevoke={vi.fn()} />);
    expect(screen.getByRole('button', { name: /revoke invitation/i })).toBeInTheDocument();
  });

  it('opens confirmation dialog and calls onRevoke with the invite id on confirm', async () => {
    const onRevoke = vi.fn().mockResolvedValue(undefined);
    render(<PendingInviteRow invite={buildInvite({ id: 'inv_42' })} canRevoke onRevoke={onRevoke} />);

    await userEvent.setup().click(screen.getByRole('button', { name: /revoke invitation/i }));

    expect(screen.getByText(/revoke this invitation/i)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /^revoke$/i }));

    expect(onRevoke).toHaveBeenCalledWith('inv_42');
  });

  it('does not call onRevoke when user cancels the dialog', async () => {
    const onRevoke = vi.fn();
    render(<PendingInviteRow invite={buildInvite()} canRevoke onRevoke={onRevoke} />);

    await userEvent.setup().click(screen.getByRole('button', { name: /revoke invitation/i }));
    await userEvent.setup().click(screen.getByRole('button', { name: /cancel/i }));

    expect(onRevoke).not.toHaveBeenCalled();
  });
});
