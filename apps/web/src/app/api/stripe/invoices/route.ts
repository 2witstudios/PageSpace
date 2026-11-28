import { NextRequest, NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { stripe, Stripe } from '@/lib/stripe';
import { tierFromInvoiceLines } from '@/lib/stripe/price-config';
import { completeInvoiceLines } from '@/lib/stripe/invoice-lines';
import { PLANS } from '@/lib/subscription/plans';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { parseBoundedIntParam } from '@/lib/utils/query-params';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

/**
 * Get a friendly plan name from invoice line items.
 * Resolves the configured plan across all subscription lines, including prorations.
 * Falls back to Stripe's description if plan can't be determined.
 */
function getInvoiceDescription(invoice: Stripe.Invoice): string {
  const tier = tierFromInvoiceLines(invoice.lines.data);
  if (tier && tier !== 'free') {
    return PLANS[tier].displayName;
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
    const limit = parseBoundedIntParam(searchParams.get('limit'), {
      defaultValue: 10,
      min: 1,
      max: 100,
    });
    const startingAfter = searchParams.get('starting_after') || undefined;

    // Get user
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (!user.stripeCustomerId) {
      auditRequest(request, { eventType: 'data.read', userId, resourceType: 'invoices', resourceId: 'list', details: { count: 0, hasCustomer: false } });
      return NextResponse.json({ invoices: [], hasMore: false });
    }

    // List invoices
    const invoices = await stripe.invoices.list({
      customer: user.stripeCustomerId,
      limit,
      starting_after: startingAfter,
    });

    const completeInvoices = await Promise.all(invoices.data.map(completeInvoiceLines));
    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'invoices', resourceId: 'list', details: { count: completeInvoices.length } });

    return NextResponse.json({
      invoices: completeInvoices.map(invoice => ({
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
