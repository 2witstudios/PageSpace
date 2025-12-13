#!/usr/bin/env tsx
/**
 * Sync legacy users (tier set in DB but no Stripe subscription) to Stripe.
 * Creates gift subscriptions with 100% discount coupons.
 *
 * Usage:
 *   Local: pnpm tsx scripts/sync-legacy-subscriptions.ts
 *   Docker: docker exec pagespace-web-1 pnpm tsx scripts/sync-legacy-subscriptions.ts
 */

import 'dotenv/config';
import Stripe from 'stripe';
import { db, users, subscriptions, eq, and, inArray, ne } from '@pagespace/db';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-08-27.basil',
});

// Price IDs from stripe-config.ts
const PRICE_IDS: Record<string, string> = {
  pro: 'price_1Sdbh6PCGvbSozob1IBfmSuv',
  founder: 'price_1SdbhePCGvbSozobuNjSn5j0',
  business: 'price_1SdbhfPCGvbSozobpTMXfqkX',
};

async function main() {
  console.log('Finding legacy users (tier != free, no active subscription)...\n');

  // Find legacy users: tier != 'free' AND no subscription record
  const allUsers = await db.select().from(users).where(ne(users.subscriptionTier, 'free'));

  const legacyUsers = [];
  for (const user of allUsers) {
    const [sub] = await db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, user.id), inArray(subscriptions.status, ['active', 'trialing'])))
      .limit(1);

    if (!sub) legacyUsers.push(user);
  }

  console.log(`Found ${legacyUsers.length} legacy users to sync\n`);

  if (legacyUsers.length === 0) {
    console.log('No legacy users to sync. All done!');
    return;
  }

  for (const user of legacyUsers) {
    try {
      const tier = user.subscriptionTier as 'pro' | 'founder' | 'business';
      const priceId = PRICE_IDS[tier];

      if (!priceId) {
        console.log(`⚠️  Skipping ${user.email}: unknown tier "${tier}"`);
        continue;
      }

      // Get or create Stripe customer
      let customerId = user.stripeCustomerId;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          name: user.name || undefined,
          metadata: { userId: user.id },
        });
        customerId = customer.id;
        await db
          .update(users)
          .set({ stripeCustomerId: customerId, updatedAt: new Date() })
          .where(eq(users.id, user.id));
        console.log(`   Created Stripe customer for ${user.email}`);
      }

      // Create 100% discount coupon
      const coupon = await stripe.coupons.create({
        id: `LEGACY_SYNC_${user.id}_${Date.now()}`,
        percent_off: 100,
        duration: 'forever',
        max_redemptions: 1,
        name: `Legacy sync for ${user.email}`,
        metadata: { userId: user.id, type: 'legacy_sync' },
      });

      // Create subscription
      const subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: priceId }],
        discounts: [{ coupon: coupon.id }],
        metadata: {
          userId: user.id,
          type: 'gift_subscription',
          reason: 'Legacy tier sync',
        },
      });

      console.log(`✅ ${user.email}: Created ${tier} subscription (${subscription.id})`);
    } catch (error) {
      console.error(`❌ ${user.email}: Failed -`, error instanceof Error ? error.message : error);
    }
  }

  console.log('\n✅ Sync complete! Stripe webhooks will update the database.');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });
