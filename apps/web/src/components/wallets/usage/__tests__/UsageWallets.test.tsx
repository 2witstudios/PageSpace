import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { MyWallets } from '@pagespace/lib/services/drive-wallet-service';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const put = vi.hoisted(() => vi.fn(async () => ({})));
const fetchWithAuth = vi.hoisted(() => vi.fn(async () => ({ ok: true, json: async () => ({ alwaysOwnCredits: false, alwaysOwnCreditsInDrive: null }) })));
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => ({ ...(await importOriginal<object>()), put, fetchWithAuth }));
const state = vi.hoisted(() => ({ wallets: null as MyWallets | null, refresh: vi.fn(async () => undefined) }));
vi.mock('@/hooks/useMyWallets', () => ({ useMyWallets: () => ({ wallets: state.wallets, isLoading: false, refresh: state.refresh }) }));
vi.mock('@/hooks/useCreditBalance', () => ({ useCreditBalance: () => ({ balance: { monthly: { allowance: 90_000, periodEnd: '2026-10-01T00:00:00Z' } } }) }));
vi.mock('@/hooks/useDrive', () => ({
  useDriveStore: (select: (s: unknown) => unknown) => select({
    drives: [
      { id: 'd-product', name: 'Product', orgId: 'o-northwind', isOwned: false, isTrashed: false },
      { id: 'd-research', name: 'Customer Research', orgId: 'o-northwind', isOwned: false, isTrashed: false },
      { id: 'd-side', name: 'Side project', orgId: null, isOwned: true, isTrashed: false },
      { id: 'd-reading', name: 'Reading', orgId: null, isOwned: true, isTrashed: false },
      { id: 'd-home', name: 'Home', kind: 'HOME', orgId: null, isOwned: true, isTrashed: false },
    ],
  }),
}));
vi.mock('@/hooks/useMyOrganizations', () => ({ useMyOrganizations: () => ({ orgById: (id: string | null) => (id === 'o-northwind' ? { name: 'Northwind Labs' } : null) }) }));

import { UsageWallets } from '../UsageWallets';

const base: MyWallets = {
  personal: { walletId: 'w-me', remainingCents: 148_200, remainingCredits: '148,200', defaultSpendSource: null },
  driveWallets: [
    { driveId: 'd-product', driveName: 'Product', walletId: 'w-product', status: 'active', remainingCents: 19_200, remainingCredits: '19,200', mySpentCents: 4_250, mySpentCredits: '4,250' },
    { driveId: 'd-research', driveName: 'Customer Research', walletId: 'w-research', status: 'paused', remainingCents: 3_300, remainingCredits: '3,300', mySpentCents: 0, mySpentCredits: '0' },
    { driveId: 'd-side', driveName: 'Side project', walletId: 'w-side', status: 'active', remainingCents: 21_900, remainingCredits: '21,900', mySpentCents: 300, mySpentCredits: '300' },
  ],
  seats: [{ orgId: 'o-northwind', orgName: 'Northwind Labs', walletId: 'w-pool', allowanceCents: 15_000, allowanceCredits: '15,000', spentCents: 9_600, spentCredits: '9,600', remainingCents: 5_400, remainingCredits: '5,400' }],
  funds: {
    driveWallets: [{ driveId: 'd-side', driveName: 'Side project', walletId: 'w-side', status: 'active', remainingCents: 21_900, remainingCredits: '21,900', mySpentCents: 300, mySpentCredits: '300' }],
    pools: [],
    donations: [],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  state.wallets = base;
});

