#!/usr/bin/env tsx

/**
 * One-time script to calculate initial storage usage for all users
 * Run this after the migration to populate existing storage data
 *
 * Usage: tsx packages/db/scripts/calculate-initial-storage.ts
 */

import { db, users, pages, drives, eq, and, isNull, sql, inArray } from '../src';
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

        // Get all drives owned by this user
        const userDrives = await db.query.drives.findMany({
          where: eq(drives.ownerId, user.id),
          columns: { id: true, name: true }
        });

        if (userDrives.length === 0) {
          console.log(`  No drives found for user ${user.email}`);
          // Set storage to 0 for users with no drives
          await db.update(users)
            .set({
              storageUsedBytes: 0,
              storageQuotaBytes: 524288000, // 500MB default
              storageTier: 'free',
              lastStorageCalculated: new Date()
            })
            .where(eq(users.id, user.id));
          processed++;
          continue;
        }

        console.log(`  Found ${userDrives.length} drives`);
        const driveIds = userDrives.map(d => d.id);

        // Calculate total file size across all user's drives
        const result = await db
          .select({
            totalSize: sql<number>`COALESCE(SUM(CAST(${pages.fileSize} AS BIGINT)), 0)`,
            fileCount: sql<number>`COUNT(*)`
          })
          .from(pages)
          .where(and(
            inArray(pages.driveId, driveIds),
            eq(pages.type, 'FILE'),
            eq(pages.isTrashed, false)
          ));

        const totalSize = Number(result[0]?.totalSize || 0);
        const fileCount = Number(result[0]?.fileCount || 0);

        console.log(`  Files: ${fileCount}`);
        console.log(`  Total size: ${formatBytes(totalSize)}`);

        // Determine appropriate tier based on current usage
        let tier: 'free' | 'pro' | 'enterprise' = 'free';
        let quotaBytes = 524288000; // 500MB default

        // If user already has more than free tier limit, upgrade them
        if (totalSize > 524288000) { // > 500MB
          if (totalSize > 2 * 1024 * 1024 * 1024) { // > 2GB
            tier = 'enterprise';
            quotaBytes = 10 * 1024 * 1024 * 1024; // 10GB
            console.log(`  ⚠️ User needs enterprise tier (using ${formatBytes(totalSize)})`);
          } else {
            tier = 'pro';
            quotaBytes = 2 * 1024 * 1024 * 1024; // 2GB
            console.log(`  ⚠️ User needs pro tier (using ${formatBytes(totalSize)})`);
          }
        }

        // Update user's storage information
        await db.update(users)
          .set({
            storageUsedBytes: totalSize,
            storageQuotaBytes: quotaBytes,
            storageTier: tier,
            activeUploads: 0,
            lastStorageCalculated: new Date()
          })
          .where(eq(users.id, user.id));

        console.log(`  ✅ Updated: ${formatBytes(totalSize)} / ${formatBytes(quotaBytes)} (${tier} tier)`);
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
            drives: userDrives.map(d => ({ id: d.id, name: d.name }))
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
        freeUsers: sql<number>`COUNT(*) FILTER (WHERE storage_tier = 'free')`,
        proUsers: sql<number>`COUNT(*) FILTER (WHERE storage_tier = 'pro')`,
        enterpriseUsers: sql<number>`COUNT(*) FILTER (WHERE storage_tier = 'enterprise')`
      })
      .from(users);

    const stats = summary[0];
    console.log('\n📈 Summary Statistics:');
    console.log(`  Total users: ${stats.totalUsers}`);
    console.log(`  Total storage used: ${formatBytes(Number(stats.totalStorage || 0))}`);
    console.log(`  Average per user: ${formatBytes(Number(stats.avgStorage || 0))}`);
    console.log(`  Free tier users: ${stats.freeUsers}`);
    console.log(`  Pro tier users: ${stats.proUsers}`);
    console.log(`  Enterprise tier users: ${stats.enterpriseUsers}`);

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