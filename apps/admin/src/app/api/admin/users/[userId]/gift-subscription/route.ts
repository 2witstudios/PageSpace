import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { db } from '@pagespace/db/db'
import { eq, and, inArray, desc } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { withAdminAuth } from '@/lib/auth';
import { stripe, Stripe } from '@/lib/stripe';
import { getOrCreateStripeCustomer } from '@/lib/stripe-customer';
import { getUserFriendlyStripeError } from '@/lib/stripe-errors';
import { stripeConfig } from '@/lib/stripe-config';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { maskEmail } from '@pagespace/lib/audit/mask-email';
import { decryptUserRow } from '@pagespace/lib/auth/user-repository';

type RouteContext = { params: Promise<{ userId: string }> };

const giftSchema = z.object({
  tier: z.enum(['pro', 'founder', 'business']),
  reason: z.string().trim().min(1).max(500).default('Admin gift'),
});

const revokeSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required to revoke a subscription').max(500),
  // Default false preserves the historical immediate-cancel behavior for
  // gifted subs; the UI defaults paid revokes to cancel-at-period-end.
  cancelAtPeriodEnd: z.boolean().default(false),
});

/**
 * POST /api/admin/users/[userId]/gift-subscription
 * Gift a subscription to a user with a 100% discount coupon.
 * The subscription is created in Stripe, and the webhook updates the user tier.
 */
export const POST = withAdminAuth<RouteContext>(async (adminUser, request, context) => {
  try {
    const { userId: targetUserId } = await context.params;
    const adminUserId = adminUser.id;

    // Same self-guard as suspend/role/sessions: admins do not act on their
    // own account (self-gifting is a self-dealing path).
    if (targetUserId === adminUserId) {
      return NextResponse.json(
        { error: 'You cannot gift a subscription to your own account' },
        { status: 400 }
      );
    }

    const parsed = giftSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid request. Tier must be "pro", "founder", or "business" and reason must be non-empty.', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const { tier: giftTier, reason } = parsed.data;

    // Get target user. name/email are AES-GCM ciphertext at rest — decrypt
    // BEFORE any use (Stripe coupon name, response messages, masked logs).
    const [rawTargetUser] = await db
      .select()
      .from(users)
      .where(eq(users.id, targetUserId));

    if (!rawTargetUser) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    const targetUser = await decryptUserRow(rawTargetUser);

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

    // Get or create Stripe customer (handles stale customer IDs)
    const customerId = await getOrCreateStripeCustomer(targetUser);

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
        reason,
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
        reason,
        type: 'gift_subscription',
      },
    });

    loggers.api.info('Admin gifted subscription', {
      adminId: adminUserId,
      targetUserId,
      targetUserEmail: maskEmail(targetUser.email),
      tier: giftTier,
      subscriptionId: subscription.id,
      couponId: giftCoupon.id,
      reason,
    });

    // Record what/why in the tamper-evident audit trail (not just method+path).
    auditRequest(request, {
      eventType: 'data.write',
      userId: adminUserId,
      resourceType: 'user',
      resourceId: targetUserId,
      details: {
        source: 'admin',
        action: 'gift_subscription',
        tier: giftTier,
        reason,
        subscriptionId: subscription.id,
      },
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
        { error: getUserFriendlyStripeError(error) },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to gift subscription' },
      { status: 500 }
    );
  }
});

/**
 * DELETE /api/admin/users/[userId]/gift-subscription
 * Revoke a user's active subscription. Requires a non-empty reason in the
 * JSON body. `cancelAtPeriodEnd: true` schedules the cancellation instead of
 * cutting the user off immediately (recommended for paid subscriptions).
 * Stripe webhooks revert the user to free tier when the subscription ends.
 */
export const DELETE = withAdminAuth<RouteContext>(async (adminUser, request, context) => {
  try {
    const { userId: targetUserId } = await context.params;
    const adminUserId = adminUser.id;

    // Same self-guard as POST: admins do not act on their own subscription.
    if (targetUserId === adminUserId) {
      return NextResponse.json(
        { error: 'You cannot revoke a subscription on your own account' },
        { status: 400 }
      );
    }

    const parsed = revokeSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'A non-empty reason is required to revoke a subscription', details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    const { reason, cancelAtPeriodEnd } = parsed.data;

    // Get target user (decrypt PII before any use — see POST).
    const [rawTargetUser] = await db
      .select()
      .from(users)
      .where(eq(users.id, targetUserId));

    if (!rawTargetUser) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }

    const targetUser = await decryptUserRow(rawTargetUser);

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

    if (cancelAtPeriodEnd) {
      // Schedule cancellation; the user keeps access until the period ends.
      await stripe.subscriptions.update(activeSubscription.stripeSubscriptionId, {
        cancel_at_period_end: true,
      });
    } else {
      // Cancel immediately; triggers a customer.subscription.deleted webhook.
      await stripe.subscriptions.cancel(activeSubscription.stripeSubscriptionId);
    }

    loggers.api.info('Admin revoked subscription', {
      adminId: adminUserId,
      targetUserId,
      targetUserEmail: maskEmail(targetUser.email),
      subscriptionId: activeSubscription.stripeSubscriptionId,
      previousTier: targetUser.subscriptionTier,
      cancelAtPeriodEnd,
      reason,
    });

    // Record what/why in the tamper-evident audit trail (not just method+path).
    auditRequest(request, {
      eventType: 'data.write',
      userId: adminUserId,
      resourceType: 'user',
      resourceId: targetUserId,
      details: {
        source: 'admin',
        action: 'revoke_subscription',
        reason,
        cancelAtPeriodEnd,
        previousTier: targetUser.subscriptionTier,
        subscriptionId: activeSubscription.stripeSubscriptionId,
      },
    });

    const displayName = targetUser.name || targetUser.email;
    return NextResponse.json({
      success: true,
      message: cancelAtPeriodEnd
        ? `Subscription for ${displayName} will be canceled at the end of the current billing period.`
        : `Subscription revoked for ${displayName}. User will be downgraded to free tier.`,
      revokedSubscriptionId: activeSubscription.stripeSubscriptionId,
      cancelAtPeriodEnd,
    });

  } catch (error) {
    loggers.api.error('Error revoking subscription', error instanceof Error ? error : undefined);

    if (error instanceof Stripe.errors.StripeError) {
      return NextResponse.json(
        { error: getUserFriendlyStripeError(error) },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to revoke subscription' },
      { status: 500 }
    );
  }
});
