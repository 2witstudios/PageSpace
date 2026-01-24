import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// Helper to create mock NextRequest for testing
const createMockRequest = (url: string, init?: RequestInit): NextRequest => {
  return new Request(url, init) as unknown as NextRequest;
};

// Mock Stripe - use vi.hoisted to ensure mocks are available before vi.mock
const {
  mockStripePromotionCodesList,
  mockStripePricesRetrieve,
  StripeError,
} = vi.hoisted(() => {
  const StripeError = class extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'StripeError';
    }
  };
  return {
    mockStripePromotionCodesList: vi.fn(),
    mockStripePricesRetrieve: vi.fn(),
    StripeError,
  };
});

vi.mock('@/lib/stripe', () => ({
  stripe: {
    promotionCodes: {
      list: mockStripePromotionCodesList,
    },
    prices: {
      retrieve: mockStripePricesRetrieve,
    },
  },
  Stripe: {
    errors: { StripeError },
  },
}));

// Mock auth
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
}));

// Import after mocks
import { POST } from '../route';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

// Helper to create mock SessionAuthResult
const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  
  role: 'user',
});

// Helper to create mock AuthError
const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

// Helper to create mock promotion code (Stripe v20 structure)
// In Stripe v20, coupon is nested under promotion.coupon
const mockPromoCode = (overrides: Partial<{
  id: string;
  code: string;
  max_redemptions: number | null;
  times_redeemed: number;
  expires_at: number | null;
  coupon: {
    id: string;
    name: string | null;
    valid: boolean;
    percent_off: number | null;
    amount_off: number | null;
    currency: string | null;
    duration: 'forever' | 'once' | 'repeating';
    duration_in_months: number | null;
  };
}> = {}) => ({
  id: overrides.id ?? 'promo_123',
  code: overrides.code ?? 'SAVE20',
  max_redemptions: overrides.max_redemptions ?? null,
  times_redeemed: overrides.times_redeemed ?? 0,
  expires_at: overrides.expires_at ?? null,
  // Stripe v20: coupon is nested under promotion.coupon
  promotion: {
    coupon: overrides.coupon ?? {
      id: 'coupon_123',
      name: '20% Off',
      valid: true,
      percent_off: 20,
      amount_off: null,
      currency: null,
      duration: 'forever' as const,
      duration_in_months: null,
    },
  },
});

// Helper to create mock price
const mockPrice = (overrides: Partial<{
  id: string;
  unit_amount: number;
}> = {}) => ({
  id: overrides.id ?? 'price_pro',
  unit_amount: overrides.unit_amount ?? 2000, // $20.00
});

