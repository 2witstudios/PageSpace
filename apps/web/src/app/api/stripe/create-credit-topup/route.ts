import { NextRequest, NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { stripe, Stripe } from '@/lib/stripe';
import { getOrCreateStripeCustomer } from '@/lib/stripe-customer';
import { getUserFriendlyStripeError } from '@/lib/stripe-errors';
import { getCreditPack, CREDIT_TOPUP_MIN_CENTS, CREDIT_TOPUP_MAX_CENTS } from '@pagespace/lib/billing/credit-pricing';
import { validateTopupAmountCents } from '@pagespace/lib/billing/credit-core';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

function getBaseUrl(request: NextRequest): string {
  return (
    process.env.WEB_APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    new URL(request.url).origin
  );
}

/**
 * POST /api/stripe/create-credit-topup
 *
 * Create a one-time Stripe Checkout session for a prepaid AI-credit top-up pack.
 * Mirrors create-subscription's auth, but uses `mode: 'payment'` with inline
 * `price_data` sourced from `CREDIT_PACKS` and `metadata.kind = 'credit_pack'`, so
 * the existing webhook (`checkout.session.completed` → `applyStripeFunding`) credits
 * the user's never-expiring top-up bucket exactly once. Returns the hosted Checkout
 * URL for the client to redirect to.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const obj = (body && typeof body === 'object' ? body : {}) as { packId?: unknown; amountCents?: unknown };

    // Two ways to buy: a fixed pack by id, OR a custom whole-cent amount. Resolve both
    // to a single { id, cents, label } so the checkout session is built once.
    let purchase: { id: string; cents: number; label: string };
    if (typeof obj.packId === 'string') {
      const pack = getCreditPack(obj.packId);
      if (!pack) {
        return NextResponse.json({ error: 'Unknown credit pack' }, { status: 400 });
      }
      purchase = { id: pack.id, cents: pack.cents, label: pack.label };
    } else if (typeof obj.amountCents === 'number') {
      const cents = validateTopupAmountCents(obj.amountCents, CREDIT_TOPUP_MIN_CENTS, CREDIT_TOPUP_MAX_CENTS);
      if (cents === null) {
        return NextResponse.json(
          {
            error: `Enter an amount between $${CREDIT_TOPUP_MIN_CENTS / 100} and $${CREDIT_TOPUP_MAX_CENTS / 100}.`,
          },
          { status: 400 },
        );
      }
      purchase = { id: 'custom', cents, label: 'Custom' };
    } else {
      return NextResponse.json({ error: 'packId or amountCents is required' }, { status: 400 });
    }

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Attach the purchase to the user's Stripe customer (handles stale customer IDs).
    // The webhook resolves the buyer from metadata.userId regardless, but linking the
    // customer keeps receipts and the billing portal coherent.
    const customerId = await getOrCreateStripeCustomer(user);

    const baseUrl = getBaseUrl(request);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: purchase.cents,
            product_data: {
              name:
                purchase.id === 'custom'
                  ? 'Custom AI credits'
                  : `${purchase.label} (AI credits)`,
              description: 'Prepaid AI credits added to your PageSpace top-up balance.',
            },
          },
        },
      ],
      // Round-tripped verbatim through the signature-verified webhook event; the
      // funding shell trusts metadata.userId and reads packCents to size the top-up
      // (custom amounts arrive the same way — packCents is the chosen amount).
      metadata: {
        kind: 'credit_pack',
        packId: purchase.id,
        packCents: String(purchase.cents),
        userId: user.id,
      },
      // Mirror the metadata onto the resulting PaymentIntent for traceability.
      payment_intent_data: {
        metadata: { kind: 'credit_pack', packId: purchase.id, userId: user.id },
      },
      success_url: `${baseUrl}/settings/usage?credits=success`,
      cancel_url: `${baseUrl}/settings/usage?credits=canceled`,
    });

    if (!session.url) {
      loggers.api.error('No URL on credit top-up checkout session', { sessionId: session.id });
      return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 500 });
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'credit_topup',
      resourceId: session.id,
      details: { action: 'create_checkout', packId: purchase.id, packCents: purchase.cents },
    });

    return NextResponse.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    loggers.api.error(
      'Error creating credit top-up checkout',
      error instanceof Error ? error : undefined,
      { error },
    );

    if (error instanceof Stripe.errors.StripeError) {
      return NextResponse.json({ error: getUserFriendlyStripeError(error) }, { status: 400 });
    }

    return NextResponse.json({ error: 'Failed to create checkout session' }, { status: 500 });
  }
}
