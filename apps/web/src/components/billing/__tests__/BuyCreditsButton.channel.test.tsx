import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  channel: 'apple' as 'apple' | 'stripe' | 'none',
  post: vi.fn(),
  purchase: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }), usePathname: () => '/dashboard' }));
vi.mock('@/hooks/useBillingVisibility', () => ({
  useBillingVisibility: () => ({
    channel: mocks.channel,
    showBilling: mocks.channel === 'stripe',
    showPurchases: mocks.channel !== 'none',
    hideBilling: mocks.channel !== 'stripe',
    isReady: true,
  }),
}));
vi.mock('@/hooks/useCreditBalance', () => ({ useCreditBalance: () => ({ balance: { subscriptionTier: 'pro' } }) }));
vi.mock('@/lib/auth/auth-fetch', () => ({ post: mocks.post }));
vi.mock('@/lib/iap/apple-store', () => ({ purchaseAppleProduct: mocks.purchase }));
vi.mock('@/hooks/useAppleProducts', () => ({
  useAppleProducts: () => ({
    isLoading: false,
    isError: false,
    products: [],
    pro: undefined,
    creditPacks: [
      { kind: 'consumable', productId: 'ai.pagespace.ios.credits.100', credits: 100, displayPrice: '11,99 €', displayName: '100 Credits' },
      { kind: 'consumable', productId: 'ai.pagespace.ios.credits.250', credits: 250, displayPrice: '29,99 €', displayName: '250 Credits' },
      { kind: 'consumable', productId: 'ai.pagespace.ios.credits.500', credits: 500, displayPrice: '58,99 €', displayName: '500 Credits' },
    ],
  }),
}));

import { BuyCreditsButton } from '../BuyCreditsButton';

describe('BuyCreditsButton by billing channel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('on the Apple channel, offers the three App Store packs at localized prices, with no custom amount', async () => {
    mocks.channel = 'apple';
    render(<BuyCreditsButton />);
    await userEvent.click(screen.getByRole('button', { name: /Buy credits/ }));

    expect(await screen.findByText('11,99 €')).toBeInTheDocument();
    expect(screen.getByText('29,99 €')).toBeInTheDocument();
    expect(screen.getByText('58,99 €')).toBeInTheDocument();
    expect(screen.queryByText(/custom amount/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('on the Apple channel, buys through In-App Purchase and never calls Stripe', async () => {
    mocks.channel = 'apple';
    mocks.purchase.mockResolvedValue({ status: 'success', subscriptionTier: 'pro', kind: 'consumable' });
    render(<BuyCreditsButton />);
    await userEvent.click(screen.getByRole('button', { name: /Buy credits/ }));
    await userEvent.click(await screen.findByText('29,99 €'));

    await waitFor(() => expect(mocks.purchase).toHaveBeenCalledWith('ai.pagespace.ios.credits.250'));
    await waitFor(() => expect(screen.getByText('Credits added.')).toBeInTheDocument());
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('on the Stripe channel, keeps the Stripe packs and the custom amount', async () => {
    mocks.channel = 'stripe';
    render(<BuyCreditsButton />);
    await userEvent.click(screen.getByRole('button', { name: /Buy credits/ }));
    expect(await screen.findByText(/custom amount/i)).toBeInTheDocument();
  });

  it('where nothing may be sold, renders nothing', () => {
    mocks.channel = 'none';
    const { container } = render(<BuyCreditsButton />);
    expect(container).toBeEmptyDOMElement();
  });
});
