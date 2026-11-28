import { describe, expect, test } from 'vitest';
import { isPaymentElementRoute, paymentRouteFor } from './payment-routes';

describe('native org payment documents', () => {
  test('creation and reactivation hard loads remain under the Imago base path', () => {
    expect(paymentRouteFor({ kind: 'create_org' })).toBe('/imago/account/organizations?createOrg=1');
    expect(paymentRouteFor({ kind: 'reactivate', orgId: 'o1' })).toBe('/imago/orgs/o1/settings/billing?reactivate=1');
    expect(isPaymentElementRoute('/imago/account/organizations')).toBe(true);
    expect(isPaymentElementRoute('/imago/orgs/o1/settings/billing')).toBe(true);
    expect(isPaymentElementRoute('/imago/orgs/o1/settings/members')).toBe(false);
  });
});
