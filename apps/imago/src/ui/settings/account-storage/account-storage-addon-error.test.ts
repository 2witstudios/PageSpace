import { describe, expect, it, vi } from 'vitest';

vi.mock('@/retained/hooks/useBillingVisibility', () => ({ useBillingVisibility: () => ({ showBilling: true, showPurchases: true }) }));

import { ApiRequestError } from '@/retained/lib/auth/auth-fetch';
import { storageAddonErrorMessage } from './account-storage';

describe('storageAddonErrorMessage', () => {
  it("keeps the storage route's own message and replaces anything else with a safe one", () => {
    expect(storageAddonErrorMessage(new ApiRequestError('x', 402, { error: 'Update your payment method before changing storage' })))
      .toBe('Update your payment method before changing storage');
    expect(storageAddonErrorMessage(new ApiRequestError('Unexpected token < in JSON', 502, undefined)))
      .toBe('The storage change could not be completed. Try again.');
    expect(storageAddonErrorMessage(new TypeError('Failed to fetch'))).toBe('The storage change could not be completed. Try again.');
  });
});
