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

// Load environment variables (skip in test environment)
if (process.env.NODE_ENV !== 'test') {
  config({ path: path.resolve(__dirname, '../../../.env') });
}

export interface MigrationStats {
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

export interface MigrationOptions {
  dryRun: boolean;
  quiet?: boolean; // Suppress console output (useful for testing)
}

export async function migrateLegacyEncryption(options: MigrationOptions): Promise<MigrationStats> {
  const { dryRun, quiet = false } = options;
  const log = quiet ? () => {} : console.log;
  const logError = quiet ? () => {} : console.error;

  const mode = dryRun ? 'DRY RUN' : 'LIVE';
  log(`\n${'='.repeat(60)}`);
  log(`  Legacy Encryption Migration Script (${mode})`);
  log(`${'='.repeat(60)}\n`);

  // Validate environment
  if (!process.env.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY environment variable is required');
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
    log('Scanning user_ai_settings for encrypted API keys...\n');

    const rows = await db
      .select({
        id: userAiSettings.id,
        userId: userAiSettings.userId,
        provider: userAiSettings.provider,
        encryptedApiKey: userAiSettings.encryptedApiKey,
      })
      .from(userAiSettings);

    stats.total = rows.length;
    log(`Found ${stats.total} total records with encrypted API keys\n`);

    if (stats.total === 0) {
      log('No records to process. Exiting.\n');
      return stats;
    }

    // Identify legacy format entries
    const legacyRows: RowToMigrate[] = [];
    for (const row of rows) {
      if (row.encryptedApiKey && isLegacyFormat(row.encryptedApiKey)) {
        legacyRows.push(row as RowToMigrate);
      }
    }

    stats.legacy = legacyRows.length;
    log(`Found ${stats.legacy} records using legacy encryption format`);
    log(`Found ${stats.total - stats.legacy} records already using current format\n`);

    if (stats.legacy === 0) {
      log('No legacy format entries found. Nothing to migrate.\n');
      printSummary(stats, dryRun, quiet);
      return stats;
    }

    // Process each legacy entry
    log(`${'─'.repeat(60)}`);
    log(dryRun ? 'Analyzing entries (no changes will be made)...\n' : 'Migrating entries...\n');

    for (let i = 0; i < legacyRows.length; i++) {
      const row = legacyRows[i];
      const progress = `[${i + 1}/${stats.legacy}]`;

      try {
        const result = await reEncrypt(row.encryptedApiKey);

        if (result.migrated) {
          if (dryRun) {
            log(`${progress} Would migrate: user=${row.userId.substring(0, 8)}... provider=${row.provider}`);
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

            log(`${progress} Migrated: user=${row.userId.substring(0, 8)}... provider=${row.provider}`);
            stats.migrated++;
          }
        } else {
          // This shouldn't happen since we filtered for legacy format, but handle it anyway
          log(`${progress} Skipped (already current format): user=${row.userId.substring(0, 8)}... provider=${row.provider}`);
          stats.skipped++;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logError(`${progress} ERROR for user=${row.userId.substring(0, 8)}... provider=${row.provider}: ${errorMessage}`);
        stats.errors++;
      }
    }

    log(`\n${'─'.repeat(60)}`);
    printSummary(stats, dryRun, quiet);
    return stats;

  } catch (error) {
    logError('\nFatal error during migration:', error);
    throw error;
  }
}

function printSummary(stats: MigrationStats, dryRun: boolean, quiet = false): void {
  const log = quiet ? () => {} : console.log;

  log('\nMigration Summary:');
  log(`${'─'.repeat(40)}`);
  log(`  Total records scanned:     ${stats.total}`);
  log(`  Legacy format entries:     ${stats.legacy}`);
  log(`  Current format entries:    ${stats.total - stats.legacy}`);
  log(`${'─'.repeat(40)}`);

  if (dryRun) {
    log(`  Would migrate:             ${stats.migrated}`);
    log(`  Would skip:                ${stats.skipped}`);
    log(`  Errors detected:           ${stats.errors}`);
    log(`\n  This was a DRY RUN. No changes were made.`);
    log(`  Run without --dry-run to perform the migration.\n`);
  } else {
    log(`  Successfully migrated:     ${stats.migrated}`);
    log(`  Skipped:                   ${stats.skipped}`);
    log(`  Errors:                    ${stats.errors}`);

    if (stats.errors > 0) {
      log(`\n  WARNING: Some entries failed to migrate.`);
      log(`  Review the errors above and address them before re-running.\n`);
    } else {
      log(`\n  Migration completed successfully!\n`);
    }
  }
}

// CLI execution - only run when executed directly (not when imported)
const isMainModule = require.main === module || process.argv[1]?.includes('migrate-legacy-encryption');

if (isMainModule) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('-n');

  migrateLegacyEncryption({ dryRun })
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error('Unhandled error:', error);
      process.exit(1);
    });
}
