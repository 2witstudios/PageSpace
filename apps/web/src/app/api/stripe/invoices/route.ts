import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { db, eq, users } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: false };

/**
 * GET /api/stripe/invoices
 * List invoices for the current user with pagination.
 * Query params:
 * - limit: number (default 10)
 * - starting_after: string (invoice ID for pagination)
 */
export async function GET(request: NextRequest) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2025-08-27.basil',
  });

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
        description: invoice.description || invoice.lines.data[0]?.description,
      })),
      hasMore: invoices.has_more,
    });

  } catch (error) {
    console.error('Error listing invoices:', error);

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
