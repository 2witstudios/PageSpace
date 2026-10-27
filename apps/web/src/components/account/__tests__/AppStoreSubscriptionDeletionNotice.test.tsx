import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SWRConfig } from 'swr';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  channel: 'apple' as 'apple' | 'stripe' | 'none',
  fetchWithAuth: vi.fn(),
  manage: vi.fn(),
}));

vi.mock('@/hooks/useBillingVisibility', () => ({ useBillingVisibility: () => ({ channel: mocks.channel, isReady: true }) }));
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: mocks.fetchWithAuth }));
vi.mock('@/lib/iap/apple-store', () => ({ manageAppleSubscriptions: mocks.manage }));

import { AppStoreSubscriptionDeletionNotice } from '../AppStoreSubscriptionDeletionNotice';

const renderFresh = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <AppStoreSubscriptionDeletionNotice />
    </SWRConfig>,
  );

function status(billingProvider: string | null, appStoreRenews = billingProvider === 'apple') {
  mocks.fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ subscriptionTier: 'pro', billingProvider, appStoreRenews }) });
}

describe('AppStoreSubscriptionDeletionNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.channel = 'apple';
    mocks.manage.mockResolvedValue(undefined);
  });

  it('on iOS for an App Store subscriber, warns that deletion does not cancel it and opens Manage Subscriptions', async () => {
    status('apple');
    renderFresh();
    await waitFor(() => expect(screen.getByTestId('app-store-deletion-notice')).toBeInTheDocument());
    expect(screen.getByText(/does not cancel your App Store subscription/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Manage Subscription' }));
    await waitFor(() => expect(mocks.manage).toHaveBeenCalledTimes(1));
  });

  it('warns anyway when the status cannot be read: unknown is never taken as no subscription', async () => {
    mocks.channel = 'stripe';
    mocks.fetchWithAuth.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    renderFresh();
    await waitFor(() => expect(screen.getByTestId('app-store-deletion-notice')).toBeInTheDocument());
  });

  it('renders nothing for a Stripe subscriber', async () => {
    status('stripe');
    renderFresh();
    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalled());
    expect(screen.queryByTestId('app-store-deletion-notice')).not.toBeInTheDocument();
  });

  it('in a browser, still warns an App Store subscriber and says where to cancel (no Apple sheet there)', async () => {
    mocks.channel = 'stripe';
    status('apple');
    renderFresh();
    await waitFor(() => expect(screen.getByTestId('app-store-deletion-notice')).toBeInTheDocument());
    expect(screen.getByText(/Settings › Apple ID › Subscriptions/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manage Subscription' })).not.toBeInTheDocument();
  });

  it('warns a Stripe subscriber who also has an App Store subscription Apple will still charge (e.g. in billing retry)', async () => {
    mocks.channel = 'stripe';
    status('stripe', true);
    renderFresh();
    await waitFor(() => expect(screen.getByTestId('app-store-deletion-notice')).toBeInTheDocument());
  });

  it('on an iOS binary without StoreKit, still warns', async () => {
    mocks.channel = 'none';
    status('apple');
    renderFresh();
    await waitFor(() => expect(screen.getByTestId('app-store-deletion-notice')).toBeInTheDocument());
  });
});
