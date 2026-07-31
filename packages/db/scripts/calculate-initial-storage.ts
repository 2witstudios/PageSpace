#!/usr/bin/env tsx

/**
 * One-time script to calculate initial storage usage for all users
 * Run this after the migration to populate existing storage data
 *
 * Usage: tsx packages/db/scripts/calculate-initial-storage.ts
 */

import { db } from '../src/db';
import { users } from '../src/schema/auth';
import { files } from '../src/schema/storage';
import { eq, sql } from '../src/operators';
import { config } from 'dotenv';
import path from 'path';

// Load environment variables
config({ path: path.resolve(__dirname, '../../../.env') });

async function calculateInitialStorage() {
  console.log('🔍 Starting initial storage calculation...');

  try {
    // Get all users
    const allUsers = await db.select().from(users);
    console.log(`Found ${allUsers.length} users to process`);

    let processed = 0;
    let errors = 0;

    for (const user of allUsers) {
      try {
        console.log(`\nProcessing user: ${user.email} (${user.id})`);

        // #2155: sum the charge basis — files.sizeBytes over rows this user
        // uploaded (createdBy), across all drives, including trashed-but-unpurged
        // files. This matches what upload-complete charges and what the
        // scheduled reconcile re-derives; the old pages.fileSize basis
        // double-counted deduped blobs and missed channel/DM attachments.
        const result = await db
          .select({
            totalSize: sql<number>`COALESCE(SUM(${files.sizeBytes}), 0)`,
            fileCount: sql<number>`COUNT(*)`
          })
          .from(files)
          .where(eq(files.createdBy, user.id));

        const totalSize = Number(result[0]?.totalSize || 0);
        const fileCount = Number(result[0]?.fileCount || 0);

        console.log(`  Files: ${fileCount}`);
        console.log(`  Total size: ${formatBytes(totalSize)}`);

        // Check if user needs subscription upgrade (log warnings only)
        const currentSubscription = user.subscriptionTier || 'free';
        const freeLimit = 524288000; // 500MB
        const proLimit = 2 * 1024 * 1024 * 1024; // 2GB

        if (totalSize > freeLimit && currentSubscription === 'free') {
          console.log(`  ⚠️ User using ${formatBytes(totalSize)} but has free subscription (${formatBytes(freeLimit)} limit)`);
        } else if (totalSize > proLimit && currentSubscription === 'pro') {
          console.log(`  ⚠️ User using ${formatBytes(totalSize)} but only has pro subscription (${formatBytes(proLimit)} limit)`);
        }

        // Update only storage usage (quota/tier computed from subscription)
        await db.update(users)
          .set({
            storageUsedBytes: totalSize,
            lastStorageCalculated: new Date()
          })
          .where(eq(users.id, user.id));

        const quotaBytes = currentSubscription === 'pro' ? proLimit : freeLimit;
        console.log(`  ✅ Updated: ${formatBytes(totalSize)} / ${formatBytes(quotaBytes)} (${currentSubscription} subscription)`);
        processed++;

        // Log storage event for initial calculation
        await db.insert(storageEvents).values({
          userId: user.id,
          eventType: 'reconcile',
          sizeDelta: totalSize,
          totalSizeAfter: totalSize,
          metadata: {
            type: 'initial_calculation',
            fileCount,
            basis: 'files.sizeBytes by createdBy'
          }
        });

      } catch (error) {
        console.error(`  ❌ Error processing user ${user.email}:`, error);
        errors++;
      }
    }

    console.log('\n' + '='.repeat(50));
    console.log('📊 Storage calculation complete!');
    console.log(`✅ Successfully processed: ${processed} users`);
    if (errors > 0) {
      console.log(`❌ Errors: ${errors} users`);
    }

    // Show summary statistics
    const summary = await db
      .select({
        totalUsers: sql<number>`COUNT(*)`,
        totalStorage: sql<number>`SUM(storage_used_bytes)`,
        avgStorage: sql<number>`AVG(storage_used_bytes)`,
        normalUsers: sql<number>`COUNT(*) FILTER (WHERE subscription_tier = 'free')`,
        proUsers: sql<number>`COUNT(*) FILTER (WHERE subscription_tier = 'pro')`
      })
      .from(users);

    const stats = summary[0];
    console.log('\n📈 Summary Statistics:');
    console.log(`  Total users: ${stats.totalUsers}`);
    console.log(`  Total storage used: ${formatBytes(Number(stats.totalStorage || 0))}`);
    console.log(`  Average per user: ${formatBytes(Number(stats.avgStorage || 0))}`);
    console.log(`  Free subscription users: ${stats.normalUsers}`);
    console.log(`  Pro subscription users: ${stats.proUsers}`);

  } catch (error) {
    console.error('Fatal error during storage calculation:', error);
    process.exit(1);
  }

  process.exit(0);
}

function formatBytes(bytes: number): string {
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0 B';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${Math.round(bytes / Math.pow(1024, i) * 100) / 100} ${sizes[i]}`;
}

// Import storage events table
import { storageEvents } from '../src/schema/core';

// Run the script
calculateInitialStorage().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});