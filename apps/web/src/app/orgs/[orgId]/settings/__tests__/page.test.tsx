import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/auth/auth-fetch';

const mocks = vi.hoisted(() => ({
  useOrg: vi.fn(),
  useOrgHubCounts: vi.fn(),
  useOrgSeats: vi.fn(),
  useOrgRealtime: vi.fn(),
  useMyOrgs: vi.fn(),
  leaveOrganization: vi.fn(),
  push: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  showBilling: true,
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ orgId: 'org_nw' }),
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock('@/hooks/useOrgs', () => ({
  useOrg: mocks.useOrg,
  useOrgHubCounts: mocks.useOrgHubCounts,
  useOrgSeats: mocks.useOrgSeats,
  useOrgRealtime: mocks.useOrgRealtime,
  useMyOrgs: mocks.useMyOrgs,
}));
vi.mock('@/hooks/useBillingVisibility', () => ({ useBillingVisibility: () => ({ showBilling: mocks.showBilling }) }));
vi.mock('@/lib/orgs/org-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orgs/org-api')>()),
  leaveOrganization: mocks.leaveOrganization,
}));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));

import OrgSettingsPage from '../page';

const org = (role: 'OWNER' | 'ADMIN' | 'MEMBER') => ({
  organization: { id: 'org_nw', name: 'Northwind Labs', slug: 'northwind', avatarUrl: null, ownerId: 'u_owner', createdAt: '2026-09-01T00:00:00Z' },
  viewer: { userId: 'u_me', role },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.showBilling = true;
  mocks.useOrgHubCounts.mockReturnValue({ members: 12, pendingInvites: 2, guests: 3, drives: 6, guestApprovals: 2, ownerLeftAutomations: 1 });
  mocks.useOrgSeats.mockReturnValue({ data: { seats: { members: 12, pendingInvites: 2, held: 14, included: 5, purchasedExtra: 10, purchased: 15, autoAdd: true, hasSubscription: true, currentPeriodEnd: '2026-10-01T00:00:00Z' } } });
  mocks.useMyOrgs.mockReturnValue({ mutate: vi.fn() });
});

describe('org settings hub', () => {
  it('UI-11 (partial): a plain Member sees only Leave — no org settings rows, no plan or seats', () => {
    mocks.useOrg.mockReturnValue({ org: org('MEMBER'), isLoading: false });
    render(<OrgSettingsPage />);
    expect(screen.getByRole('heading', { name: 'Organization Settings' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Leave Northwind Labs/ })).toBeTruthy();
    for (const title of ['Members & seats', 'Policies', 'Plan & seats', 'Audit log', 'Drives']) {
      expect(screen.queryByText(title)).toBeNull();
    }
    expect(screen.queryByText(/of 15 seats/)).toBeNull();
    expect(mocks.useOrgHubCounts).toHaveBeenCalledWith('org_nw', 'MEMBER');
  });

  it('UI-1 (partial): an Admin sees the canvas groups with counts, rows linking under /orgs/[orgId]/settings', () => {
    mocks.useOrg.mockReturnValue({ org: org('ADMIN'), isLoading: false });
    render(<OrgSettingsPage />);
    for (const group of ['Needs your attention', 'Organization', 'Controls', 'Billing', 'Data', 'Membership']) {
      expect(screen.getByRole('heading', { name: group })).toBeTruthy();
    }
    expect(screen.getByText('12 members, 2 pending invites, 3 guests')).toBeTruthy();
    expect(screen.getByText('2 waiting')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Policies/ }).getAttribute('href')).toBe('/orgs/org_nw/settings/policies');
    expect(screen.getByText(/Business plan · 12 of 15 seats/)).toBeTruthy();
    expect(screen.getByText(/Renews Oct 1/)).toBeTruthy();
  });

  it('SEAT-6 (partial): with billing hidden, no plan line and no Billing group', () => {
    mocks.showBilling = false;
    mocks.useOrg.mockReturnValue({ org: org('OWNER'), isLoading: false });
    render(<OrgSettingsPage />);
    expect(screen.queryByRole('heading', { name: 'Billing' })).toBeNull();
    expect(screen.queryByText(/Business plan/)).toBeNull();
    expect(mocks.useOrgSeats).toHaveBeenCalledWith('org_nw', 'OWNER', false);
  });

  it('UI-11 (partial): leaving asks first, then leaves and returns to the dashboard', async () => {
    mocks.useOrg.mockReturnValue({ org: org('MEMBER'), isLoading: false });
    mocks.leaveOrganization.mockResolvedValue({ left: true });
    render(<OrgSettingsPage />);
    await userEvent.click(screen.getByRole('button', { name: /Leave Northwind Labs/ }));
    const dialog = await screen.findByRole('alertdialog');
    expect(mocks.leaveOrganization).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(mocks.leaveOrganization).toHaveBeenCalledWith('org_nw'));
    expect(mocks.push).toHaveBeenCalledWith('/dashboard');
  });

  it('a refused leave shows the copy for its code, never the server message', async () => {
    mocks.useOrg.mockReturnValue({ org: org('MEMBER'), isLoading: false });
    mocks.leaveOrganization.mockRejectedValue(new ApiRequestError('raw', 409, { error: 'raw', code: 'owner_must_transfer' }));
    render(<OrgSettingsPage />);
    await userEvent.click(screen.getByRole('button', { name: /Leave Northwind Labs/ }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Transfer ownership to another member before you leave.'));
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('subscribes to org:changed for this org', () => {
    mocks.useOrg.mockReturnValue({ org: org('ADMIN'), isLoading: false });
    render(<OrgSettingsPage />);
    expect(mocks.useOrgRealtime).toHaveBeenCalledWith('org_nw');
  });

  it('an org the viewer is not in shows not found', () => {
    mocks.useOrg.mockReturnValue({ org: undefined, isLoading: false, error: new ApiRequestError('x', 404, { error: 'x', code: 'org_not_found' }) });
    render(<OrgSettingsPage />);
    expect(screen.getByText('This organization does not exist, or you are not a member of it.')).toBeTruthy();
  });
});
