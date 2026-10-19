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
import { resolveBillingChannel, shouldRedirectFromBillingSurface, type BillingChannelInput } from '@/lib/billing/billing-visibility';

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

// The pure channel rules the hook is built on (lib/billing/billing-visibility).

const input = (extra: Partial<BillingChannelInput> = {}): BillingChannelInput => ({
  billingEnabled: true,
  isReady: true,
  isIOS: false,
  storeKitAvailable: false,
  ...extra,
});

describe('resolveBillingChannel', () => {
  it('given web or Android on a billing deployment, should sell through Stripe', () => {
    expect(resolveBillingChannel(input())).toBe('stripe');
  });

  it('given the iOS app with the PageSpaceStore plugin, should sell through Apple', () => {
    expect(resolveBillingChannel(input({ isIOS: true, storeKitAvailable: true }))).toBe('apple');
  });

  it('given an iOS binary that predates the plugin, should sell nothing', () => {
    expect(resolveBillingChannel(input({ isIOS: true, storeKitAvailable: false }))).toBe('none');
  });

  it('given platform detection has not finished, should sell nothing (never flash a CTA)', () => {
    expect(resolveBillingChannel(input({ isReady: false }))).toBe('none');
    expect(resolveBillingChannel(input({ isReady: false, isIOS: true, storeKitAvailable: true }))).toBe('none');
  });

  it('given a deployment without billing, should sell nothing on any platform', () => {
    expect(resolveBillingChannel(input({ billingEnabled: false }))).toBe('none');
    expect(resolveBillingChannel(input({ billingEnabled: false, isIOS: true, storeKitAvailable: true }))).toBe('none');
  });
});

describe('shouldRedirectFromBillingSurface', () => {
  it('given detection is pending, should never redirect', () => {
    expect(shouldRedirectFromBillingSurface({ surface: 'stripe', isReady: false, hideBilling: false, channel: 'none' })).toBe(false);
    expect(shouldRedirectFromBillingSurface({ surface: 'purchases', isReady: false, hideBilling: false, channel: 'none' })).toBe(false);
  });

  it('given the Apple channel, should allow the plan page but redirect the Stripe billing page', () => {
    expect(shouldRedirectFromBillingSurface({ surface: 'purchases', isReady: true, hideBilling: true, channel: 'apple' })).toBe(false);
    expect(shouldRedirectFromBillingSurface({ surface: 'stripe', isReady: true, hideBilling: true, channel: 'apple' })).toBe(true);
  });

  it('given the Stripe channel, should allow both surfaces', () => {
    expect(shouldRedirectFromBillingSurface({ surface: 'purchases', isReady: true, hideBilling: false, channel: 'stripe' })).toBe(false);
    expect(shouldRedirectFromBillingSurface({ surface: 'stripe', isReady: true, hideBilling: false, channel: 'stripe' })).toBe(false);
  });

  it('given no channel (old iOS binary, billing disabled), should redirect both surfaces', () => {
    expect(shouldRedirectFromBillingSurface({ surface: 'purchases', isReady: true, hideBilling: true, channel: 'none' })).toBe(true);
    expect(shouldRedirectFromBillingSurface({ surface: 'stripe', isReady: true, hideBilling: true, channel: 'none' })).toBe(true);
  });
});