describe('Settings › Usage › Wallets', () => {
  it('UI-10 everything I spend from (with what I spent from each drive wallet), everything I fund, and my default, set from this page', async () => {
    state.wallets = { ...base, funds: { ...base.funds, pools: [{ orgId: 'o-northwind', orgName: 'Northwind Labs', walletId: 'w-pool', availableCents: 90_000, unallocatedCents: 12_000, availableCredits: '90,000', unallocatedCredits: '12,000' }] } };
    render(<UsageWallets />);
    // Spend from: my credits, my seat, every drive wallet, each with "you spent N".
    expect(screen.getByTestId('usage-wallet-personal').textContent).toContain('148,200 credits');
    expect(screen.getByTestId('usage-wallet-seat').textContent).toContain('5,400 credits left');
    const drives = screen.getAllByTestId('usage-wallet-drive').map((row) => row.textContent ?? '');
    expect(drives).toHaveLength(3);
    expect(drives[0]).toContain('Product wallet');
    expect(drives[0]).toContain('You spent 4,250 credits this month');
    expect(drives[1]).toContain('You spent 0 credits this month');
    // Fund: the drive wallet my credits parent, the pool I administer.
    expect(screen.getByTestId('usage-fund-drive').textContent).toContain('Side project wallet');
    expect(screen.getByTestId('usage-fund-pool').textContent).toContain('90,000 credits');
    // Default: choosing one PUTs the default route and the choice is marked once saved.
    const own = screen.getByRole('radio', { name: /My own credits/ });
    expect(own.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(own);
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/wallets/default', { source: 'own_credits' }));
    expect(state.refresh).toHaveBeenCalled();
    state.wallets = { ...state.wallets, personal: { ...state.wallets.personal, defaultSpendSource: 'own_credits' } };
    render(<UsageWallets />);
    expect(screen.getAllByRole('radio', { name: /My own credits/ }).at(-1)?.getAttribute('aria-checked')).toBe('true');
  });

  it('UI-10 (partial) lists what I spend from: my credits, my seat (my own allowance, never the pool), and drive wallets with a paused one saying so', () => {
    render(<UsageWallets />);
    expect(screen.getByTestId('usage-wallet-personal').textContent).toContain('148,200 credits');
    const seat = screen.getByTestId('usage-wallet-seat').textContent ?? '';
    expect(seat).toContain('Seat allowance · Northwind Labs');
    expect(seat).toContain('15,000 credits a month inside org drives · 9,600 credits spent');
    expect(seat).toContain('5,400 credits left');
    const [product, research, side] = screen.getAllByTestId('usage-wallet-drive').map((r) => r.textContent ?? '');
    expect(side).toContain('From your credits');
    expect(product).toContain('Product wallet');
    expect(research).toContain('paused by whoever funds it, your calls follow the drive\'s fallback rule');
    expect(research).toContain('Paused');
  });

  it('UI-10 (partial) lists what I fund and offers to fund a drive I own that has no wallet yet', () => {
    render(<UsageWallets />);
    expect(screen.getByTestId('usage-fund-drive').textContent).toContain('Side project wallet');
    expect(screen.getByRole('button', { name: 'Fund a drive' })).toBeTruthy();
    expect(screen.queryByTestId('usage-fund-pool')).toBeNull();
  });

  it('never offers to fund Home: what I spend there is already my own credits', async () => {
    render(<UsageWallets />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Fund a drive' }), { key: 'Enter' });
    expect(await screen.findByRole('menuitem', { name: 'Reading' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Home' })).toBeNull();
  });

  it('SPEND-10 (partial) an org Owner or Admin also sees the pool they fund, with what is not yet allocated', () => {
    state.wallets = { ...base, funds: { ...base.funds, pools: [{ orgId: 'o-northwind', orgName: 'Northwind Labs', walletId: 'w-pool', availableCents: 900_017, unallocatedCents: 780_017, availableCredits: '900,017', unallocatedCredits: '780,017' }] } };
    render(<UsageWallets />);
    expect(screen.getByTestId('usage-fund-pool').textContent).toContain('780,017 credits not yet allocated to drives');
  });

  it('SPEND-3 (partial) my default is saved through the default route and preselects new conversations', async () => {
    render(<UsageWallets />);
    fireEvent.click(screen.getByRole('radio', { name: /My own credits/ }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/wallets/default', { source: 'own_credits' }));
    expect(state.refresh).toHaveBeenCalled();
  });

  it('SPEND-3 (partial) with no default set, "The drive\'s wallet, if it has one" shows as selected (the out-of-box default) and promises only what the gate does', () => {
    render(<UsageWallets />);
    expect(screen.getByRole('radio', { name: /The drive's wallet, if it has one/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /My own credits/ }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(/Where there isn't one you can spend, your own credits/)).toBeTruthy();
    expect(screen.queryByText(/Then your allowance/)).toBeNull();
  });

  it('SPEND-3 (partial) a saved own-credits default shows as selected', () => {
    state.wallets = { ...base, personal: { ...base.personal, defaultSpendSource: 'own_credits' } };
    render(<UsageWallets />);
    expect(screen.getByRole('radio', { name: /My own credits/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /The drive's wallet, if it has one/ }).getAttribute('aria-checked')).toBe('false');
  });

  it('JOURNEYS-1 the ABSOLUTE switches are their own controls — global and per-drive, on the always-own-credits route, never conflated with the editable default', async () => {
    render(<UsageWallets />);
    // The card reads the switches for the picked drive.
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/api/wallets/always-own-credits?driveId=d-product'));
    // The default radio may only promise a preselection; "always" lives in the absolute card.
    expect(screen.getByRole('radio', { name: /My own credits/ }).textContent).toContain('A conversation can still switch to a wallet');
    expect(screen.getByText('Always my own credits')).toBeTruthy();

    fireEvent.click(screen.getByTestId('always-own-credits-global'));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/wallets/always-own-credits', { driveId: null, enabled: true }));
    fireEvent.click(screen.getByTestId('always-own-credits-drive'));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/wallets/always-own-credits', { driveId: 'd-product', enabled: true }));
    expect(state.refresh).toHaveBeenCalled();
  });

  it('UI-12 (partial) every amount is a credit count, never a dollar figure', () => {
    const { container } = render(<UsageWallets />);
    expect(container.textContent).not.toContain('$');
  });
});
