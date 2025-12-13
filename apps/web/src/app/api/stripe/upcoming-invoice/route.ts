import { NextRequest, NextResponse } from 'next/server';
import { db, eq, and, inArray, desc, users, subscriptions } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { stripe, Stripe } from '@/lib/stripe';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: false };

/**
 * GET /api/stripe/upcoming-invoice
 * Preview the next invoice, optionally with a new price for proration preview.
 * Query params:
 * - priceId: (optional) New price ID to simulate plan change
 */
export async function GET(request: NextRequest) {

  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { searchParams } = new URL(request.url);
    const newPriceId = searchParams.get('priceId');
    const promotionCodeId = searchParams.get('promotionCodeId');

    // Get user
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (!user.stripeCustomerId) {
      return NextResponse.json({ invoice: null, message: 'No customer found' });
    }

    // Get current active subscription (filter by status to avoid returning stale records)
    const [currentSubscription] = await db.select()
      .from(subscriptions)
      .where(and(
        eq(subscriptions.userId, userId),
        inArray(subscriptions.status, ['active', 'trialing', 'past_due'])
      ))
      .orderBy(desc(subscriptions.updatedAt))
      .limit(1);

    if (!currentSubscription?.stripeSubscriptionId) {
      return NextResponse.json({ invoice: null, message: 'No active subscription' });
    }

    // Build upcoming invoice params
    const params: Stripe.InvoiceCreatePreviewParams = {
      customer: user.stripeCustomerId,
      subscription: currentSubscription.stripeSubscriptionId,
      // Apply promotion code to preview if provided
      ...(promotionCodeId && {
        discounts: [{ promotion_code: promotionCodeId }],
      }),
    };

    // If simulating a plan change, include the new price
    if (newPriceId) {
      const subscription = await stripe.subscriptions.retrieve(
        currentSubscription.stripeSubscriptionId
      );
      const currentItemId = subscription.items.data[0]?.id;

      if (currentItemId) {
        params.subscription_details = {
          items: [{
            id: currentItemId,
            price: newPriceId,
          }],
          proration_behavior: 'create_prorations',
        };
      }
    }

    const invoice = await stripe.invoices.createPreview(params);

    // Extended line item type for proration property
    type LineItemWithProration = Stripe.InvoiceLineItem & { proration?: boolean };
    const lines = invoice.lines.data as LineItemWithProration[];

    // Calculate proration if this is a preview
    const prorationItems = lines.filter(line => line.proration);

    const prorationAmount = prorationItems.reduce(
      (sum, item) => sum + item.amount,
      0
    );

    return NextResponse.json({
      invoice: {
        amountDue: invoice.amount_due,
        subtotal: invoice.subtotal,
        total: invoice.total,
        currency: invoice.currency,
        periodStart: invoice.period_start ? new Date(invoice.period_start * 1000).toISOString() : null,
        periodEnd: invoice.period_end ? new Date(invoice.period_end * 1000).toISOString() : null,
        nextPaymentAttempt: invoice.next_payment_attempt
          ? new Date(invoice.next_payment_attempt * 1000).toISOString()
          : null,
        lines: lines.map(line => ({
          description: line.description,
          amount: line.amount,
          proration: line.proration,
          period: line.period ? {
            start: new Date(line.period.start * 1000).toISOString(),
            end: new Date(line.period.end * 1000).toISOString(),
          } : null,
        })),
      },
      proration: newPriceId ? {
        amount: prorationAmount,
        items: prorationItems.map(item => ({
          description: item.description,
          amount: item.amount,
        })),
      } : null,
    });

  } catch (error) {
    loggers.api.error('Error fetching upcoming invoice', error instanceof Error ? error : undefined);

    if (error instanceof Stripe.errors.StripeError) {
      // No upcoming invoice is common for cancelled subscriptions
      if (error.code === 'invoice_upcoming_none') {
        return NextResponse.json({ invoice: null, message: 'No upcoming invoice' });
      }
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to fetch upcoming invoice' },
      { status: 500 }
    );
  }
}
