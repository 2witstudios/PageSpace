import { NextRequest, NextResponse } from 'next/server';

/**
 * @deprecated This route is deprecated. Use the gift-subscription route instead.
 *
 * Direct tier updates bypassed Stripe and caused sync issues with webhooks.
 * The new flow:
 * - POST /api/admin/users/[userId]/gift-subscription - Gift a subscription with 100% coupon
 * - DELETE /api/admin/users/[userId]/gift-subscription - Revoke a gifted subscription
 *
 * This ensures Stripe remains the single source of truth for subscriptions.
 */
export async function PUT(
  _request: NextRequest,
  _context: { params: Promise<{ userId: string }> }
) {
  return NextResponse.json(
    {
      error: 'This endpoint is deprecated',
      message: 'Direct tier updates are no longer supported. Use the gift-subscription endpoint instead.',
      migration: {
        giftSubscription: 'POST /api/admin/users/[userId]/gift-subscription',
        revokeSubscription: 'DELETE /api/admin/users/[userId]/gift-subscription',
      },
    },
    { status: 410 } // 410 Gone
  );
}
