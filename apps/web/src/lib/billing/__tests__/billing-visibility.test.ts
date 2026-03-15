import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/capacitor-bridge', () => ({
  isIOS: vi.fn(),
}));

vi.mock('@/lib/deployment-mode', () => ({
  isOnPrem: vi.fn(),
}));

import { shouldShowBilling, isBillingPath, getBillingRedirect, BILLING_PATHS } from '../billing-visibility';
import { isIOS } from '@/lib/capacitor-bridge';
import { isOnPrem } from '@/lib/deployment-mode';

describe('billing-visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('shouldShowBilling', () => {
    it('should return false when on-prem', () => {
      vi.mocked(isOnPrem).mockReturnValue(true);
      vi.mocked(isIOS).mockReturnValue(false);
      expect(shouldShowBilling()).toBe(false);
    });

    it('should return false when on iOS', () => {
      vi.mocked(isOnPrem).mockReturnValue(false);
      vi.mocked(isIOS).mockReturnValue(true);
      expect(shouldShowBilling()).toBe(false);
    });

    it('should return true when not on-prem and not iOS', () => {
      vi.mocked(isOnPrem).mockReturnValue(false);
      vi.mocked(isIOS).mockReturnValue(false);
      expect(shouldShowBilling()).toBe(true);
    });
  });

  describe('isBillingPath', () => {
    it('should return true for /settings/billing', () => {
      expect(isBillingPath('/settings/billing')).toBe(true);
    });

    it('should return true for /settings/plan', () => {
      expect(isBillingPath('/settings/plan')).toBe(true);
    });

    it('should return true for nested billing paths', () => {
      expect(isBillingPath('/settings/billing/invoices')).toBe(true);
    });

    it('should return false for non-billing paths', () => {
      expect(isBillingPath('/settings/profile')).toBe(false);
    });

    it('should return false for root path', () => {
      expect(isBillingPath('/')).toBe(false);
    });
  });

  describe('getBillingRedirect', () => {
    it('should return /settings', () => {
      expect(getBillingRedirect()).toBe('/settings');
    });
  });

  describe('BILLING_PATHS', () => {
    it('should contain billing and plan paths', () => {
      expect(BILLING_PATHS).toContain('/settings/billing');
      expect(BILLING_PATHS).toContain('/settings/plan');
    });
  });
});
