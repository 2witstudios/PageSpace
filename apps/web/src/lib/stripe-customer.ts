/**
 * Shared Stripe customer utilities.
 * Handles stale customer IDs that may no longer exist in Stripe.
 */

import { db, eq, users } from '@pagespace/db';
import { stripe, Stripe } from '@/lib/stripe';

interface UserForCustomer {
  id: string;
  email: string;
  name: string | null;
  stripeCustomerId: string | null;
}

/**
 * Get or create a Stripe customer for a user.
 * Handles stale customer IDs that no longer exist in Stripe.
 *
 * If the stored stripeCustomerId is invalid (customer was deleted or doesn't exist),
 * this function will create a new customer and update the database.
 */
export async function getOrCreateStripeCustomer(user: UserForCustomer): Promise<string> {
  let customerId = user.stripeCustomerId;

  // Verify existing customer still exists in Stripe
  if (customerId) {
    try {
      const customer = await stripe.customers.retrieve(customerId);
      // Stripe returns { deleted: true } for deleted customers instead of throwing
      if (customer.deleted) {
        customerId = null;
      }
    } catch (error) {
      if (
        error instanceof Stripe.errors.StripeError &&
        error.code === 'resource_missing'
      ) {
        // Customer doesn't exist in Stripe, clear it and create new
        customerId = null;
      } else {
        throw error;
      }
    }
  }

  // Create new customer if needed
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: user.name || undefined,
      metadata: { userId: user.id },
    });
    customerId = customer.id;

    // Update database with new customer ID
    await db
      .update(users)
      .set({ stripeCustomerId: customerId, updatedAt: new Date() })
      .where(eq(users.id, user.id));
  }

  return customerId;
}
