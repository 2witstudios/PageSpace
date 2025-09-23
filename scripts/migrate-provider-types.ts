#!/usr/bin/env tsx
/**
 * Migration Script: Update Provider Types
 *
 * This script updates existing aiUsageDaily records to use the new provider type naming:
 * - 'normal' → 'standard'
 * - 'extra_thinking' → 'pro'
 *
 * Run with: npx tsx scripts/migrate-provider-types.ts
 */

import { db, aiUsageDaily, eq } from '@pagespace/db';

async function migrateProviderTypes() {
  console.log('🚀 Starting provider type migration...');

  try {
    // Update 'normal' to 'standard'
    const normalResult = await db
      .update(aiUsageDaily)
      .set({ providerType: 'standard' })
      .where(eq(aiUsageDaily.providerType, 'normal'))
      .returning({ id: aiUsageDaily.id });

    console.log(`✅ Updated ${normalResult.length} records from 'normal' to 'standard'`);

    // Update 'extra_thinking' to 'pro'
    const extraThinkingResult = await db
      .update(aiUsageDaily)
      .set({ providerType: 'pro' })
      .where(eq(aiUsageDaily.providerType, 'extra_thinking'))
      .returning({ id: aiUsageDaily.id });

    console.log(`✅ Updated ${extraThinkingResult.length} records from 'extra_thinking' to 'pro'`);

    // Verify migration
    const remainingOldRecords = await db
      .select({
        providerType: aiUsageDaily.providerType,
        count: aiUsageDaily.count
      })
      .from(aiUsageDaily)
      .where(eq(aiUsageDaily.providerType, 'normal'));

    const remainingExtraThinkingRecords = await db
      .select({
        providerType: aiUsageDaily.providerType,
        count: aiUsageDaily.count
      })
      .from(aiUsageDaily)
      .where(eq(aiUsageDaily.providerType, 'extra_thinking'));

    if (remainingOldRecords.length === 0 && remainingExtraThinkingRecords.length === 0) {
      console.log('✅ Migration completed successfully! No old provider types remain.');
    } else {
      console.warn(`⚠️  Warning: Found ${remainingOldRecords.length} 'normal' and ${remainingExtraThinkingRecords.length} 'extra_thinking' records still remaining.`);
    }

    // Show current provider type distribution
    const allRecords = await db
      .select({
        providerType: aiUsageDaily.providerType,
        count: aiUsageDaily.count
      })
      .from(aiUsageDaily);

    const typeCounts = allRecords.reduce((acc, record) => {
      acc[record.providerType] = (acc[record.providerType] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    console.log('📊 Current provider type distribution:', typeCounts);

  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

// Run migration if this script is executed directly
if (require.main === module) {
  migrateProviderTypes()
    .then(() => {
      console.log('🎉 Migration completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Migration failed:', error);
      process.exit(1);
    });
}

export { migrateProviderTypes };