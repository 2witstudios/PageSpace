#!/usr/bin/env tsx

/**
 * Storage Tier Reconciliation Script
 *
 * This script fixes users who have mismatched subscription and storage tiers.
 * This can happen when users are manually promoted via admin panel without
 * triggering the storage tier sync.
 *
 * Usage:
 *   pnpm tsx scripts/fix-storage-tiers.ts [--dry-run]
 */

import { db, eq, users } from '@pagespace/db';
import { updateStorageTierFromSubscription } from '@pagespace/lib/services/storage-limits';

interface MismatchedUser {
  id: string;
  name: string;
  email: string;
  subscriptionTier: string;
  storageTier: string | null;
  storageQuotaBytes: number | null;
}

const EXPECTED_QUOTAS = {
  'normal': 524288000,  // 500MB
  'pro': 2147483648,    // 2GB
};

const EXPECTED_STORAGE_TIERS = {
  'normal': 'free',
  'pro': 'pro',
};

async function findMismatchedUsers(): Promise<MismatchedUser[]> {
  console.log('🔍 Searching for users with mismatched subscription/storage tiers...');

  const allUsers = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      subscriptionTier: users.subscriptionTier,
      storageTier: users.storageTier,
      storageQuotaBytes: users.storageQuotaBytes,
    })
    .from(users);

  const mismatched: MismatchedUser[] = [];

  for (const user of allUsers) {
    const expectedStorageTier = EXPECTED_STORAGE_TIERS[user.subscriptionTier as keyof typeof EXPECTED_STORAGE_TIERS];
    const expectedQuota = EXPECTED_QUOTAS[user.subscriptionTier as keyof typeof EXPECTED_QUOTAS];

    const hasWrongStorageTier = user.storageTier !== expectedStorageTier;
    const hasWrongQuota = user.storageQuotaBytes !== expectedQuota;

    if (hasWrongStorageTier || hasWrongQuota) {
      mismatched.push({
        id: user.id,
        name: user.name || 'Unknown',
        email: user.email,
        subscriptionTier: user.subscriptionTier,
        storageTier: user.storageTier,
        storageQuotaBytes: user.storageQuotaBytes,
      });
    }
  }

  return mismatched;
}

function formatBytes(bytes: number): string {
  if (bytes === 524288000) return '500MB';
  if (bytes === 2147483648) return '2GB';
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

async function fixUser(user: MismatchedUser, dryRun: boolean): Promise<{ success: boolean; error?: string }> {
  try {
    if (dryRun) {
      console.log(`  [DRY RUN] Would fix user: ${user.name} (${user.email})`);
      return { success: true };
    }

    console.log(`  🔧 Fixing user: ${user.name} (${user.email})`);

    await updateStorageTierFromSubscription(
      user.id,
      user.subscriptionTier as 'normal' | 'pro'
    );

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  console.log('🚀 Storage Tier Reconciliation Script');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('');

  try {
    const mismatchedUsers = await findMismatchedUsers();

    if (mismatchedUsers.length === 0) {
      console.log('✅ No mismatched users found! All storage tiers are correct.');
      return;
    }

    console.log(`Found ${mismatchedUsers.length} users with mismatched storage tiers:`);
    console.log('');

    // Display all mismatched users first
    for (const user of mismatchedUsers) {
      const expectedStorageTier = EXPECTED_STORAGE_TIERS[user.subscriptionTier as keyof typeof EXPECTED_STORAGE_TIERS];
      const expectedQuota = EXPECTED_QUOTAS[user.subscriptionTier as keyof typeof EXPECTED_QUOTAS];

      console.log(`❌ ${user.name} (${user.email})`);
      console.log(`   Subscription: ${user.subscriptionTier}`);
      console.log(`   Storage Tier: ${user.storageTier} → should be ${expectedStorageTier}`);
      console.log(`   Storage Quota: ${user.storageQuotaBytes ? formatBytes(user.storageQuotaBytes) : 'null'} → should be ${formatBytes(expectedQuota)}`);
      console.log('');
    }

    if (dryRun) {
      console.log('📋 This was a dry run. No changes were made.');
      console.log('To actually fix these users, run:');
      console.log('  pnpm tsx scripts/fix-storage-tiers.ts');
      return;
    }

    // Ask for confirmation in live mode
    console.log(`⚠️  About to fix ${mismatchedUsers.length} users. Continue? (y/N)`);

    // Simple confirmation for script usage
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const answer = await new Promise<string>((resolve) => {
      rl.question('', (answer: string) => {
        rl.close();
        resolve(answer.toLowerCase());
      });
    });

    if (answer !== 'y' && answer !== 'yes') {
      console.log('❌ Cancelled by user.');
      return;
    }

    console.log('');
    console.log('🔧 Fixing users...');

    // Fix each user
    const results = [];
    for (const user of mismatchedUsers) {
      const result = await fixUser(user, dryRun);
      results.push({ user, ...result });

      // Small delay to be gentle on the database
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Summary
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    console.log('');
    console.log('📊 Summary:');
    console.log(`✅ Successfully fixed: ${successful.length} users`);

    if (failed.length > 0) {
      console.log(`❌ Failed to fix: ${failed.length} users`);
      console.log('');
      console.log('Failed users:');
      for (const failure of failed) {
        console.log(`  - ${failure.user.name}: ${failure.error}`);
      }
    }

  } catch (error) {
    console.error('💥 Script failed:', error);
    process.exit(1);
  }
}

// Run if this file is executed directly
if (require.main === module) {
  main()
    .then(() => {
      console.log('');
      console.log('✅ Script completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Script failed:', error);
      process.exit(1);
    });
}