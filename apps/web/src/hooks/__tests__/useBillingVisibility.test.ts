import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const { mockUseCapacitor, mockIsBillingEnabled, mockIsPluginAvailable } = vi.hoisted(() => ({
  mockUseCapacitor: vi.fn(),
  mockIsBillingEnabled: vi.fn(),
  mockIsPluginAvailable: vi.fn(),
}));

vi.mock('@/hooks/useCapacitor', () => ({ useCapacitor: () => mockUseCapacitor() }));
vi.mock('@/lib/deployment-mode', () => ({ isBillingEnabled: () => mockIsBillingEnabled() }));
vi.mock('@/lib/capacitor-bridge', () => ({ isNativePluginAvailable: (name: string) => mockIsPluginAvailable(name) }));

import { useBillingVisibility } from '../useBillingVisibility';

const capacitor = ({ isIOS, isReady }: { isIOS: boolean; isReady: boolean }) => ({
  isIOS,
  isReady,
  capabilities: { storeKit: isReady && isIOS },
});

describe('useBillingVisibility', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockIsBillingEnabled.mockReturnValue(true);
    mockIsPluginAvailable.mockReturnValue(false);
  });

  it('hides purchase UI while platform detection is still pending', () => {
    // The unsafe direction is showing a purchase surface we later retract — on
    // iOS that renders a buy affordance for a frame. Six callers gate purchase
    // UI on this flag, so the default lives here.
    mockUseCapacitor.mockReturnValue(capacitor({ isIOS: false, isReady: false }));
    const { showBilling, showPurchases, channel } = renderHook(() => useBillingVisibility()).result.current;
    expect(showBilling).toBe(false);
    expect(showPurchases).toBe(false);
    expect(channel).toBe('none');
  });

  it('does not redirect while detection is pending', () => {
    // hideBilling drives redirects; bouncing before detection would throw web
    // users off their own billing pages.
    mockUseCapacitor.mockReturnValue(capacitor({ isIOS: false, isReady: false }));
    expect(renderHook(() => useBillingVisibility()).result.current.hideBilling).toBe(false);
  });

  it('shows Stripe billing on a non-iOS platform once ready', () => {
    mockUseCapacitor.mockReturnValue(capacitor({ isIOS: false, isReady: true }));
    const { showBilling, hideBilling, channel, showPurchases } = renderHook(() => useBillingVisibility()).result.current;
    expect(showBilling).toBe(true);
    expect(hideBilling).toBe(false);
    expect(channel).toBe('stripe');
    expect(showPurchases).toBe(true);
  });

  it('hides all billing on an iOS binary without the PageSpaceStore plugin', () => {
    mockUseCapacitor.mockReturnValue(capacitor({ isIOS: true, isReady: true }));
    const { showBilling, hideBilling, channel, showPurchases } = renderHook(() => useBillingVisibility()).result.current;
    expect(showBilling).toBe(false);
    expect(hideBilling).toBe(true);
    expect(channel).toBe('none');
    expect(showPurchases).toBe(false);
  });

  it('sells through Apple on iOS with the plugin, while keeping Stripe surfaces hidden', () => {
    mockIsPluginAvailable.mockImplementation((name: string) => name === 'PageSpaceStore');
    mockUseCapacitor.mockReturnValue(capacitor({ isIOS: true, isReady: true }));
    const { showBilling, hideBilling, channel, showPurchases } = renderHook(() => useBillingVisibility()).result.current;
    expect(channel).toBe('apple');
    expect(showPurchases).toBe(true);
    expect(showBilling).toBe(false);
    expect(hideBilling).toBe(true);
  });

  it('hides billing immediately when the deployment has no billing at all', () => {
    mockIsBillingEnabled.mockReturnValue(false);
    mockIsPluginAvailable.mockReturnValue(true);
    mockUseCapacitor.mockReturnValue(capacitor({ isIOS: true, isReady: false }));
    const result = renderHook(() => useBillingVisibility()).result.current;
    expect(result).toEqual({ showBilling: false, hideBilling: true, isReady: true, channel: 'none', showPurchases: false });
  });
});
