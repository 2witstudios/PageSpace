import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { withAdminAuth } from '@/lib/auth';
import { Stripe } from '@/lib/stripe';
import { orgGiftStripe } from '@/lib/stripe/org-gift-port';
import { getUserFriendlyStripeError } from '@/lib/stripe-errors';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { giftOrgSubscription, ungiftOrgSubscription } from '@pagespace/lib/billing/org-gift';
import { orgGiftRefusalStatus, type OrgGiftRefusal } from '@pagespace/lib/billing/org-gift-core';

type RouteContext = { params: Promise<{ orgId: string }> };

const giftSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required to gift an organization').max(500),
  /** D-OW-54: extra seats beyond the Business base the gift covers; the gift is fixed at it. */
  extraSeats: z.number().int().min(0).max(10_000),
});

const revokeSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required to revoke an organization gift').max(500),
});

const REFUSAL_MESSAGES: Record<OrgGiftRefusal, string> = {
  billing_disabled: 'Organization not found',
  org_not_found: 'Organization not found',
  admin_is_member: 'You cannot gift or revoke a gift on an organization you belong to',
  invalid_seat_count: 'The gifted extra seats must be a whole number of 0 or more',
  no_subscription: 'This organization has no subscription to gift',
  awaiting_first_payment: 'This organization is still awaiting its first payment; Stripe expires that subscription, so gift it once it has one Stripe will invoice again',
  subscription_not_live: 'This organization\'s subscription has ended; it must subscribe again before it can be gifted',
  already_gifted: 'This organization is already gifted; revoke the gift before gifting it again',
  not_gifted: 'This organization is not gifted',
};

/**
 * POST /api/admin/orgs/[orgId]/gift-subscription
 * SEAT-8 / [D-OW-23]: gift an organization ON its own Business subscription (a 100% coupon
 * and the gift metadata). The webhook funds the org pool at list price × the included-credit
 * ratio from the gift's $0 invoices. The subscription is read from the database by the org
 * id in the path — nothing in the body names one.
 */
export const POST = withAdminAuth<RouteContext>(async (adminUser, request, context) => {
  try {
    const { orgId } = await context.params;
    const parsed = giftSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'A non-empty reason and a whole number of extra seats are required to gift an organization', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const { reason, extraSeats } = parsed.data;

    const result = await giftOrgSubscription({ orgId, adminUserId: adminUser.id, reason, extraSeats }, orgGiftStripe());
    if (result.kind === 'refused') {
      return NextResponse.json({ error: REFUSAL_MESSAGES[result.reason], code: result.reason }, { status: orgGiftRefusalStatus(result.reason) });
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId: adminUser.id,
      resourceType: 'organization',
      resourceId: orgId,
      details: {
        source: 'admin',
        action: 'gift_org_subscription',
        reason,
        subscriptionId: result.subscriptionId,
        couponId: result.couponId,
        restoresNow: result.restoresNow,
        giftedExtraSeats: result.giftedExtraSeats,
        voidedInvoiceIds: result.voidedInvoiceIds,
      },
    });

    return NextResponse.json({
      success: true,
      subscriptionId: result.subscriptionId,
      status: result.status,
      message: result.restoresNow
        ? 'Organization gifted. Its $0 gift invoice is issued now and funds the pool when the webhook lands.'
        : 'Organization gifted. The gift starts at its next renewal, which funds the pool.',
    });
  } catch (error) {
    loggers.api.error('Error gifting organization', error instanceof Error ? error : undefined);
    if (error instanceof Stripe.errors.StripeError) {
      return NextResponse.json({ error: getUserFriendlyStripeError(error) }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to gift organization' }, { status: 500 });
  }
});

/**
 * DELETE /api/admin/orgs/[orgId]/gift-subscription
 * SEAT-8 / [D-OW-54]: revoke an organization's admin gift — the org twin of the personal
 * revoke. The coupon and gift metadata come off the org's own subscription with no proration,
 * so the org pays from its next renewal (a lapse follows if it never adds a card); the seat
 * item returns from the gifted quantity to the seats the org actually holds. Audited in the admin trail and the org's own log.
 */
export const DELETE = withAdminAuth<RouteContext>(async (adminUser, request, context) => {
  try {
    const { orgId } = await context.params;
    const parsed = revokeSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'A non-empty reason is required to revoke an organization gift', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const { reason } = parsed.data;

    const result = await ungiftOrgSubscription({ orgId, adminUserId: adminUser.id, reason }, orgGiftStripe());
    if (result.kind === 'refused') {
      return NextResponse.json({ error: REFUSAL_MESSAGES[result.reason], code: result.reason }, { status: orgGiftRefusalStatus(result.reason) });
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId: adminUser.id,
      resourceType: 'organization',
      resourceId: orgId,
      details: { source: 'admin', action: 'revoke_org_gift', reason, subscriptionId: result.subscriptionId, extraSeatQuantity: result.extraSeatQuantity },
    });

    return NextResponse.json({
      success: true,
      subscriptionId: result.subscriptionId,
      status: result.status,
      message: 'Gift revoked. The organization pays from its next renewal.',
    });
  } catch (error) {
    loggers.api.error('Error revoking organization gift', error instanceof Error ? error : undefined);
    if (error instanceof Stripe.errors.StripeError) {
      return NextResponse.json({ error: getUserFriendlyStripeError(error) }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to revoke organization gift' }, { status: 500 });
  }
});
