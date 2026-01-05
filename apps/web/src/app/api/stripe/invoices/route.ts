import { NextRequest, NextResponse } from 'next/server';
import { db, eq, users } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { stripe, Stripe } from '@/lib/stripe';
import { getTierFromPrice } from '@/lib/stripe/price-config';
import { PLANS } from '@/lib/subscription/plans';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: false };

/**
 * Get a friendly plan name from invoice line items.
 * For proration invoices, finds the new plan (positive amount line).
 * Falls back to Stripe's description if plan can't be determined.
 */
function getInvoiceDescription(invoice: Stripe.Invoice): string {
  // Filter to subscription-related line items with pricing info
  const subscriptionLines = invoice.lines.data.filter(
    line => line.parent?.subscription_item_details && line.pricing?.price_details?.price
  );

  // Prefer the positive-amount line (new plan charge) over credits
  const targetLine = subscriptionLines.find(line => line.amount > 0)
    || subscriptionLines[0];

  const priceData = targetLine?.pricing?.price_details?.price;
  // In Stripe v20, price can be a string ID or expanded Price object
  const priceId = typeof priceData === 'string' ? priceData : priceData?.id;
  if (priceId) {
    // Parse unit_amount_decimal to get cents for fallback tier detection
    const unitAmount = targetLine.pricing?.unit_amount_decimal
      ? Math.round(parseFloat(targetLine.pricing.unit_amount_decimal) * 100)
      : null;
    const tier = getTierFromPrice(priceId, unitAmount);
    if (tier !== 'free') {
      return PLANS[tier].displayName;
    }
  }

  return invoice.description || invoice.lines.data[0]?.description || 'Subscription';
}

/**
 * GET /api/stripe/invoices
 * List invoices for the current user with pagination.
 * Query params:
 * - limit: number (default 10)
 * - starting_after: string (invoice ID for pagination)
 */
export async function GET(request: NextRequest) {

  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '10'), 100);
    const startingAfter = searchParams.get('starting_after') || undefined;

    // Get user
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (!user.stripeCustomerId) {
      return NextResponse.json({ invoices: [], hasMore: false });
    }

    // List invoices
    const invoices = await stripe.invoices.list({
      customer: user.stripeCustomerId,
      limit,
      starting_after: startingAfter,
    });

    return NextResponse.json({
      invoices: invoices.data.map(invoice => ({
        id: invoice.id,
        number: invoice.number,
        status: invoice.status,
        amountDue: invoice.amount_due,
        amountPaid: invoice.amount_paid,
        currency: invoice.currency,
        created: new Date(invoice.created * 1000).toISOString(),
        periodStart: invoice.period_start
          ? new Date(invoice.period_start * 1000).toISOString()
          : null,
        periodEnd: invoice.period_end
          ? new Date(invoice.period_end * 1000).toISOString()
          : null,
        hostedInvoiceUrl: invoice.hosted_invoice_url,
        invoicePdf: invoice.invoice_pdf,
        description: getInvoiceDescription(invoice),
      })),
      hasMore: invoices.has_more,
    });

  } catch (error) {
    loggers.api.error('Error listing invoices', error instanceof Error ? error : undefined);

    if (error instanceof Stripe.errors.StripeError) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to list invoices' },
      { status: 500 }
    );
  }
}
