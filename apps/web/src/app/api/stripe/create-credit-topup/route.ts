import { NextRequest, NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { stripe, Stripe } from '@/lib/stripe';
import { getOrCreateStripeCustomer } from '@/lib/stripe-customer';
import { getUserFriendlyStripeError } from '@/lib/stripe-errors';
import {
  getCreditPack,
  creditPackPriceCents,
  validateTopupCredits,
  centsFromCredits,
  formatCreditCount,
  formatDollars,
  CREDIT_TOPUP_MIN_CREDITS,
  CREDIT_TOPUP_MAX_CREDITS,
} from '@pagespace/lib/billing/money-model';
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
 * `price_data` priced from the money model (MON-4: credits at CREDITS_PER_DOLLAR, no
 * ratio) and `metadata.kind = 'credit_pack'`, so
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

    const obj = (body && typeof body === 'object' ? body : {}) as { packId?: unknown; credits?: unknown };

    // Two ways to buy: a fixed pack by id, OR a custom credit count. Resolve both to a
    // single { id, credits, cents, label } so the checkout session is built once; the
    // price is the money model's rate applied to the credits, never a stored figure.
    let purchase: { id: string; credits: number; cents: number; label: string };
    if (typeof obj.packId === 'string') {
      const pack = getCreditPack(obj.packId);
      if (!pack) {
        return NextResponse.json({ error: 'Unknown credit pack' }, { status: 400 });
      }
      purchase = { id: pack.id, credits: pack.credits, cents: creditPackPriceCents(pack), label: pack.label };
    } else if (typeof obj.credits === 'number') {
      const credits = validateTopupCredits(obj.credits);
      if (credits === null) {
        const min = centsFromCredits(CREDIT_TOPUP_MIN_CREDITS);
        const max = centsFromCredits(CREDIT_TOPUP_MAX_CREDITS);
        return NextResponse.json(
          {
            error: `Enter between ${formatCreditCount(min)} and ${formatCreditCount(max)} credits (${formatDollars(min)} to ${formatDollars(max)}).`,
          },
          { status: 400 },
        );
      }
      purchase = { id: 'custom', credits, cents: centsFromCredits(credits), label: 'Custom' };
    } else {
      return NextResponse.json({ error: 'packId or credits is required' }, { status: 400 });
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
                  ? 'Custom credits'
                  : `${purchase.label} (credits)`,
              description: 'Prepaid credits added to your PageSpace top-up balance.',
            },
          },
        },
      ],
      // Round-tripped verbatim through the signature-verified webhook event; the
      // funding shell trusts metadata.userId and reads packCents (the credit VALUE in
      // cents, which is what the ledger stores) to size the top-up. Custom amounts
      // arrive the same way. packCredits is the count the buyer chose, for tracing.
      metadata: {
        kind: 'credit_pack',
        packId: purchase.id,
        packCents: String(purchase.cents),
        packCredits: String(purchase.credits),
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
      details: { action: 'create_checkout', packId: purchase.id, packCredits: purchase.credits, packCents: purchase.cents },
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
