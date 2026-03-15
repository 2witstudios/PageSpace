import { describe, it, expect } from 'vitest';
import { getUserFriendlyStripeError } from '../stripe-errors';

describe('stripe-errors', () => {
  describe('getUserFriendlyStripeError', () => {
    it('should return friendly message for prior transactions error', () => {
      const error = new Error('This coupon requires prior transactions on the account');
      expect(getUserFriendlyStripeError(error)).toBe('This promotion code is only available for new customers.');
    });

    it('should return friendly message for first time error', () => {
      const error = new Error('This promotion is only for first time customers');
      expect(getUserFriendlyStripeError(error)).toBe('This promotion code is only available for new customers.');
    });

    it('should return friendly message for already redeemed', () => {
      const error = new Error('This promotion code has already been redeemed');
      expect(getUserFriendlyStripeError(error)).toBe('This promotion code has already been used.');
    });

    it('should return friendly message for invalid products', () => {
      const error = new Error('This coupon is not valid for the products on this invoice');
      expect(getUserFriendlyStripeError(error)).toBe('This promotion code is not valid for this plan.');
    });

    it('should return friendly message for expired promotion', () => {
      const error = new Error('The promotion code has expired');
      expect(getUserFriendlyStripeError(error)).toBe('This promotion code has expired.');
    });

    it('should return friendly message for maximum redemptions', () => {
      const error = new Error('This coupon has reached its maximum redemptions');
      expect(getUserFriendlyStripeError(error)).toBe('This promotion code has reached its maximum uses.');
    });

    it('should return friendly message for deleted customer', () => {
      const error = new Error('The customer was deleted');
      expect(getUserFriendlyStripeError(error)).toBe('Unable to process payment. Please try again.');
    });

    it('should return friendly message for no such customer', () => {
      const error = new Error('No such customer: cus_xxx');
      expect(getUserFriendlyStripeError(error)).toBe('Unable to process payment. Please try again.');
    });

    it('should return friendly message for declined card', () => {
      const error = new Error('Your card was declined');
      expect(getUserFriendlyStripeError(error)).toBe('Your card was declined. Please try a different payment method.');
    });

    it('should return friendly message for insufficient funds', () => {
      const error = new Error('Your card has insufficient funds');
      expect(getUserFriendlyStripeError(error)).toBe('Your card has insufficient funds.');
    });

    it('should return friendly message for expired card', () => {
      const error = new Error('Your expired card cannot be used');
      expect(getUserFriendlyStripeError(error)).toBe('Your card has expired. Please use a different card.');
    });

    it('should return generic message for unknown errors', () => {
      const error = new Error('Something completely unexpected happened');
      expect(getUserFriendlyStripeError(error)).toBe('Unable to process this request. Please try again.');
    });

    it('should handle case-insensitive matching', () => {
      const error = new Error('YOUR CARD WAS DECLINED by the bank');
      expect(getUserFriendlyStripeError(error)).toBe('Your card was declined. Please try a different payment method.');
    });
  });
});
