import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { db, eq, users } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

/**
 * POST /api/stripe/setup-intent
 * Create a SetupIntent for adding a new payment method.
 * Returns clientSecret for PaymentElement.
 */
export async function POST(request: NextRequest) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2025-08-27.basil',
  });

  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Get user
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Get or create customer
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name || undefined,
        metadata: { userId: user.id },
      });
      customerId = customer.id;

      await db.update(users)
        .set({ stripeCustomerId: customerId, updatedAt: new Date() })
        .where(eq(users.id, userId));
    }

    // Create SetupIntent
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
      metadata: { userId: user.id },
    });

    return NextResponse.json({
      clientSecret: setupIntent.client_secret,
    });

  } catch (error) {
    console.error('Error creating setup intent:', error);

    if (error instanceof Stripe.errors.StripeError) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to create setup intent' },
      { status: 500 }
    );
  }
}
