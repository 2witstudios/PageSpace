import { describe, it, expect } from 'vitest';
import { resolveBillingChannel, shouldRedirectFromBillingSurface, type BillingChannelInput } from '../billing-visibility';

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
