#!/usr/bin/env tsx

/**
 * Migration script to convert legacy encryption format to current format.
 *
 * Scans user_ai_settings.encryptedApiKey for legacy 3-part format entries
 * and re-encrypts them using the current 4-part format with unique per-operation salt.
 *
 * Usage:
 *   - Dry run (report only, no changes): tsx packages/db/scripts/migrate-legacy-encryption.ts --dry-run
 *   - Live migration: tsx packages/db/scripts/migrate-legacy-encryption.ts
 *
 * Environment requirements:
 *   - DATABASE_URL: Connection string to the database
 *   - ENCRYPTION_KEY: Master encryption key (required for re-encryption)
 *   - ENCRYPTION_SALT: Legacy static salt (required to decrypt legacy entries)
 */

import { db, userAiSettings, eq } from '../src';
import { isLegacyFormat, reEncrypt } from '../../lib/src/encryption';
import { config } from 'dotenv';
import path from 'path';

// Load environment variables
config({ path: path.resolve(__dirname, '../../../.env') });

interface MigrationStats {
  total: number;
  legacy: number;
  migrated: number;
  skipped: number;
  errors: number;
}

interface RowToMigrate {
  id: string;
  userId: string;
  provider: string;
  encryptedApiKey: string;
}

async function migrateLegacyEncryption(dryRun: boolean): Promise<void> {
  const mode = dryRun ? 'DRY RUN' : 'LIVE';
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Legacy Encryption Migration Script (${mode})`);
  console.log(`${'='.repeat(60)}\n`);

  // Validate environment
  if (!process.env.ENCRYPTION_KEY) {
    console.error('ERROR: ENCRYPTION_KEY environment variable is required');
    process.exit(1);
  }

  const stats: MigrationStats = {
    total: 0,
    legacy: 0,
    migrated: 0,
    skipped: 0,
    errors: 0,
  };

  try {
    // Fetch all rows with encrypted API keys
    console.log('Scanning user_ai_settings for encrypted API keys...\n');

    const rows = await db
      .select({
        id: userAiSettings.id,
        userId: userAiSettings.userId,
        provider: userAiSettings.provider,
        encryptedApiKey: userAiSettings.encryptedApiKey,
      })
      .from(userAiSettings);

    stats.total = rows.length;
    console.log(`Found ${stats.total} total records with encrypted API keys\n`);

    if (stats.total === 0) {
      console.log('No records to process. Exiting.\n');
      return;
    }

    // Identify legacy format entries
    const legacyRows: RowToMigrate[] = [];
    for (const row of rows) {
      if (row.encryptedApiKey && isLegacyFormat(row.encryptedApiKey)) {
        legacyRows.push(row as RowToMigrate);
      }
    }

    stats.legacy = legacyRows.length;
    console.log(`Found ${stats.legacy} records using legacy encryption format`);
    console.log(`Found ${stats.total - stats.legacy} records already using current format\n`);

    if (stats.legacy === 0) {
      console.log('No legacy format entries found. Nothing to migrate.\n');
      printSummary(stats, dryRun);
      return;
    }

    // Process each legacy entry
    console.log(`${'─'.repeat(60)}`);
    console.log(dryRun ? 'Analyzing entries (no changes will be made)...\n' : 'Migrating entries...\n');

    for (let i = 0; i < legacyRows.length; i++) {
      const row = legacyRows[i];
      const progress = `[${i + 1}/${stats.legacy}]`;

      try {
        const result = await reEncrypt(row.encryptedApiKey);

        if (result.migrated) {
          if (dryRun) {
            console.log(`${progress} Would migrate: user=${row.userId.substring(0, 8)}... provider=${row.provider}`);
            stats.migrated++;
          } else {
            // Perform the update
            await db
              .update(userAiSettings)
              .set({
                encryptedApiKey: result.encryptedText,
                updatedAt: new Date(),
              })
              .where(eq(userAiSettings.id, row.id));

            console.log(`${progress} Migrated: user=${row.userId.substring(0, 8)}... provider=${row.provider}`);
            stats.migrated++;
          }
        } else {
          // This shouldn't happen since we filtered for legacy format, but handle it anyway
          console.log(`${progress} Skipped (already current format): user=${row.userId.substring(0, 8)}... provider=${row.provider}`);
          stats.skipped++;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`${progress} ERROR for user=${row.userId.substring(0, 8)}... provider=${row.provider}: ${errorMessage}`);
        stats.errors++;
      }
    }

    console.log(`\n${'─'.repeat(60)}`);
    printSummary(stats, dryRun);

  } catch (error) {
    console.error('\nFatal error during migration:', error);
    process.exit(1);
  }
}

function printSummary(stats: MigrationStats, dryRun: boolean): void {
  console.log('\nMigration Summary:');
  console.log(`${'─'.repeat(40)}`);
  console.log(`  Total records scanned:     ${stats.total}`);
  console.log(`  Legacy format entries:     ${stats.legacy}`);
  console.log(`  Current format entries:    ${stats.total - stats.legacy}`);
  console.log(`${'─'.repeat(40)}`);

  if (dryRun) {
    console.log(`  Would migrate:             ${stats.migrated}`);
    console.log(`  Would skip:                ${stats.skipped}`);
    console.log(`  Errors detected:           ${stats.errors}`);
    console.log(`\n  This was a DRY RUN. No changes were made.`);
    console.log(`  Run without --dry-run to perform the migration.\n`);
  } else {
    console.log(`  Successfully migrated:     ${stats.migrated}`);
    console.log(`  Skipped:                   ${stats.skipped}`);
    console.log(`  Errors:                    ${stats.errors}`);

    if (stats.errors > 0) {
      console.log(`\n  WARNING: Some entries failed to migrate.`);
      console.log(`  Review the errors above and address them before re-running.\n`);
    } else {
      console.log(`\n  Migration completed successfully!\n`);
    }
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || args.includes('-n');

// Run the migration
migrateLegacyEncryption(dryRun)
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
