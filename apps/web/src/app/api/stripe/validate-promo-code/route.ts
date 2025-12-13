import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { stripe, Stripe } from '@/lib/stripe';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: false };

interface ValidatePromoCodeRequest {
  code: string;
  priceId: string;
}

interface CouponInfo {
  id: string;
  name: string | null;
  percentOff: number | null;
  amountOff: number | null;
  currency: string | null;
  duration: 'forever' | 'once' | 'repeating';
  durationInMonths: number | null;
}

interface DiscountInfo {
  originalAmount: number;
  discountedAmount: number;
  savings: number;
  savingsFormatted: string;
}

/**
 * POST /api/stripe/validate-promo-code
 * Validates a promotion code and returns discount preview.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;

    const body = await request.json() as ValidatePromoCodeRequest;
    const { code, priceId } = body;

    if (!code || !priceId) {
      return NextResponse.json(
        { valid: false, error: 'Promotion code and price ID are required' },
        { status: 400 }
      );
    }

    // Normalize code: uppercase and trim
    const normalizedCode = code.toUpperCase().trim();

    // Validate promotion code with Stripe
    const promos = await stripe.promotionCodes.list({
      code: normalizedCode,
      active: true,
      limit: 1,
    });

    if (promos.data.length === 0) {
      return NextResponse.json({
        valid: false,
        error: 'Invalid or expired promotion code',
      });
    }

    const promoCode = promos.data[0];
    const coupon = promoCode.coupon;

    // Check if coupon is still valid
    if (!coupon.valid) {
      return NextResponse.json({
        valid: false,
        error: 'This promotion code has expired',
      });
    }

    // Check max redemptions
    if (promoCode.max_redemptions && promoCode.times_redeemed >= promoCode.max_redemptions) {
      return NextResponse.json({
        valid: false,
        error: 'This promotion code has reached its maximum uses',
      });
    }

    // Check expiration
    if (promoCode.expires_at && promoCode.expires_at < Math.floor(Date.now() / 1000)) {
      return NextResponse.json({
        valid: false,
        error: 'This promotion code has expired',
      });
    }

    // Get the price to calculate discount
    const price = await stripe.prices.retrieve(priceId);
    const originalAmount = price.unit_amount || 0;

    // Calculate discount
    let discountedAmount = originalAmount;
    let savingsFormatted = '';

    if (coupon.percent_off) {
      discountedAmount = Math.round(originalAmount * (1 - coupon.percent_off / 100));
      savingsFormatted = `${coupon.percent_off}%`;
    } else if (coupon.amount_off) {
      discountedAmount = Math.max(0, originalAmount - coupon.amount_off);
      savingsFormatted = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: coupon.currency || 'usd',
      }).format(coupon.amount_off / 100);
    }

    const savings = originalAmount - discountedAmount;

    const couponInfo: CouponInfo = {
      id: coupon.id,
      name: coupon.name,
      percentOff: coupon.percent_off,
      amountOff: coupon.amount_off,
      currency: coupon.currency,
      duration: coupon.duration,
      durationInMonths: coupon.duration_in_months,
    };

    const discountInfo: DiscountInfo = {
      originalAmount,
      discountedAmount,
      savings,
      savingsFormatted,
    };

    loggers.api.info('Promo code validated', {
      code: normalizedCode,
      promoId: promoCode.id,
      couponId: coupon.id,
      percentOff: coupon.percent_off,
      amountOff: coupon.amount_off,
    });

    return NextResponse.json({
      valid: true,
      promotionCodeId: promoCode.id,
      coupon: couponInfo,
      discount: discountInfo,
    });

  } catch (error) {
    loggers.api.error('Error validating promo code', error instanceof Error ? error : undefined);

    if (error instanceof Stripe.errors.StripeError) {
      return NextResponse.json(
        { valid: false, error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { valid: false, error: 'Failed to validate promotion code' },
      { status: 500 }
    );
  }
}
