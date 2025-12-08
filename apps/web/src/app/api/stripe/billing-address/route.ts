import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { db, eq, users } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS_READ = { allow: ['jwt'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['jwt'] as const, requireCSRF: true };

/**
 * GET /api/stripe/billing-address
 * Get the billing address for the current user.
 */
export async function GET(request: NextRequest) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2025-08-27.basil',
  });

  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Get user
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (!user.stripeCustomerId) {
      return NextResponse.json({ address: null, name: user.name, email: user.email });
    }

    // Get customer
    const customer = await stripe.customers.retrieve(user.stripeCustomerId);
    if (customer.deleted) {
      return NextResponse.json({ address: null, name: user.name, email: user.email });
    }

    return NextResponse.json({
      address: customer.address,
      name: customer.name || user.name,
      email: customer.email || user.email,
    });

  } catch (error) {
    console.error('Error fetching billing address:', error);
    return NextResponse.json(
      { error: 'Failed to fetch billing address' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/stripe/billing-address
 * Update the billing address for the current user.
 * Body: { name?: string, address: { line1, line2?, city, state, postal_code, country } }
 */
export async function PUT(request: NextRequest) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2025-08-27.basil',
  });

  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const body = await request.json();
    const { name, address } = body;

    // Validate address
    if (!address || !address.line1 || !address.city || !address.country) {
      return NextResponse.json(
        { error: 'Address line1, city, and country are required' },
        { status: 400 }
      );
    }

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
        name: name || user.name || undefined,
        address: {
          line1: address.line1,
          line2: address.line2 || undefined,
          city: address.city,
          state: address.state || undefined,
          postal_code: address.postal_code || undefined,
          country: address.country,
        },
        metadata: { userId: user.id },
      });
      customerId = customer.id;

      await db.update(users)
        .set({ stripeCustomerId: customerId, updatedAt: new Date() })
        .where(eq(users.id, userId));

      return NextResponse.json({
        success: true,
        address: customer.address,
        name: customer.name,
      });
    }

    // Update existing customer
    const customer = await stripe.customers.update(customerId, {
      name: name || undefined,
      address: {
        line1: address.line1,
        line2: address.line2 || undefined,
        city: address.city,
        state: address.state || undefined,
        postal_code: address.postal_code || undefined,
        country: address.country,
      },
    });

    return NextResponse.json({
      success: true,
      address: customer.address,
      name: customer.name,
    });

  } catch (error) {
    console.error('Error updating billing address:', error);

    if (error instanceof Stripe.errors.StripeError) {
      return NextResponse.json(
        { error: error.message },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: 'Failed to update billing address' },
      { status: 500 }
    );
  }
}
