import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockUseCapacitor = vi.hoisted(() => vi.fn());
const mockIsOnPrem = vi.hoisted(() => vi.fn());

vi.mock('./useCapacitor', () => ({
  useCapacitor: mockUseCapacitor,
}));

vi.mock('@/lib/deployment-mode', () => ({
  isOnPrem: mockIsOnPrem,
}));

// The import path must match what the source uses (relative path for useCapacitor)
// However, since the source uses `./useCapacitor`, we need to mock the actual resolved path
vi.mock('../useCapacitor', () => ({
  useCapacitor: mockUseCapacitor,
}));

import { useBillingVisibility } from '../useBillingVisibility';

describe('useBillingVisibility', () => {
  beforeEach(() => {
    mockUseCapacitor.mockReset();
    mockIsOnPrem.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('on-prem deployment', () => {
    it('should return showBilling=false when on-prem', () => {
      mockIsOnPrem.mockReturnValue(true);
      mockUseCapacitor.mockReturnValue({
        isIOS: false,
        isReady: true,
      });

      const { result } = renderHook(() => useBillingVisibility());

      expect(result.current.showBilling).toBe(false);
      expect(result.current.hideBilling).toBe(true);
      expect(result.current.isReady).toBe(true);
    });

    it('should return isReady=true immediately for on-prem', () => {
      mockIsOnPrem.mockReturnValue(true);
      // Even if useCapacitor says not ready, on-prem should be immediately ready
      mockUseCapacitor.mockReturnValue({
        isIOS: false,
        isReady: false,
      });

      const { result } = renderHook(() => useBillingVisibility());

      expect(result.current.isReady).toBe(true);
      expect(result.current.showBilling).toBe(false);
    });
  });

  describe('iOS platform', () => {
    it('should return showBilling=false when on iOS and ready', () => {
      mockIsOnPrem.mockReturnValue(false);
      mockUseCapacitor.mockReturnValue({
        isIOS: true,
        isReady: true,
      });

      const { result } = renderHook(() => useBillingVisibility());

      expect(result.current.showBilling).toBe(false);
      expect(result.current.hideBilling).toBe(true);
      expect(result.current.isReady).toBe(true);
    });

    it('should return showBilling=true when iOS but not yet ready', () => {
      mockIsOnPrem.mockReturnValue(false);
      mockUseCapacitor.mockReturnValue({
        isIOS: true,
        isReady: false,
      });

      const { result } = renderHook(() => useBillingVisibility());

      // Before ready, showBilling defaults to true to avoid flash
      expect(result.current.showBilling).toBe(true);
      expect(result.current.hideBilling).toBe(false);
      expect(result.current.isReady).toBe(false);
    });
  });

  describe('web platform', () => {
    it('should return showBilling=true when on web and ready', () => {
      mockIsOnPrem.mockReturnValue(false);
      mockUseCapacitor.mockReturnValue({
        isIOS: false,
        isReady: true,
      });

      const { result } = renderHook(() => useBillingVisibility());

      expect(result.current.showBilling).toBe(true);
      expect(result.current.hideBilling).toBe(false);
      expect(result.current.isReady).toBe(true);
    });

    it('should return showBilling=true when on web and not yet ready', () => {
      mockIsOnPrem.mockReturnValue(false);
      mockUseCapacitor.mockReturnValue({
        isIOS: false,
        isReady: false,
      });

      const { result } = renderHook(() => useBillingVisibility());

      // Before ready, showBilling defaults to true
      expect(result.current.showBilling).toBe(true);
      expect(result.current.isReady).toBe(false);
    });
  });

  describe('Android platform', () => {
    it('should return showBilling=true when on Android', () => {
      mockIsOnPrem.mockReturnValue(false);
      mockUseCapacitor.mockReturnValue({
        isIOS: false,
        isAndroid: true,
        isReady: true,
      });

      const { result } = renderHook(() => useBillingVisibility());

      expect(result.current.showBilling).toBe(true);
      expect(result.current.hideBilling).toBe(false);
    });
  });
});
