/**
 * The header credit chip for a claimed AI agent (ADR 0008 Decision 8, owner pays): its AI usage
 * bills its owner, so the chip shows the owner's balance (GET /api/credits resolves it) and says
 * "Billed to <owner>" — never an empty wallet with Upgrade / Buy credits a claimed agent cannot use.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CreditBalance as Balance } from '@/hooks/useCreditBalance';

const { state } = vi.hoisted(() => ({ state: { balance: null as Balance | null } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/hooks/useCreditBalance', () => ({
  useCreditBalance: () => ({ balance: state.balance, isLoading: false, isError: false, mutate: vi.fn() }),
}));
vi.mock('@/hooks/useBillingVisibility', () => ({ useBillingVisibility: () => ({ showPurchases: true }) }));
vi.mock('@/components/billing/BuyCreditsButton', () => ({ BuyCreditsButton: () => <span>Buy credits</span> }));
vi.mock('@/components/billing/UpgradeTierButton', () => ({ UpgradeTierButton: () => <span>Upgrade</span> }));

import { CreditBalance } from '../CreditBalance';

const base: Balance = {
  billingEnabled: true,
  monthly: { remaining: 900, allowance: 1000, periodEnd: null },
  topup: { remaining: 0 },
  debt: 0,
  spendable: 900,
  reserved: 0,
  subscriptionTier: 'pro',
};

describe('CreditBalance', () => {
  beforeEach(() => {
    state.balance = null;
  });

  it('given a claimed agent, should say whom its AI usage is billed to and offer no purchase or upgrade', () => {
    state.balance = { ...base, billedTo: { userId: 'owner-1', name: 'Dana Owner' } };
    render(<CreditBalance />);
    expect(screen.getByTestId('credit-billed-to').textContent).toBe('Billed to Dana Owner');
    expect(screen.queryByText('Buy credits')).toBeNull();
    expect(screen.queryByText('Upgrade')).toBeNull();
  });

  it('given a person, should keep the purchase and upgrade actions and name no payer', () => {
    state.balance = { ...base, billedTo: null };
    render(<CreditBalance />);
    expect(screen.queryByTestId('credit-billed-to')).toBeNull();
    expect(screen.getByText('Buy credits')).toBeTruthy();
    expect(screen.getByText('Upgrade')).toBeTruthy();
  });
});
