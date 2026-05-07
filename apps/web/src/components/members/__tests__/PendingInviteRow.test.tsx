import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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

  it('attaches data-invite-id for downstream interaction (e.g. revoke in T9)', () => {
    const { container } = render(<PendingInviteRow invite={buildInvite({ id: 'inv_xyz' })} />);
    const row = container.querySelector('[data-testid="pending-invite-row"]');
    expect(row).toBeInTheDocument();
    expect(row?.getAttribute('data-invite-id')).toBe('inv_xyz');
  });
});
