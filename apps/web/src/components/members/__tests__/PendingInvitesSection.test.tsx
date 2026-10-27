import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PendingInvitesSection } from '../PendingInvitesSection';
import type { PendingInvite } from '../PendingInviteRow';

const sample: PendingInvite[] = [
  {
    id: 'inv_1',
    email: 'a@example.com',
    role: 'MEMBER',
    invitedByName: 'Alice',
    createdAt: '2026-05-01T00:00:00Z',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'inv_2',
    email: 'b@example.com',
    role: 'ADMIN',
    invitedByName: 'Alice',
    createdAt: '2026-05-01T00:00:00Z',
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  },
];

describe('PendingInvitesSection', () => {
  it('renders both rows for OWNER', () => {
    render(<PendingInvitesSection invites={sample} currentUserRole="OWNER" />);
    expect(screen.getByText('a@example.com')).toBeInTheDocument();
    expect(screen.getByText('b@example.com')).toBeInTheDocument();
  });

  it('renders rows for ADMIN', () => {
    render(<PendingInvitesSection invites={sample} currentUserRole="ADMIN" />);
    expect(screen.getByText('a@example.com')).toBeInTheDocument();
  });

  it('renders nothing for regular MEMBER', () => {
    const { container } = render(
      <PendingInvitesSection invites={sample} currentUserRole="MEMBER" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when invites array is empty', () => {
    const { container } = render(
      <PendingInvitesSection invites={[]} currentUserRole="OWNER" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the count in the section heading', () => {
    render(<PendingInvitesSection invites={sample} currentUserRole="OWNER" />);
    expect(screen.getByText(/Pending invitations \(2\)/)).toBeInTheDocument();
  });
});
