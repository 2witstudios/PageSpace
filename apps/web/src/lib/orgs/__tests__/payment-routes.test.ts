import { describe, it, expect } from 'vitest';
import { isPaymentElementRoute, paymentRouteFor } from '../payment-routes';

describe('isPaymentElementRoute', () => {
  it('UI-6 (partial): exactly the routes that mount the Stripe Payment Element', () => {
    expect(isPaymentElementRoute('/settings')).toBe(true);
    expect(isPaymentElementRoute('/orgs/org_1/settings/billing')).toBe(true);
  });

  it('nothing broader: other settings and org pages keep COEP', () => {
    for (const path of ['/settings/', '/settings/account', '/orgs/org_1/settings', '/orgs/org_1/settings/members', '/orgs/org_1/settings/billing/x', '/orgs//settings/billing', '/orgs/a/b/settings/billing', '/settings?x']) {
      expect(isPaymentElementRoute(path), path).toBe(false);
    }
  });
});

describe('paymentRouteFor', () => {
  it('names the full-load URL that opens each payment surface', () => {
    expect(paymentRouteFor({ kind: 'create_org' })).toBe('/settings?createOrg=1');
    expect(paymentRouteFor({ kind: 'reactivate', orgId: 'org_1' })).toBe('/orgs/org_1/settings/billing?reactivate=1');
  });
});
