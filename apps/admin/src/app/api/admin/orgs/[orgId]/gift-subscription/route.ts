import { NextResponse } from 'next/server';
import { z } from 'zod/v4';
import { withAdminAuth } from '@/lib/auth';
import { Stripe } from '@/lib/stripe';
import { orgGiftStripe } from '@/lib/stripe/org-gift-port';
import { getUserFriendlyStripeError } from '@/lib/stripe-errors';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { giftOrgSubscription } from '@pagespace/lib/billing/org-gift';
import { orgGiftRefusalStatus, type OrgGiftRefusal } from '@pagespace/lib/billing/org-gift-core';

type RouteContext = { params: Promise<{ orgId: string }> };

const giftSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required to gift an organization').max(500),
});

const REFUSAL_MESSAGES: Record<OrgGiftRefusal, string> = {
  billing_disabled: 'Organization not found',
  org_not_found: 'Organization not found',
  self_gift: 'You cannot gift an organization you own',
  no_subscription: 'This organization has no subscription to gift',
  awaiting_first_payment: 'This organization is still awaiting its first payment; Stripe expires that subscription, so gift it once it has one Stripe will invoice again',
  subscription_not_live: 'This organization\'s subscription has ended; it must subscribe again before it can be gifted',
  already_gifted: 'This organization is already gifted',
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
        { error: 'A non-empty reason is required to gift an organization', details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const { reason } = parsed.data;

    const result = await giftOrgSubscription({ orgId, adminUserId: adminUser.id, reason }, orgGiftStripe());
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
