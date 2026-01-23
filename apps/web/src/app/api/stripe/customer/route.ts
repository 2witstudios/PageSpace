import { NextRequest, NextResponse } from 'next/server';
import { db, eq, users } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { stripe } from '@/lib/stripe';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

/**
 * GET /api/stripe/customer
 * Get current user's Stripe customer details
 */
export async function GET(request: NextRequest) {

  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Get user with stripe customer ID
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (!user.stripeCustomerId) {
      return NextResponse.json({ customer: null });
    }

    // Fetch customer from Stripe
    const customer = await stripe.customers.retrieve(user.stripeCustomerId);

    if (customer.deleted) {
      // Customer was deleted in Stripe, clear the reference
      await db.update(users)
        .set({ stripeCustomerId: null, updatedAt: new Date() })
        .where(eq(users.id, userId));
      return NextResponse.json({ customer: null });
    }

    return NextResponse.json({
      customer: {
        id: customer.id,
        email: customer.email,
        name: customer.name,
        address: customer.address,
        defaultPaymentMethod: customer.invoice_settings?.default_payment_method,
      },
    });

  } catch (error) {
    loggers.api.error('Error fetching Stripe customer', error instanceof Error ? error : undefined);
    return NextResponse.json(
      { error: 'Failed to fetch customer' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/stripe/customer
 * Create or get Stripe customer for current user
 */
export async function POST(request: NextRequest) {

  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Get user
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // If customer already exists, return it
    if (user.stripeCustomerId) {
      try {
        const existingCustomer = await stripe.customers.retrieve(user.stripeCustomerId);
        if (!existingCustomer.deleted) {
          return NextResponse.json({
            customer: {
              id: existingCustomer.id,
              email: existingCustomer.email,
              name: existingCustomer.name,
              address: existingCustomer.address,
              defaultPaymentMethod: existingCustomer.invoice_settings?.default_payment_method,
            },
            created: false,
          });
        }
      } catch {
        // Customer doesn't exist in Stripe, will create new one
      }
    }

    // Create new Stripe customer
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.name || undefined,
      metadata: {
        userId: user.id,
      },
    });

    // Save customer ID to user with rollback on failure
    try {
      await db.update(users)
        .set({ stripeCustomerId: customer.id, updatedAt: new Date() })
        .where(eq(users.id, userId));
    } catch (dbError) {
      // Rollback: delete the orphaned Stripe customer
      await stripe.customers.del(customer.id);
      throw dbError;
    }

    return NextResponse.json({
      customer: {
        id: customer.id,
        email: customer.email,
        name: customer.name,
        address: customer.address,
        defaultPaymentMethod: null,
      },
      created: true,
    });

  } catch (error) {
    loggers.api.error('Error creating Stripe customer', error instanceof Error ? error : undefined);
    return NextResponse.json(
      { error: 'Failed to create customer' },
      { status: 500 }
    );
  }
}
