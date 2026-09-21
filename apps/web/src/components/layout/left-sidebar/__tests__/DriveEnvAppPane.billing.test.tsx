import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

const { visibility, fetchWithAuth } = vi.hoisted(() => ({
  visibility: { showBilling: true },
  fetchWithAuth: vi.fn(),
}));
vi.mock('@/hooks/useBillingVisibility', () => ({ useBillingVisibility: () => visibility }));
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth,
  post: vi.fn(),
  del: vi.fn(),
  ApiRequestError: class extends Error {},
}));
vi.mock('@/stores/useEditingSession', () => ({ useEditingSession: vi.fn() }));
vi.mock('@/components/billing/StripeProvider', () => ({ StripeProvider: () => null }));
vi.mock('@stripe/react-stripe-js', () => ({ PaymentElement: () => null, useElements: () => null, useStripe: () => null }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { DedicatedTierSection, parkedNoticeFor } from '../DriveEnvAppPane';
import type { DriveEnvAppDTO } from '@/hooks/drive-envs/useDriveEnvApp';

const PURCHASE_CTA = /\b(buy|purchase|upgrade|top.?up|add credits|always-on plan)\b/i;
const app = { id: 'app-1', tier: 'metered', status: 'running' } as unknown as DriveEnvAppDTO;

const renderSection = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DedicatedTierSection app={app} isOwner driveId="d1" envId="e1" />
    </SWRConfig>,
  );

describe('DriveEnvAppPane — always-on purchase', () => {
  beforeEach(() => {
    visibility.showBilling = true;
    fetchWithAuth.mockReset();
    fetchWithAuth.mockResolvedValue({ ok: true, json: () => Promise.resolve({ subscription: null, purchasable: true }) });
  });

  it('given a drive owner on the web with a purchasable app, should offer the always-on purchase', async () => {
    renderSection();
    expect(await screen.findByRole('button', { name: 'Buy always-on' })).toBeTruthy();
  });

  it('given a drive owner in the iOS app, should offer no always-on purchase', async () => {
    visibility.showBilling = false;
    renderSection();
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(0));
    expect(screen.queryByRole('button', { name: 'Buy always-on' })).toBeNull();
  });

  it('given a parked app where billing is hidden, should explain the pause without a purchase instruction', () => {
    expect(parkedNoticeFor(false)).not.toMatch(PURCHASE_CTA);
  });

  it('given a parked app on the web, should still point to topping up or the always-on plan', () => {
    expect(parkedNoticeFor(true)).toMatch(/top up/i);
  });
});
