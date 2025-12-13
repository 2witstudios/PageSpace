import { NextRequest, NextResponse } from 'next/server';
import { db, eq, users, subscriptions, and, inArray, desc } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { stripe, Stripe } from '@/lib/stripe';
import { stripeConfig } from '@/lib/stripe-config';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

type GiftTier = 'pro' | 'founder' | 'business';



/**
 * POST /api/admin/users/[userId]/gift-subscription
 * Gift a subscription to a user with a 100% discount coupon.
 * The subscription is created in Stripe, and the webhook updates the user tier.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ userId: string }> }
) {
  try {
    const { userId: targetUserId } = await context.params;

    // Verify admin auth
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;

    if (auth.role !== 'admin') {
      return NextResponse.json(
        { error: 'Forbidden: Admin access required' },
        { status: 403 }
      );
    }

    const adminUserId = auth.userId;

    // Parse request body
    const body = await request.json();
    const { tier, reason } = body as { tier?: string; reason?: string };

    // Validate tier
    if (!tier || !['pro', 'founder', 'business'].includes(tier)) {
      return NextResponse.json(
        { error: 'Invalid tier. Must be "pro", "founder", or "business"' },
        { status: 400 }
      );
    }

    const giftTier = tier as GiftTier;

    // Get target user
    const [targetUser] = await db
      .select()
      .from(users)
      .where(eq(users.id, targetUserId));

    if (!targetUser) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    // Check if user already has an active subscription
    const [existingSubscription] = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, targetUserId),
          inArray(subscriptions.status, ['active', 'trialing'])
        )
      )
      .orderBy(desc(subscriptions.updatedAt))
      .limit(1);

    if (existingSubscription) {
      return NextResponse.json(
        {
          error: 'User already has an active subscription',
          existingSubscriptionId: existingSubscription.stripeSubscriptionId,
        },
        { status: 400 }
      );
    }

    // Get or create Stripe customer
    let customerId = targetUser.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: targetUser.email,
        name: targetUser.name || undefined,
        metadata: { userId: targetUser.id },
      });
      customerId = customer.id;

      try {
        await db.update(users)
          .set({ stripeCustomerId: customerId, updatedAt: new Date() })
          .where(eq(users.id, targetUserId));
      } catch (dbError) {
        // Rollback: delete the orphaned Stripe customer
        await stripe.customers.del(customerId);
        throw dbError;
      }
    }

    // Get price ID for the tier
    const priceId = stripeConfig.priceIds[giftTier];
    if (!priceId) {
      return NextResponse.json(
        { error: `No price configured for tier: ${giftTier}` },
        { status: 500 }
      );
    }

    // Create subscription with 100% discount coupon
    // No payment is required since the coupon covers 100%
    // Use discounts array (coupon parameter is deprecated in newer Stripe API)
    // Create a unique single-use coupon for this gift
    const giftCoupon = await stripe.coupons.create({
      id: `GIFT_${targetUserId}_${Date.now()}`,
      percent_off: 100,
      duration: 'forever',
      max_redemptions: 1,
      name: `Gift for ${targetUser.email}`,
      metadata: {
        giftedTo: targetUserId,
        giftedBy: adminUserId,
        reason: reason || 'Admin gift',
      },
    });

    // Create subscription with the single-use 100% discount coupon
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      discounts: [{ coupon: giftCoupon.id }],
      metadata: {
        userId: targetUser.id,
        giftedBy: adminUserId,
        reason: reason || 'Admin gift',
        type: 'gift_subscription',
      },
    });

    loggers.api.info('Admin gifted subscription', {
      adminId: adminUserId,
      targetUserId,
      targetUserName: targetUser.name,
      targetUserEmail: targetUser.email,
      tier: giftTier,
      subscriptionId: subscription.id,
      couponId: giftCoupon.id,
      reason: reason || 'Admin gift',
    });

    return NextResponse.json({
      success: true,
      subscriptionId: subscription.id,
      tier: giftTier,
      status: subscription.status,
      message: `Gifted ${giftTier} subscription to ${targetUser.name || targetUser.email}`,
    });

  } catch (error) {
    loggers.api.error('Error gifting subscription', error instanceof Error ? error : undefined);

    if (error instanceof Stripe.errors.StripeError) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to gift subscription' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/admin/users/[userId]/gift-subscription
 * Revoke a gifted subscription immediately.
 * The subscription is deleted in Stripe, and the webhook reverts the user to free tier.
 */
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ userId: string }> }
) {
  try {
    const { userId: targetUserId } = await context.params;

    // Verify admin auth
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;

    if (auth.role !== 'admin') {
      return NextResponse.json(
        { error: 'Forbidden: Admin access required' },
        { status: 403 }
      );
    }

    const adminUserId = auth.userId;

    // Get target user
    const [targetUser] = await db
      .select()
      .from(users)
      .where(eq(users.id, targetUserId));

    if (!targetUser) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    // Get user's active subscription
    const [activeSubscription] = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, targetUserId),
          inArray(subscriptions.status, ['active', 'trialing'])
        )
      )
      .orderBy(desc(subscriptions.updatedAt))
      .limit(1);

    if (!activeSubscription) {
      return NextResponse.json(
        { error: 'User does not have an active subscription' },
        { status: 400 }
      );
    }

    // Cancel the subscription immediately in Stripe
    // This will trigger a customer.subscription.deleted webhook
    await stripe.subscriptions.cancel(activeSubscription.stripeSubscriptionId);

    loggers.api.info('Admin revoked subscription', {
      adminId: adminUserId,
      targetUserId,
      targetUserName: targetUser.name,
      targetUserEmail: targetUser.email,
      subscriptionId: activeSubscription.stripeSubscriptionId,
      previousTier: targetUser.subscriptionTier,
    });

    return NextResponse.json({
      success: true,
      message: `Subscription revoked for ${targetUser.name || targetUser.email}. User will be downgraded to free tier.`,
      revokedSubscriptionId: activeSubscription.stripeSubscriptionId,
    });

  } catch (error) {
    loggers.api.error('Error revoking subscription', error instanceof Error ? error : undefined);

    if (error instanceof Stripe.errors.StripeError) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to revoke subscription' },
      { status: 500 }
    );
  }
}
