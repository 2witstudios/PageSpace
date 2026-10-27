import { describe, expect, it } from 'vitest';
import { assertOrgFundingCutoverOffline, assertPersonalBillingCutoverOffline } from '../personal-cutover-gate';

describe('personal billing schema cutover gate', () => {
  it('refuses a populated legacy schema without an offline cutover assertion', () => {
    expect(() => assertPersonalBillingCutoverOffline(true, undefined)).toThrow(/offline/);
    expect(() => assertPersonalBillingCutoverOffline(true, 'false')).toThrow(/offline/);
  });
  it('allows the coordinated offline cutover and subsequent ordinary deploys', () => {
    expect(() => assertPersonalBillingCutoverOffline(true, 'true')).not.toThrow();
    expect(() => assertPersonalBillingCutoverOffline(false, undefined)).not.toThrow();
  });
});

describe('org first-payment funding cutover gate', () => {
  it('refuses to add org_subscription_funding under existing org subscriptions without the offline assertion (they would all read never_funded)', () => {
    expect(() => assertOrgFundingCutoverOffline({ fundingTableExists: false, hasOrgSubscriptions: true }, undefined)).toThrow(/org-first-payment-cutover/);
    expect(() => assertOrgFundingCutoverOffline({ fundingTableExists: false, hasOrgSubscriptions: true }, 'false')).toThrow(/offline/);
  });
  it('allows the offline cutover, a database with no org subscriptions yet, and every deploy after the table exists', () => {
    expect(() => assertOrgFundingCutoverOffline({ fundingTableExists: false, hasOrgSubscriptions: true }, 'true')).not.toThrow();
    expect(() => assertOrgFundingCutoverOffline({ fundingTableExists: false, hasOrgSubscriptions: false }, undefined)).not.toThrow();
    expect(() => assertOrgFundingCutoverOffline({ fundingTableExists: true, hasOrgSubscriptions: true }, undefined)).not.toThrow();
  });
});
