#!/usr/bin/env bun
/**
 * Backfill Script: Mark existing gifted subscriptions in the DB
 *
 * The `gifted` column was added to the `subscriptions` table with DEFAULT false.
 * All existing rows start as false. This script queries Stripe for each
 * subscription not yet marked gifted, checks metadata.type === 'gift_subscription',
 * and sets gifted = true for matches.
 *
 * Run once after deploying the migration:
 *   bun scripts/backfill-gifted-subscriptions.ts [--dry-run]
 *
 * Options:
 *   --dry-run   Report which subscriptions would be updated without writing.
 */

import Stripe from 'stripe';
import { db as defaultDb } from '@pagespace/db/db';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { eq, asc } from '@pagespace/db/operators';

const isDryRun = process.argv.includes('--dry-run');
const BATCH_SIZE = 10;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-02-25.clover',
});

async function run(db = defaultDb) {
  // Only fetch rows not yet marked gifted — safe to re-run, won't re-process
  const rows = await db
    .select({ id: subscriptions.id, stripeSubscriptionId: subscriptions.stripeSubscriptionId })
    .from(subscriptions)
    .where(eq(subscriptions.gifted, false))
    .orderBy(asc(subscriptions.createdAt));

  console.log(`Found ${rows.length} subscription(s) to check.`);

  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (row) => {
      let stripeSub: Stripe.Subscription;
      try {
        stripeSub = await stripe.subscriptions.retrieve(row.stripeSubscriptionId);
      } catch (err) {
        console.warn(`  SKIP ${row.stripeSubscriptionId}: Stripe retrieve failed — ${(err as Error).message}`);
        skipped++;
        return;
      }

      const isGifted = stripeSub.metadata?.type === 'gift_subscription';
      if (!isGifted) return;

      if (isDryRun) {
        console.log(`  DRY-RUN would mark gifted: ${row.stripeSubscriptionId} (db id: ${row.id})`);
      } else {
        await db
          .update(subscriptions)
          .set({ gifted: true })
          .where(eq(subscriptions.id, row.id));
        console.log(`  Marked gifted: ${row.stripeSubscriptionId}`);
      }
      updated++;
    }));

    if (i + BATCH_SIZE < rows.length) {
      console.log(`  Progress: ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}`);
    }
  }

  console.log(`\nDone. ${updated} marked as gifted, ${skipped} skipped.`);
  if (isDryRun) console.log('(dry-run — no writes performed)');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
