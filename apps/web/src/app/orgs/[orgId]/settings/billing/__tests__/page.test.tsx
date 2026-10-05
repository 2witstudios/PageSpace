import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/auth/auth-fetch';

const mocks = vi.hoisted(() => ({
  role: 'OWNER' as 'OWNER' | 'ADMIN' | 'MEMBER',
  notice: undefined as undefined | Record<string, unknown>,
  seats: { data: undefined as unknown, error: undefined as unknown },
  reads: {} as Record<string, unknown>,
  setOrgSeatAutoAdd: vi.fn(),
  openOrgBillingPortal: vi.fn(),
  assign: vi.fn(),
  useOrgWalletRealtime: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useParams: () => ({ orgId: 'org_nw' }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('swr', async (importOriginal) => ({ ...(await importOriginal<typeof import('swr')>()), useSWRConfig: () => ({ mutate: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/useBillingVisibility', () => ({ useBillingVisibility: () => ({ showBilling: true }) }));
vi.mock('@/hooks/useOrgs', () => ({
  useOrg: () => ({
    org: { organization: { id: 'org_nw', name: 'Northwind Labs', slug: 'northwind', avatarUrl: null, ownerId: 'u_jono', createdAt: '' }, viewer: { userId: 'u_jono', role: mocks.role }, billingNotice: mocks.notice },
    isLoading: false,
    mutate: vi.fn(),
  }),
  useOrgRealtime: vi.fn(),
  useOrgWalletRealtime: mocks.useOrgWalletRealtime,
  useOrgSeats: () => mocks.seats,
  useOrgAdminRead: (key: string) => ({ data: mocks.reads[key] }),
}));
vi.mock('@/lib/orgs/org-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orgs/org-api')>()),
  setOrgSeatAutoAdd: mocks.setOrgSeatAutoAdd,
  openOrgBillingPortal: mocks.openOrgBillingPortal,
}));

import OrgBillingPage from '../page';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'OWNER';
  mocks.notice = undefined;
  mocks.seats = { data: { seats: { members: 12, pendingInvites: 2, held: 14, included: 5, purchasedExtra: 10, purchased: 15, autoAdd: true, hasSubscription: true, currentPeriodEnd: '2026-10-01T00:00:00Z' } }, error: undefined };
  mocks.reads = {
    '/api/orgs/org_nw/pool': {
      walletId: 'w_pool', availableCents: 4_500, unallocatedCents: 4_308, periodEnd: '2026-10-01T00:00:00Z',
      seats: { memberCount: 12, allowanceCents: 150, allocatedCents: 1_800, spentCents: 1_152 },
      driveWallets: [
        { driveId: 'd_eng', driveName: 'Engineering', walletId: 'w_e', allocationCents: 900, spentCents: 1_233, status: 'over' },
        { driveId: 'd_cr', driveName: 'Customer Research', walletId: 'w_c', allocationCents: 600, spentCents: 567, status: 'paused' },
        { driveId: 'd_prod', driveName: 'Product', walletId: 'w_p', allocationCents: 1_200, spentCents: 1_008, status: 'active' },
      ],
      drivesWithoutWallet: [{ id: 'd_ds', name: 'Design System' }, { id: 'd_fin', name: 'Finance' }],
    },
    '/api/orgs/org_nw/billing/invoices': { invoices: [{ id: 'in_1', number: 'NW-1', status: 'paid', amountDue: 14_667, amountPaid: 14_667, currency: 'usd', created: '2026-09-01T00:00:00Z', periodStart: null, periodEnd: null, hostedInvoiceUrl: null, invoicePdf: 'https://stripe.test/in_1.pdf' }], hasMore: false },
  };
  mocks.setOrgSeatAutoAdd.mockResolvedValue({ autoAdd: false });
  mocks.openOrgBillingPortal.mockResolvedValue({ url: 'https://billing.stripe.test/session' });
  Object.defineProperty(window, 'location', { value: { ...window.location, assign: mocks.assign }, writable: true });
});

describe('Plan & seats', () => {
  it('UI-7 (partial) SEAT-6 (partial): plan, price, seats and the pool split; dollars only for the price', () => {
    render(<OrgBillingPage />);
    expect(screen.getByText('Business plan')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('$150.00')).toBeTruthy();
    expect(screen.getByText('12 in use · 2 reserved by invites')).toBeTruthy();
    expect(screen.getByText('4,308 credits')).toBeTruthy();
    expect(screen.getByText('Allocated to seats · 12 × 150 credits a month · 1,152 credits spent')).toBeTruthy();
    expect(screen.getByText('Over')).toBeTruthy();
    expect(screen.getByText('Paused')).toBeTruthy();
    expect(screen.getByText('Design System, Finance · no wallet, seat allowances only')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'PDF' }).getAttribute('href')).toBe('https://stripe.test/in_1.pdf');
    expect(document.body.textContent).not.toMatch(/\$[\d,]+ credits/);
  });

  it('X-4 (partial): subscribes to wallet:changed for the drives whose wallets it shows', () => {
    render(<OrgBillingPage />);
    expect(mocks.useOrgWalletRealtime).toHaveBeenCalledWith('org_nw', ['d_eng', 'd_cr', 'd_prod']);
  });

  it('SEAT-4 (partial): the Owner turns automatic seats off', async () => {
    render(<OrgBillingPage />);
    await userEvent.click(screen.getByRole('switch', { name: 'Add seats automatically' }));
    await waitFor(() => expect(mocks.setOrgSeatAutoAdd).toHaveBeenCalledWith('org_nw', false));
  });

  it('an Admin sees the setting but only the Owner can change it', () => {
    mocks.role = 'ADMIN';
    render(<OrgBillingPage />);
    expect((screen.getByRole('switch', { name: 'Add seats automatically' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Only the Owner can change this/)).toBeTruthy();
  });

  it('the billing portal opens the org Stripe portal', async () => {
    render(<OrgBillingPage />);
    await userEvent.click(screen.getAllByRole('button', { name: 'Billing portal' })[0]);
    await waitFor(() => expect(mocks.assign).toHaveBeenCalledWith('https://billing.stripe.test/session'));
    expect(mocks.openOrgBillingPortal).toHaveBeenCalledWith('org_nw');
  });

  it('SEAT-9 (partial): a lapsed org shows Lapsed and the reactivate banner', () => {
    mocks.notice = { kind: 'reactivate', reason: 'canceled', canManageBilling: true };
    render(<OrgBillingPage />);
    expect(screen.getByText('Lapsed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reactivate' })).toBeTruthy();
  });

  it('billing off on this deployment says so', () => {
    mocks.seats = { data: undefined, error: new ApiRequestError('x', 404, { error: 'x', code: 'billing_unavailable' }) };
    render(<OrgBillingPage />);
    expect(screen.getByText('Billing is not available on this deployment.')).toBeTruthy();
  });

  it('UI-11 (partial): a plain Member sees no plan', () => {
    mocks.role = 'MEMBER';
    render(<OrgBillingPage />);
    expect(screen.queryByText('Business plan')).toBeNull();
  });
});
