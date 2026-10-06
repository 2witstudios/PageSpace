import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { MyWallets } from '@pagespace/lib/services/drive-wallet-service';

vi.mock('@pagespace/lib/organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const put = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => ({ ...(await importOriginal<object>()), put }));
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
    ],
  }),
}));
vi.mock('@/hooks/useMyOrganizations', () => ({ useMyOrganizations: () => ({ orgById: (id: string | null) => (id === 'o-northwind' ? { name: 'Northwind Labs' } : null) }) }));

import { UsageWallets } from '../UsageWallets';

const base: MyWallets = {
  personal: { walletId: 'w-me', remainingCents: 148_200, remainingCredits: '148,200', defaultSpendSource: null },
  driveWallets: [
    { driveId: 'd-product', driveName: 'Product', walletId: 'w-product', status: 'active', remainingCents: 19_200, remainingCredits: '19,200' },
    { driveId: 'd-research', driveName: 'Customer Research', walletId: 'w-research', status: 'paused', remainingCents: 3_300, remainingCredits: '3,300' },
    { driveId: 'd-side', driveName: 'Side project', walletId: 'w-side', status: 'active', remainingCents: 21_900, remainingCredits: '21,900' },
  ],
  seats: [{ orgId: 'o-northwind', orgName: 'Northwind Labs', walletId: 'w-pool', allowanceCents: 15_000, allowanceCredits: '15,000', spentCents: 9_600, spentCredits: '9,600', remainingCents: 5_400, remainingCredits: '5,400' }],
  funds: {
    driveWallets: [{ driveId: 'd-side', driveName: 'Side project', walletId: 'w-side', status: 'active', remainingCents: 21_900, remainingCredits: '21,900' }],
    pools: [],
    donations: [],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  state.wallets = base;
});

describe('Settings › Usage › Wallets', () => {
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
    expect(research).toContain('paused by whoever funds it, your calls move to the next source');
    expect(research).toContain('Paused');
  });

  it('UI-10 (partial) lists what I fund and offers to fund a drive I own that has no wallet yet', () => {
    render(<UsageWallets />);
    expect(screen.getByTestId('usage-fund-drive').textContent).toContain('Side project wallet');
    expect(screen.getByRole('button', { name: 'Fund a drive' })).toBeTruthy();
    expect(screen.queryByTestId('usage-fund-pool')).toBeNull();
  });

  it('SPEND-10 (partial) an org Owner or Admin also sees the pool they fund, with what is not yet allocated', () => {
    state.wallets = { ...base, funds: { ...base.funds, pools: [{ orgId: 'o-northwind', orgName: 'Northwind Labs', walletId: 'w-pool', availableCents: 900_017, unallocatedCents: 780_017, availableCredits: '900,017', unallocatedCredits: '780,017' }] } };
    render(<UsageWallets />);
    expect(screen.getByTestId('usage-fund-pool').textContent).toContain('780,017 credits not yet allocated to drives');
  });

  it('SPEND-3 (partial) my default is saved through the default route and preselects new conversations', async () => {
    render(<UsageWallets />);
    fireEvent.click(screen.getByRole('radio', { name: /Always my own credits/ }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/wallets/default', { source: 'own_credits' }));
    expect(state.refresh).toHaveBeenCalled();
  });

  it('UI-12 (partial) every amount is a credit count, never a dollar figure', () => {
    const { container } = render(<UsageWallets />);
    expect(container.textContent).not.toContain('$');
  });
});
