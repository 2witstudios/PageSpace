import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/auth/auth-fetch';

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  fetchDrives: vi.fn(),
  refreshMyOrgs: vi.fn(),
  createOrganization: vi.fn(),
  fetchDriveMemberEmails: vi.fn(),
  moveDriveIntoOrg: vi.fn(),
  inviteToOrg: vi.fn(),
  setOrgSeatAutoAdd: vi.fn(),
  startOrgSubscription: vi.fn(),
  orgFetcher: vi.fn(),
  billingEnabled: true,
  drives: [] as Array<Record<string, unknown>>,
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u_me', email: 'jono@northwind.com' } }) }));
vi.mock('@/hooks/useDrive', () => ({
  useDriveStore: (select: (s: { drives: unknown[]; fetchDrives: () => void }) => unknown) => select({ drives: mocks.drives, fetchDrives: mocks.fetchDrives }),
}));
vi.mock('@/hooks/useOrgs', () => ({ useMyOrgs: () => ({ mutate: mocks.refreshMyOrgs }) }));
vi.mock('@/lib/deployment-mode', () => ({ isBillingEnabled: () => mocks.billingEnabled }));
vi.mock('@/components/billing/StripeProvider', () => ({ StripeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../OrgPaymentForm', () => ({
  OrgPaymentForm: ({ submitLabel, onPaid }: { submitLabel: string; onPaid: () => void }) => (
    <button type="button" onClick={onPaid}>{submitLabel}</button>
  ),
}));
vi.mock('@/lib/orgs/org-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orgs/org-api')>()),
  createOrganization: mocks.createOrganization,
  fetchDriveMemberEmails: mocks.fetchDriveMemberEmails,
  moveDriveIntoOrg: mocks.moveDriveIntoOrg,
  inviteToOrg: mocks.inviteToOrg,
  setOrgSeatAutoAdd: mocks.setOrgSeatAutoAdd,
  startOrgSubscription: mocks.startOrgSubscription,
  orgFetcher: mocks.orgFetcher,
}));

import { CreateOrganizationDialog } from '../CreateOrganizationDialog';

const drive = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, slug: id, ownerId: 'u_me', isOwned: true, isTrashed: false, orgId: null, kind: 'STANDARD', ...extra });
const organization = { id: 'org_nw', name: 'Northwind Labs', slug: 'northwind-labs', avatarUrl: null, ownerId: 'u_me', createdAt: '2026-10-05T00:00:00Z' };
const sub = { status: 'incomplete', trialEnd: null, currentPeriodEnd: null, extraSeatQuantity: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.billingEnabled = true;
  mocks.drives = [drive('d_product', 'Product'), drive('d_home', 'Home', { kind: 'HOME' }), drive('d_shared', 'Shared', { isOwned: false }), drive('d_org', 'Already org', { orgId: 'org_x' })];
  mocks.fetchDriveMemberEmails.mockResolvedValue(['jono@northwind.com', 'priya@northwind.com', 'dana@northwind.com']);
  mocks.moveDriveIntoOrg.mockResolvedValue({ drive: { id: 'd_product' } });
  mocks.inviteToOrg.mockResolvedValue({ invitation: {} });
  mocks.orgFetcher.mockResolvedValue({ organization, viewer: { userId: 'u_me', role: 'OWNER' } });
});

const fillName = async () => userEvent.type(screen.getByLabelText('Name'), 'Northwind Labs');

