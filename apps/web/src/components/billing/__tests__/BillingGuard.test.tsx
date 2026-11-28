import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BillingVisibility } from '@/hooks/useBillingVisibility';

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  visibility: { showBilling: true, hideBilling: false, isReady: true, channel: 'stripe', showPurchases: true } as BillingVisibility,
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('@/hooks/useBillingVisibility', () => ({ useBillingVisibility: () => mocks.visibility }));

import { BillingGuard } from '../BillingGuard';

const APPLE: BillingVisibility = { showBilling: false, hideBilling: true, isReady: true, channel: 'apple', showPurchases: true };
const OLD_IOS: BillingVisibility = { showBilling: false, hideBilling: true, isReady: true, channel: 'none', showPurchases: false };
const WEB: BillingVisibility = { showBilling: true, hideBilling: false, isReady: true, channel: 'stripe', showPurchases: true };

describe('BillingGuard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('on the Apple channel, renders the plan (purchases) surface', () => {
    mocks.visibility = APPLE;
    render(<BillingGuard surface="purchases"><p>plan</p></BillingGuard>);
    expect(screen.getByText('plan')).toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('on the Apple channel, still redirects away from the Stripe billing surface', () => {
    mocks.visibility = APPLE;
    render(<BillingGuard><p>billing</p></BillingGuard>);
    expect(screen.queryByText('billing')).not.toBeInTheDocument();
    expect(mocks.replace).toHaveBeenCalledWith('/settings');
  });

  it('on an iOS binary without StoreKit, redirects away from both surfaces', () => {
    mocks.visibility = OLD_IOS;
    render(<BillingGuard surface="purchases"><p>plan</p></BillingGuard>);
    expect(screen.queryByText('plan')).not.toBeInTheDocument();
    expect(mocks.replace).toHaveBeenCalledWith('/settings');
  });

  it('on the web, renders both surfaces', () => {
    mocks.visibility = WEB;
    render(<><BillingGuard><p>billing</p></BillingGuard><BillingGuard surface="purchases"><p>plan</p></BillingGuard></>);
    expect(screen.getByText('billing')).toBeInTheDocument();
    expect(screen.getByText('plan')).toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('renders nothing and does not redirect while detection is pending', () => {
    mocks.visibility = { showBilling: false, hideBilling: false, isReady: false, channel: 'none', showPurchases: false };
    render(<BillingGuard surface="purchases"><p>plan</p></BillingGuard>);
    expect(screen.queryByText('plan')).not.toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