describe('POST /api/stripe/validate-promo-code', () => {
  const mockUserId = 'user_123';

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default auth success
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);

    // Setup default Stripe mocks
    mockStripePromotionCodesList.mockResolvedValue({ data: [mockPromoCode()] });
    mockStripePricesRetrieve.mockResolvedValue(mockPrice());
  });

  describe('Success cases', () => {
    it('should validate a percentage discount code', async () => {
      const request = createMockRequest('https://example.com/api/stripe/validate-promo-code', {
        method: 'POST',
        body: JSON.stringify({ code: 'SAVE20', priceId: 'price_pro' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.valid).toBe(true);
      expect(body.promotionCodeId).toBe('promo_123');
      expect(body.coupon.percentOff).toBe(20);
      expect(body.discount.originalAmount).toBe(2000);
      expect(body.discount.discountedAmount).toBe(1600); // 20% off of 2000
      expect(body.discount.savings).toBe(400);
      expect(body.discount.savingsFormatted).toBe('20%');
    });

    it('should validate a fixed amount discount code', async () => {
      mockStripePromotionCodesList.mockResolvedValue({
        data: [mockPromoCode({
          coupon: {
            id: 'coupon_456',
            name: '$5 Off',
            valid: true,
            percent_off: null,
            amount_off: 500, // $5.00 in cents
            currency: 'usd',
            duration: 'once',
            duration_in_months: null,
          },
        })],
      });

      const request = createMockRequest('https://example.com/api/stripe/validate-promo-code', {
        method: 'POST',
        body: JSON.stringify({ code: 'SAVE5', priceId: 'price_pro' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.valid).toBe(true);
      expect(body.coupon.amountOff).toBe(500);
      expect(body.discount.originalAmount).toBe(2000);
      expect(body.discount.discountedAmount).toBe(1500); // 2000 - 500
      expect(body.discount.savings).toBe(500);
      expect(body.discount.savingsFormatted).toBe('$5.00');
    });

    it('should normalize code to uppercase', async () => {
      const request = createMockRequest('https://example.com/api/stripe/validate-promo-code', {
        method: 'POST',
        body: JSON.stringify({ code: 'save20', priceId: 'price_pro' }),
      });

      await POST(request);

      expect(mockStripePromotionCodesList).toHaveBeenCalledWith({
        code: 'SAVE20',
        active: true,
        limit: 1,
      });
    });

    it('should trim whitespace from code', async () => {
      const request = createMockRequest('https://example.com/api/stripe/validate-promo-code', {
        method: 'POST',
        body: JSON.stringify({ code: '  SAVE20  ', priceId: 'price_pro' }),
      });

      await POST(request);

      expect(mockStripePromotionCodesList).toHaveBeenCalledWith({
        code: 'SAVE20',
        active: true,
        limit: 1,
      });
    });
  });

  describe('Validation errors', () => {
    it('should return 400 when code is missing', async () => {
      const request = createMockRequest('https://example.com/api/stripe/validate-promo-code', {
        method: 'POST',
        body: JSON.stringify({ priceId: 'price_pro' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.valid).toBe(false);
      expect(body.error).toBe('Promotion code and price ID are required');
    });

    it('should return 400 when priceId is missing', async () => {
      const request = createMockRequest('https://example.com/api/stripe/validate-promo-code', {
        method: 'POST',
        body: JSON.stringify({ code: 'SAVE20' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.valid).toBe(false);
      expect(body.error).toBe('Promotion code and price ID are required');
    });

    it('should return invalid when promo code not found', async () => {
      mockStripePromotionCodesList.mockResolvedValue({ data: [] });

      const request = createMockRequest('https://example.com/api/stripe/validate-promo-code', {
        method: 'POST',
        body: JSON.stringify({ code: 'INVALID', priceId: 'price_pro' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.valid).toBe(false);
      expect(body.error).toBe('Invalid or expired promotion code');
    });

    it('should return invalid when coupon is not valid', async () => {
      mockStripePromotionCodesList.mockResolvedValue({
        data: [mockPromoCode({
          coupon: {
            id: 'coupon_123',
            name: 'Expired Coupon',
            valid: false,
            percent_off: 20,
            amount_off: null,
            currency: null,
            duration: 'forever',
            duration_in_months: null,
          },
        })],
      });

      const request = createMockRequest('https://example.com/api/stripe/validate-promo-code', {
        method: 'POST',
        body: JSON.stringify({ code: 'EXPIRED', priceId: 'price_pro' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.valid).toBe(false);
      expect(body.error).toBe('This promotion code has expired');
    });

    it('should return invalid when max redemptions exceeded', async () => {
      mockStripePromotionCodesList.mockResolvedValue({
        data: [mockPromoCode({
          max_redemptions: 10,
          times_redeemed: 10,
        })],
      });

      const request = createMockRequest('https://example.com/api/stripe/validate-promo-code', {
        method: 'POST',
        body: JSON.stringify({ code: 'MAXED', priceId: 'price_pro' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.valid).toBe(false);
      expect(body.error).toBe('This promotion code has reached its maximum uses');
    });

    it('should return invalid when promo code is expired', async () => {
      const pastTimestamp = Math.floor(Date.now() / 1000) - 86400; // 1 day ago
      mockStripePromotionCodesList.mockResolvedValue({
        data: [mockPromoCode({
          expires_at: pastTimestamp,
        })],
      });

      const request = createMockRequest('https://example.com/api/stripe/validate-promo-code', {
        method: 'POST',
        body: JSON.stringify({ code: 'EXPIRED', priceId: 'price_pro' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.valid).toBe(false);
      expect(body.error).toBe('This promotion code has expired');
    });
  });

  describe('Error handling', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = createMockRequest('https://example.com/api/stripe/validate-promo-code', {
        method: 'POST',
        body: JSON.stringify({ code: 'SAVE20', priceId: 'price_pro' }),
      });

      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('should return 400 on Stripe API error', async () => {
      mockStripePromotionCodesList.mockRejectedValue(
        new StripeError('Invalid API key')
      );

      const request = createMockRequest('https://example.com/api/stripe/validate-promo-code', {
        method: 'POST',
        body: JSON.stringify({ code: 'SAVE20', priceId: 'price_pro' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.valid).toBe(false);
      // getUserFriendlyStripeError returns generic message for unknown errors
      expect(body.error).toBe('Unable to process this request. Please try again.');
    });

    it('should return 500 on unexpected error', async () => {
      mockStripePromotionCodesList.mockRejectedValue(new Error('Network error'));

      const request = createMockRequest('https://example.com/api/stripe/validate-promo-code', {
        method: 'POST',
        body: JSON.stringify({ code: 'SAVE20', priceId: 'price_pro' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.valid).toBe(false);
      expect(body.error).toBe('Failed to validate promotion code');
    });
  });

  describe('Coupon info', () => {
    it('should return complete coupon information', async () => {
      mockStripePromotionCodesList.mockResolvedValue({
        data: [mockPromoCode({
          coupon: {
            id: 'coupon_repeat',
            name: '30% Off First 3 Months',
            valid: true,
            percent_off: 30,
            amount_off: null,
            currency: null,
            duration: 'repeating',
            duration_in_months: 3,
          },
        })],
      });

      const request = createMockRequest('https://example.com/api/stripe/validate-promo-code', {
        method: 'POST',
        body: JSON.stringify({ code: 'SAVE30X3', priceId: 'price_pro' }),
      });

      const response = await POST(request);
      const body = await response.json();

      expect(body.coupon).toEqual({
        id: 'coupon_repeat',
        name: '30% Off First 3 Months',
        percentOff: 30,
        amountOff: null,
        currency: null,
        duration: 'repeating',
        durationInMonths: 3,
      });
    });
  });
});
