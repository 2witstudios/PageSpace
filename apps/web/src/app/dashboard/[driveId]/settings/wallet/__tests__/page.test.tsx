/**
 * Drive Settings › Wallet per viewer, from the REAL projection (lib wallet-views) and the REAL
 * action list (lib wallet-access): what a member, a guest, an org drive's lead and an org admin
 * each get. The leaf's "member view never renders pool or others' spend" is asserted against
 * the rendered page, with distinctive amounts searched for in the DOM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { projectDriveWallet, type DriveWalletFacts } from '@pagespace/lib/billing/wallet-views';
import { walletActionsFor, type WalletViewer } from '@pagespace/lib/permissions/wallet-access';

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ driveId: 'd-product' }),
  useRouter: () => ({ push: vi.fn() }),
  notFound: () => {
    throw new Error('notFound');
  },
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const api = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  patch: vi.fn(async () => ({})),
  post: vi.fn(async () => ({})),
  put: vi.fn(async () => ({})),
  del: vi.fn(async () => ({})),
}));
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }));

const walletState = vi.hoisted(() => ({ read: null as unknown, refresh: vi.fn(async () => undefined) }));
vi.mock('@/hooks/useDriveWallet', () => ({
  useDriveWallet: () => ({ read: walletState.read, isLoading: false, refresh: walletState.refresh }),
}));
vi.mock('@/hooks/useDrive', () => ({
  useDriveStore: (select: (s: unknown) => unknown) =>
    select({ drives: [{ id: 'd-product', name: 'Product', orgId: 'o-northwind' }], fetchDrives: vi.fn() }),
}));
vi.mock('@/hooks/useMyOrganizations', () => ({
  useMyOrganizations: () => ({ orgById: (id: string | null) => (id === 'o-northwind' ? { id, name: 'Northwind Labs' } : null) }),
}));
vi.mock('@/hooks/useDriveMemberNames', () => ({
  useDriveMemberNames: () => ({ 'u-priya': 'Priya Nair', 'u-marcus': 'Marcus Oyelaran' }),
}));

import DriveWalletSettingsPage from '../page';

const POOL_CENTS = 900_017;
const PRIYA_SPEND = 64_513;

const facts: DriveWalletFacts = {
  wallet: {
    id: 'w-product',
    driveId: 'd-product',
    status: 'active',
    monthlyAllowanceCents: 120_000,
    spentCents: 100_800,
    topupRemainingCents: 0,
    debtCents: 0,
    monthlyPeriodStart: new Date('2026-09-01T00:00:00Z'),
    monthlyPeriodEnd: new Date('2026-10-01T00:00:00Z'),
    fallbackRule: 'seat_allowance',
    donationsEnabled: true,
    defaultSpendSource: 'drive_wallet',
    overshootChoice: null,
  },
  myCap: { dailyCapCents: 2_000, monthlyCapCents: null, spentTodayCents: 500, spentThisMonthCents: 500 },
  spendByConsumer: [{ consumerKey: 'user:u-priya', userId: 'u-priya', displayName: 'Priya Nair', spentCents: PRIYA_SPEND }],
  pool: { walletId: 'w-pool', availableCents: POOL_CENTS, outstandingChildAllocationsCents: 120_000 },
};

const viewAs = (viewer: Exclude<WalletViewer, 'none'>, over: Partial<DriveWalletFacts['wallet']> = {}) => {
  walletState.read = {
    viewer,
    actions: walletActionsFor(viewer, { orgDrive: true }),
    wallet: projectDriveWallet(viewer, { ...facts, wallet: { ...facts.wallet, ...over } }),
  };
};

const capsBody = { walletId: 'w-product', caps: [{ userId: 'u-priya', displayName: 'Priya Nair', dailyCapCents: 5_000, monthlyCapCents: 100_000, dailyCapCredits: '5,000', monthlyCapCredits: '100,000' }] };

const renderPage = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DriveWalletSettingsPage />
    </SWRConfig>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => capsBody });
});

describe('Drive Settings › Wallet', () => {
  it('UI-9 (partial) SPEND-9 (partial) a MEMBER sees the remaining amount, their own cap and donate — never the pool, the allocation or anyone\'s spend', () => {
    viewAs('member');
    const { container } = renderPage();
    expect(screen.getByText('19,200')).toBeTruthy();
    expect(screen.getByTestId('wallet-my-cap').textContent).toBe('Your cap here: 1,500 credits left today');
    expect(screen.getByTestId('wallet-donate-card')).toBeTruthy();
    for (const id of ['wallet-rules-card', 'wallet-caps-card', 'wallet-spend-card', 'wallet-pool-line']) expect(screen.queryByTestId(id)).toBeNull();
    const html = container.innerHTML;
    for (const secret of ['900,017', '64,513', 'Priya Nair', '120,000']) expect(html).not.toContain(secret);
    expect(screen.queryByRole('switch', { name: 'Pause spending' })).toBeNull();
  });

  it('SPEND-9 (partial) a GUEST gets the same consumer page', () => {
    viewAs('guest');
    const { container } = renderPage();
    expect(screen.queryByTestId('wallet-spend-card')).toBeNull();
    expect(container.innerHTML).not.toContain('900,017');
  });

  it('SPEND-10 (partial) WAL-7 (partial) an org drive\'s LEAD runs the wallet and sees spend by member and caps read-only, but moves no pool money', async () => {
    viewAs('lead');
    renderPage();
    expect(screen.getByTestId('wallet-spend-card').textContent).toContain('Priya Nair');
    expect(screen.getByTestId('wallet-spend-card').textContent).toContain('64,513 credits');
    expect(screen.getByRole('switch', { name: 'Pause spending' })).toBeTruthy();
    expect(screen.queryByText('One-off top-up')).toBeNull();
    expect(screen.queryByTestId('wallet-pool-line')).toBeNull();
    const caps = await screen.findByTestId('wallet-caps-card');
    await waitFor(() => expect(within(caps).getByText('5,000 credits')).toBeTruthy());
    expect(within(caps).queryByRole('button', { name: /Edit|Set cap/ })).toBeNull();
  });

  it('SPEND-10 (partial) an ORG ADMIN gets the pool, allocation, top-up and editable caps', async () => {
    viewAs('org_admin');
    renderPage();
    expect(screen.getByTestId('wallet-pool-line').textContent).toBe('Org pool: 900,017 credits available · 780,017 not yet allocated');
    expect(screen.getByText('One-off top-up')).toBeTruthy();
    expect(screen.getByLabelText('Monthly allocation')).toBeTruthy();
    expect(screen.getByTestId('wallet-status-legend')).toBeTruthy();
    const caps = await screen.findByTestId('wallet-caps-card');
    await waitFor(() => expect(within(caps).getAllByRole('button', { name: /Edit|Set cap/ }).length).toBe(2));
  });

  it('WAL-7 (partial) the pause switch pauses the wallet (the kill switch) and the status reads Paused', async () => {
    viewAs('lead');
    const { unmount } = renderPage();
    fireEvent.click(screen.getByRole('switch', { name: 'Pause spending' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/api/drives/d-product/wallet', { paused: true }));
    unmount();
    viewAs('lead', { status: 'paused' });
    renderPage();
    expect(screen.getByRole('switch', { name: 'Pause spending' }).getAttribute('aria-checked')).toBe('true');
    // The card's status badge, plus the legend under the switch that names all three states.
    expect(screen.getAllByText('Paused')).toHaveLength(2);
    expect(screen.getByTestId('wallet-status-legend').textContent).toContain('stopped by whoever funds it');
  });

  it('WAL-7 (partial) an over wallet shows the over state and what calls do', () => {
    viewAs('member', { debtCents: 300, spentCents: 120_000 });
    renderPage();
    expect(screen.getByText('Over')).toBeTruthy();
    expect(screen.getByText("This month's allocation is spent. Calls follow the fallback rule.")).toBeTruthy();
  });

  it('WAL-7 (partial) turning a cap on with no values sends no amounts, so the defaults (50 a day, 1,000 a month) apply; "No cap" sends null', async () => {
    viewAs('org_admin');
    renderPage();
    const caps = await screen.findByTestId('wallet-caps-card');
    fireEvent.click(await within(caps).findByRole('button', { name: 'Set cap' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/drives/d-product/wallet/caps/u-marcus', {}));

    fireEvent.click(within(caps).getByRole('button', { name: 'Edit' }));
    const [noDaily] = await screen.findAllByRole('checkbox');
    fireEvent.click(noDaily);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith('/api/drives/d-product/wallet/caps/u-priya', { dailyCapCents: null, monthlyCapCents: 100_000 }));
  });

  it('UI-12 (partial) the page shows credit counts and never a dollar sign', () => {
    viewAs('org_admin');
    const { container } = renderPage();
    expect(container.textContent).not.toContain('$');
  });
});
