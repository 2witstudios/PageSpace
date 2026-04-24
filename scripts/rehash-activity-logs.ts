#!/usr/bin/env tsx
/**
 * Migration Script: Reset Activity Log Hash Chain (PII Exclusion)
 *
 * Clears the legacy hash chain that included PII fields (userId, actorEmail)
 * in the hash computation. After this script runs, the next logActivity() call
 * will seed a fresh chain using the new PII-free algorithm.
 *
 * Background: The old hash algorithm included userId and actorEmail. When a
 * user is deleted (userId → null, actorEmail → anonymized), those stored
 * hashes become unverifiable. Rather than rehash every row, we reset the
 * chain so all future entries are hashed correctly from the start.
 *
 * What this does:
 *   1. Nulls logHash, previousLogHash, and chainSeed on all existing rows
 *   2. The next logActivity() call detects no prior hash → generates a new
 *      chainSeed and starts a fresh tamper-evident chain
 *
 * Run with: pnpm tsx scripts/rehash-activity-logs.ts
 * Dry run:  pnpm tsx scripts/rehash-activity-logs.ts --dry-run
 */

import 'dotenv/config';
import { db } from '@pagespace/db/db';
import { activityLogs } from '@pagespace/db/schema/monitoring';
import { isNotNull, count, sql } from 'drizzle-orm';

const DRY_RUN = process.argv.includes('--dry-run');

async function resetHashChain(): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log('  Activity Log Hash Chain Reset (PII Exclusion)');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`${'='.repeat(60)}\n`);

  // Count entries with hashes
  const [countResult] = await db
    .select({ total: count() })
    .from(activityLogs)
    .where(isNotNull(activityLogs.logHash));

  const totalEntries = countResult?.total ?? 0;
  console.log(`Found ${totalEntries} entries with existing logHash.`);

  if (totalEntries === 0) {
    console.log('Nothing to reset — chain is already clean.');
    return;
  }

  if (DRY_RUN) {
    console.log(`\nDry run: would null logHash, previousLogHash, chainSeed on ${totalEntries} rows.`);
    console.log('Run without --dry-run to apply.');
    return;
  }

  // Single UPDATE — null all hash chain fields
  const result = await db.execute(
    sql`UPDATE activity_logs SET "logHash" = NULL, "previousLogHash" = NULL, "chainSeed" = NULL WHERE "logHash" IS NOT NULL`
  );

  console.log(`Reset ${totalEntries} rows.`);

  // Verify
  const [verifyResult] = await db
    .select({ remaining: count() })
    .from(activityLogs)
    .where(isNotNull(activityLogs.logHash));

  const remaining = verifyResult?.remaining ?? 0;
  if (remaining === 0) {
    console.log('Verification passed — zero rows with logHash remaining.');
  } else {
    console.error(`Verification FAILED — ${remaining} rows still have logHash.`);
    process.exit(1);
  }

  console.log('\nThe next logActivity() call will seed a fresh PII-free chain.');
}

resetHashChain()
  .then(() => {
    console.log('\nDone.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nFailed:', error);
    process.exit(1);
  });