describe('CreateOrganizationDialog', () => {
  it('UI-6 (partial): lists only personal drives I own; Home is shown but stays personal', () => {
    render(<CreateOrganizationDialog open onOpenChange={vi.fn()} />);
    expect(screen.getByLabelText('Move Product')).toBeTruthy();
    expect((screen.getByLabelText('Move Home') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('stays personal')).toBeTruthy();
    expect(screen.queryByText('Shared')).toBeNull();
    expect(screen.queryByText('Already org')).toBeNull();
  });

  it('UI-6 (partial): previews the URL slug from the name', async () => {
    render(<CreateOrganizationDialog open onOpenChange={vi.fn()} />);
    await fillName();
    expect((screen.getByLabelText('URL name') as HTMLInputElement).value).toBe('northwind-labs');
  });

  it('UI-6 (partial): moving a drive adds its people to the invite list, and the plan summary counts their seats', async () => {
    render(<CreateOrganizationDialog open onOpenChange={vi.fn()} />);
    await userEvent.click(screen.getByLabelText('Move Product'));
    await waitFor(() => expect((screen.getByLabelText('Invite people') as HTMLTextAreaElement).value).toBe('priya@northwind.com, dana@northwind.com'));
    expect(screen.getByText('3 members')).toBeTruthy();
    expect(screen.getByText(/You and 2 people make 3 seats/)).toBeTruthy();
    expect(screen.queryByText(/trial/i)).toBeNull();
  });

  it('UI-6 (partial): Continue creates the org and opens the Payment Element step with what is due', async () => {
    mocks.createOrganization.mockResolvedValue({ organization, billing: { state: 'payment_required', subscription: sub, payment: { kind: 'confirm_payment', clientSecret: 'cs_test_1' } } });
    render(<CreateOrganizationDialog open onOpenChange={vi.fn()} />);
    await fillName();
    await userEvent.click(screen.getByRole('button', { name: 'Continue to payment' }));
    expect(mocks.createOrganization).toHaveBeenCalledWith({ name: 'Northwind Labs', slug: 'northwind-labs' });
    expect(await screen.findByText('Pay for Northwind Labs')).toBeTruthy();
    expect(screen.getByText('Due today, then monthly')).toBeTruthy();
    expect(screen.getAllByText('$50.00').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Pay $50.00 and create' })).toBeTruthy();
  });

  it('UI-6 (partial): once paid it waits for the org to activate, then moves drives, turns on automatic seats and invites', async () => {
    mocks.createOrganization.mockResolvedValue({ organization, billing: { state: 'payment_required', subscription: sub, payment: { kind: 'confirm_payment', clientSecret: 'cs_test_1' } } });
    mocks.orgFetcher
      .mockResolvedValueOnce({ organization, viewer: { userId: 'u_me', role: 'OWNER' }, billingNotice: { kind: 'reactivate', reason: 'incomplete', canManageBilling: true } })
      .mockResolvedValue({ organization, viewer: { userId: 'u_me', role: 'OWNER' } });
    const onOpenChange = vi.fn();
    render(<CreateOrganizationDialog open onOpenChange={onOpenChange} />);
    await fillName();
    await userEvent.click(screen.getByLabelText('Move Product'));
    await waitFor(() => expect((screen.getByLabelText('Invite people') as HTMLTextAreaElement).value).toContain('dana'));
    await userEvent.type(screen.getByLabelText('Invite people'), ', a@x.io, b@x.io, c@x.io');
    await userEvent.click(screen.getByRole('button', { name: 'Continue to payment' }));
    await userEvent.click(await screen.findByRole('button', { name: /^Pay / }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/orgs/org_nw/settings'), { timeout: 5000 });
    expect(mocks.orgFetcher).toHaveBeenCalledTimes(2);
    expect(mocks.moveDriveIntoOrg).toHaveBeenCalledWith('d_product', 'org_nw');
    expect(mocks.setOrgSeatAutoAdd).toHaveBeenCalledWith('org_nw', true);
    expect(mocks.inviteToOrg.mock.calls.map((c) => c[1].email)).toEqual(['priya@northwind.com', 'dana@northwind.com', 'a@x.io', 'b@x.io', 'c@x.io']);
    expect(mocks.setOrgSeatAutoAdd.mock.invocationCallOrder[0]).toBeLessThan(mocks.inviteToOrg.mock.invocationCallOrder[0]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  }, 10_000);

  it('a taken URL shows the copy for slug_taken and stays on the form', async () => {
    mocks.createOrganization.mockRejectedValue(new ApiRequestError('raw', 409, { error: 'raw', code: 'slug_taken' }));
    render(<CreateOrganizationDialog open onOpenChange={vi.fn()} />);
    await fillName();
    await userEvent.click(screen.getByRole('button', { name: 'Continue to payment' }));
    expect(await screen.findByText('That organization URL is already taken. Choose another.')).toBeTruthy();
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });

  it('refuses entries that are not email addresses before creating anything', async () => {
    render(<CreateOrganizationDialog open onOpenChange={vi.fn()} />);
    await fillName();
    await userEvent.type(screen.getByLabelText('Invite people'), 'priya, ok@x.io');
    await userEvent.click(screen.getByRole('button', { name: 'Continue to payment' }));
    expect(await screen.findByText('These are not email addresses: priya')).toBeTruthy();
    expect(mocks.createOrganization).not.toHaveBeenCalled();
  });

  it('without billing (onprem) it creates and sets up with no payment step', async () => {
    mocks.billingEnabled = false;
    mocks.createOrganization.mockResolvedValue({ organization, billing: { state: 'not_billed' } });
    render(<CreateOrganizationDialog open onOpenChange={vi.fn()} />);
    await fillName();
    expect(screen.queryByText(/a month/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Create organization' }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith('/orgs/org_nw/settings'));
  });

  it('a setup step that fails is listed with its copy instead of being dropped', async () => {
    mocks.billingEnabled = false;
    mocks.createOrganization.mockResolvedValue({ organization, billing: { state: 'not_billed' } });
    mocks.inviteToOrg.mockRejectedValue(new ApiRequestError('raw', 402, { error: 'raw', code: 'seats_full' }));
    render(<CreateOrganizationDialog open onOpenChange={vi.fn()} />);
    await fillName();
    await userEvent.type(screen.getByLabelText('Invite people'), 'ok@x.io');
    await userEvent.click(screen.getByRole('button', { name: 'Create organization' }));
    expect(await screen.findByText(/Inviting ok@x.io: Every seat is in use/)).toBeTruthy();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('an unreachable payment provider offers to try the subscription again', async () => {
    mocks.createOrganization.mockResolvedValue({ organization, billing: { state: 'pending' } });
    mocks.startOrgSubscription.mockResolvedValue({ subscription: sub, payment: { kind: 'confirm_payment', clientSecret: 'cs_2' } });
    render(<CreateOrganizationDialog open onOpenChange={vi.fn()} />);
    await fillName();
    await userEvent.click(screen.getByRole('button', { name: 'Continue to payment' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(mocks.startOrgSubscription).toHaveBeenCalledWith('org_nw');
    expect(await screen.findByText('Pay for Northwind Labs')).toBeTruthy();
  });
});
