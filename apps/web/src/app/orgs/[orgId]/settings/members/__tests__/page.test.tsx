import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  role: 'ADMIN' as 'OWNER' | 'ADMIN' | 'MEMBER',
  notice: undefined as undefined | Record<string, unknown>,
  reads: {} as Record<string, unknown>,
  changeOrgMemberRole: vi.fn(),
  removeOrgMember: vi.fn(),
  resendOrgInvitation: vi.fn(),
  revokeOrgInvitation: vi.fn(),
  inviteToOrg: vi.fn(),
  setOrgSeatCap: vi.fn(),
  clearOrgSeatCap: vi.fn(),
  mutate: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useParams: () => ({ orgId: 'org_nw' }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('swr', async (importOriginal) => ({ ...(await importOriginal<typeof import('swr')>()), useSWRConfig: () => ({ mutate: mocks.mutate }) }));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock('@/hooks/useBillingVisibility', () => ({ useBillingVisibility: () => ({ showBilling: true }) }));
vi.mock('@/hooks/useOrgs', () => ({
  useOrg: () => ({
    org: {
      organization: { id: 'org_nw', name: 'Northwind Labs', slug: 'northwind', avatarUrl: null, ownerId: 'u_jono', createdAt: '' },
      viewer: { userId: 'u_priya', role: mocks.role },
      billingNotice: mocks.notice,
    },
    isLoading: false,
    mutate: vi.fn(),
  }),
  useOrgRealtime: vi.fn(),
  useOrgAdminRead: (key: string) => ({ data: mocks.reads[key] }),
  useOrgSeats: () => ({ data: { seats: { members: 3, pendingInvites: 1, held: 4, included: 5, purchasedExtra: 10, purchased: 15, autoAdd: true, hasSubscription: true, currentPeriodEnd: null } } }),
}));
vi.mock('@/lib/orgs/org-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orgs/org-api')>()),
  changeOrgMemberRole: mocks.changeOrgMemberRole,
  removeOrgMember: mocks.removeOrgMember,
  resendOrgInvitation: mocks.resendOrgInvitation,
  revokeOrgInvitation: mocks.revokeOrgInvitation,
  inviteToOrg: mocks.inviteToOrg,
  setOrgSeatCap: mocks.setOrgSeatCap,
  clearOrgSeatCap: mocks.clearOrgSeatCap,
}));

import OrgMembersPage from '../page';

const future = new Date(Date.now() + 6 * 86_400_000 - 3_600_000).toISOString();
const member = (userId: string, role: string, name: string) => ({ userId, role, name, email: `${userId.slice(2)}@northwind.com`, image: null, joinedAt: '' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'ADMIN';
  mocks.notice = undefined;
  mocks.reads = {
    '/api/orgs/org_nw/members': { members: [member('u_jono', 'OWNER', 'Jono Woodall'), member('u_priya', 'ADMIN', 'Priya Nair'), member('u_marcus', 'MEMBER', 'Marcus Oyelaran')] },
    '/api/orgs/org_nw/invitations': { invitations: [{ id: 'inv_sam', orgId: 'org_nw', email: 'sam@northwind.com', role: 'MEMBER', invitedBy: 'u_priya', expiresAt: future, acceptedAt: null, createdAt: '' }] },
    '/api/orgs/org_nw/guests': { guests: [{ userId: 'u_chris', name: 'Chris Rowe', email: 'chris@partner.co', image: null, drives: [{ id: 'd_mkt', name: 'Marketing Site', pending: false, source: 'invited', pageCount: 0 }] }, { userId: 'u_gail', name: 'Gail Link', email: 'gail@partner.co', image: null, drives: [{ id: 'd_prod', name: 'Product', pending: false, source: 'page_link', pageCount: 2 }] }] },
    '/api/orgs/org_nw/members/activity': { activity: [{ userId: 'u_jono', driveCount: 6, lastActiveAt: new Date().toISOString() }, { userId: 'u_marcus', driveCount: 3, lastActiveAt: null }] },
    '/api/orgs/org_nw/seat-caps': {
      walletId: 'w_pool',
      seatAllowanceCents: 150,
      seats: [
        { userId: 'u_jono', displayName: 'Jono', dailyCapCents: null, monthlyCapCents: null, monthlyLimitCents: 150, monthlyRemainingCents: 150, dailyRemainingCents: null },
        { userId: 'u_marcus', displayName: 'Marcus', dailyCapCents: 50, monthlyCapCents: null, monthlyLimitCents: 150, monthlyRemainingCents: 54, dailyRemainingCents: 50 },
      ],
    },
  };
  for (const fn of [mocks.changeOrgMemberRole, mocks.removeOrgMember, mocks.resendOrgInvitation, mocks.revokeOrgInvitation, mocks.inviteToOrg, mocks.setOrgSeatCap, mocks.clearOrgSeatCap]) fn.mockResolvedValue({});
});

