import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const { mockUseCapacitor, mockIsBillingEnabled } = vi.hoisted(() => ({
  mockUseCapacitor: vi.fn(),
  mockIsBillingEnabled: vi.fn(),
}));

vi.mock('@/hooks/useCapacitor', () => ({ useCapacitor: () => mockUseCapacitor() }));
vi.mock('@/lib/deployment-mode', () => ({ isBillingEnabled: () => mockIsBillingEnabled() }));

import { useBillingVisibility } from '../useBillingVisibility';

describe('useBillingVisibility', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockIsBillingEnabled.mockReturnValue(true);
  });

  it('hides purchase UI while platform detection is still pending', () => {
    // The unsafe direction is showing a purchase surface we later retract — on
    // iOS that renders a buy affordance for a frame. Six callers gate purchase
    // UI on this flag, so the default lives here.
    mockUseCapacitor.mockReturnValue({ isIOS: false, isReady: false });
    expect(renderHook(() => useBillingVisibility()).result.current.showBilling).toBe(false);
  });

  it('does not redirect while detection is pending', () => {
    // hideBilling drives redirects; bouncing before detection would throw web
    // users off their own billing pages.
    mockUseCapacitor.mockReturnValue({ isIOS: false, isReady: false });
    expect(renderHook(() => useBillingVisibility()).result.current.hideBilling).toBe(false);
  });

  it('shows billing on a non-iOS platform once ready', () => {
    mockUseCapacitor.mockReturnValue({ isIOS: false, isReady: true });
    const { showBilling, hideBilling } = renderHook(() => useBillingVisibility()).result.current;
    expect(showBilling).toBe(true);
    expect(hideBilling).toBe(false);
  });

  it('hides billing on iOS once ready', () => {
    mockUseCapacitor.mockReturnValue({ isIOS: true, isReady: true });
    const { showBilling, hideBilling } = renderHook(() => useBillingVisibility()).result.current;
    expect(showBilling).toBe(false);
    expect(hideBilling).toBe(true);
  });

  it('hides billing immediately when the deployment has no billing at all', () => {
    mockIsBillingEnabled.mockReturnValue(false);
    mockUseCapacitor.mockReturnValue({ isIOS: false, isReady: false });
    const { showBilling, hideBilling, isReady } = renderHook(() => useBillingVisibility()).result.current;
    expect(showBilling).toBe(false);
    expect(hideBilling).toBe(true);
    expect(isReady).toBe(true);
  });
});