const row = (name: string) => screen.getByText(name).closest('div.flex.flex-wrap') as HTMLElement;

describe('Members & seats', () => {
  it('UI-7 (partial): seats in use of purchased, guests and admins, with drives, last active and seat caps per member', () => {
    render(<OrgMembersPage />);
    expect(screen.getByRole('heading', { name: 'Members & seats' })).toBeTruthy();
    expect(screen.getByText('of 15 seats')).toBeTruthy();
    expect(screen.getByText('Seats in use · 1 reserved by pending invites')).toBeTruthy();
    expect(within(row('Jono Woodall')).getByText('6 drives')).toBeTruthy();
    expect(within(row('Jono Woodall')).getByText('Now')).toBeTruthy();
    expect(within(row('Jono Woodall')).getByText('No caps')).toBeTruthy();
    expect(within(row('Marcus Oyelaran')).getByText('50 a day')).toBeTruthy();
    expect(within(row('Marcus Oyelaran')).getByText('3 drives')).toBeTruthy();
  });

  it('SEAT-3 (partial): the pending count is the server\'s seats.pendingInvites, not a client count (one source)', () => {
    // The seats read says 1 pending; the invitations list holds one live row too, so make them differ.
    (mocks.reads['/api/orgs/org_nw/invitations'] as { invitations: unknown[] }).invitations.push({ id: 'inv_old', orgId: 'org_nw', email: 'x@y.io', role: 'MEMBER', invitedBy: null, expiresAt: future, acceptedAt: null, createdAt: '' });
    render(<OrgMembersPage />);
    expect(screen.getByText('Seats in use · 1 reserved by pending invites')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Pending/ }).textContent).toContain('1');
  });

  it('UI-7 (partial): a pending invitation shows who invited, when it expires and the reserved seat; guests list their drives', () => {
    render(<OrgMembersPage />);
    expect(screen.getByText('Invited by Priya Nair · expires in 6 days · seat reserved')).toBeTruthy();
    expect(screen.getByText('chris@partner.co · 1 drive · in Marketing Site (invited)')).toBeTruthy();
    // A page-link guest is on the org-wide list too, by source, with the pages they hold.
    expect(screen.getByText('gail@partner.co · 1 drive · 2 pages · in Product (page link, 2 pages)')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Guests (2)' })).toBeTruthy();
  });

  it('tabs filter to admins, to pending invitations, and to guests', async () => {
    render(<OrgMembersPage />);
    await userEvent.click(screen.getByRole('tab', { name: /Admins/ }));
    expect(screen.queryByText('Marcus Oyelaran')).toBeNull();
    expect(screen.getByText('Priya Nair')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: /Pending/ }));
    expect(screen.getByText('sam@northwind.com')).toBeTruthy();
    expect(screen.queryByText('Priya Nair')).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: /Guests/ }));
    expect(screen.getByText('Chris Rowe')).toBeTruthy();
    expect(screen.queryByText('sam@northwind.com')).toBeNull();
  });

  it('Owner role is fixed; an Admin changes another member\'s role', async () => {
    render(<OrgMembersPage />);
    expect(screen.queryByRole('combobox', { name: 'Org role for Jono Woodall' })).toBeNull();
    await userEvent.click(screen.getByRole('combobox', { name: 'Org role for Marcus Oyelaran' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Admin' }));
    await waitFor(() => expect(mocks.changeOrgMemberRole).toHaveBeenCalledWith('org_nw', 'u_marcus', 'ADMIN'));
  });

  it('Give a seat invites the guest by email', async () => {
    render(<OrgMembersPage />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Give a seat' })[0]);
    await waitFor(() => expect(mocks.inviteToOrg).toHaveBeenCalledWith('org_nw', { email: 'chris@partner.co' }));
  });

  it('WAL-7 (partial): seat caps are written in credits as whole cents, from the member menu', async () => {
    render(<OrgMembersPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Marcus Oyelaran' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Seat caps' }));
    expect(screen.getByText('Seat caps · Marcus Oyelaran')).toBeTruthy();
    expect(screen.getByText('54 credits left this month')).toBeTruthy();
    const monthly = screen.getByLabelText('Monthly cap');
    await userEvent.type(monthly, '120');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.setOrgSeatCap).toHaveBeenCalledWith('org_nw', 'u_marcus', { dailyCapCents: 50, monthlyCapCents: 120 }));
  });

  it('WAL-7 (partial): with no caps, saving empty fields turns on the default caps', async () => {
    render(<OrgMembersPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Jono Woodall' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Seat caps' }));
    await userEvent.click(screen.getByRole('button', { name: 'Turn on default caps' }));
    // Explicit defaults, so a stored {null,null} row can never swallow them (review P2-1).
    await waitFor(() => expect(mocks.setOrgSeatCap).toHaveBeenCalledWith('org_nw', 'u_jono', { dailyCapCents: 50, monthlyCapCents: 1000 }));
  });

  it('WAL-7 (partial): emptying both fields on a capped seat removes the caps rather than storing an empty row', async () => {
    render(<OrgMembersPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Marcus Oyelaran' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Seat caps' }));
    await userEvent.clear(screen.getByLabelText('Daily cap'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.clearOrgSeatCap).toHaveBeenCalledWith('org_nw', 'u_marcus'));
    expect(mocks.setOrgSeatCap).not.toHaveBeenCalled();
  });

  it('SEAT-9 (partial) D-OW-33: while lapsed, inviting and giving seats pause; revoking still works; a cap may be lowered but not raised', async () => {
    mocks.notice = { kind: 'reactivate', reason: 'canceled', canManageBilling: true };
    render(<OrgMembersPage />);
    expect(screen.getByText('Northwind Labs is unpaid and read-only')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Invite people/ }) as HTMLButtonElement).disabled).toBe(true);
    for (const button of screen.getAllByRole('button', { name: 'Give a seat' })) expect((button as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Revoke' }) as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Marcus Oyelaran' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Seat caps' }));
    const daily = screen.getByLabelText('Daily cap');
    await userEvent.clear(daily);
    await userEvent.type(daily, '80');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Raising or removing one is paused/)).toBeTruthy();
    await userEvent.clear(daily);
    await userEvent.type(daily, '20');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Remove caps' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('removing a member asks first', async () => {
    render(<OrgMembersPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Marcus Oyelaran' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Remove from Northwind Labs' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(mocks.removeOrgMember).toHaveBeenCalledWith('org_nw', 'u_marcus'));
  });

  it('UI-11 (partial): a plain Member sees no member management', () => {
    mocks.role = 'MEMBER';
    render(<OrgMembersPage />);
    expect(screen.getByText('Only the Owner or an Admin of Northwind Labs can see this page.')).toBeTruthy();
    expect(screen.queryByText('Marcus Oyelaran')).toBeNull();
  });
});
