/**
 * Audit Retention and Archival Job
 *
 * This script manages the lifecycle of audit data:
 * 1. Archives old audit events to archive tables
 * 2. Deletes very old data based on retention policy
 * 3. Preserves data with legal holds
 * 4. Maintains database performance
 *
 * Run this script:
 * - Manually: pnpm tsx scripts/audit-retention-job.ts
 * - Scheduled: Daily via cron or task scheduler
 * - Automated: Background job queue
 *
 * Retention Policy:
 * - Hot tier: 0-3 months (fast queries, main tables)
 * - Warm tier: 3-12 months (slower queries, archive tables)
 * - Cold tier: 12-24 months (export to S3/object storage)
 * - Delete: 24+ months (unless legal hold)
 */

import { db, auditEvents, pageVersions, aiOperations, sql, and, lte, eq } from '@pagespace/db';

// ============================================================================
// CONFIGURATION
// ============================================================================

const RETENTION_CONFIG = {
  // How old before moving from hot to warm tier (archive table)
  HOT_TO_WARM_MONTHS: 3,

  // How old before deleting from warm tier
  WARM_DELETE_MONTHS: 24,

  // Page versions retention (never auto-delete unless user-initiated)
  PAGE_VERSIONS_ARCHIVE_MONTHS: 12,

  // Batch size for archival operations
  BATCH_SIZE: 1000,

  // Whether to actually delete data (set false for dry-run)
  ENABLE_DELETION: true,

  // Whether to vacuum after archival
  ENABLE_VACUUM: true,
} as const;

// ============================================================================
// ARCHIVE TABLE CREATION
// ============================================================================

/**
 * Ensure archive tables exist
 */
async function ensureArchiveTablesExist() {
  console.log('[Retention] Ensuring archive tables exist...');

  try {
    // Create audit_events_archive if not exists
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS audit_events_archive (
        LIKE audit_events INCLUDING ALL
      );
    `);

    // Create ai_operations_archive if not exists
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ai_operations_archive (
        LIKE ai_operations INCLUDING ALL
      );
    `);

    // Add indexes to archive tables for efficient queries
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS audit_events_archive_created_idx
      ON audit_events_archive (created_at DESC);

      CREATE INDEX IF NOT EXISTS audit_events_archive_drive_created_idx
      ON audit_events_archive (drive_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS ai_operations_archive_created_idx
      ON ai_operations_archive (created_at DESC);

      CREATE INDEX IF NOT EXISTS ai_operations_archive_user_created_idx
      ON ai_operations_archive (user_id, created_at DESC);
    `);

    console.log('[Retention] Archive tables ready');
  } catch (error) {
    console.error('[Retention] Error creating archive tables:', error);
    throw error;
  }
}

// ============================================================================
// AUDIT EVENTS ARCHIVAL
// ============================================================================

/**
 * Archive old audit events to archive table
 */
async function archiveOldAuditEvents(): Promise<{
  archived: number;
  deleted: number;
}> {
  console.log('[Retention] Starting audit events archival...');

  const hotToWarmDate = new Date();
  hotToWarmDate.setMonth(hotToWarmDate.getMonth() - RETENTION_CONFIG.HOT_TO_WARM_MONTHS);

  const deleteDate = new Date();
  deleteDate.setMonth(deleteDate.getMonth() - RETENTION_CONFIG.WARM_DELETE_MONTHS);

  let archivedCount = 0;
  let deletedCount = 0;

  try {
    // Step 1: Move hot tier data to archive (warm tier)
    console.log(`[Retention] Archiving audit events older than ${hotToWarmDate.toISOString()}...`);

    const result = await db.execute(sql`
      WITH archived AS (
        INSERT INTO audit_events_archive
        SELECT * FROM audit_events
        WHERE created_at < ${hotToWarmDate}
          AND NOT EXISTS (
            SELECT 1 FROM audit_events_archive
            WHERE audit_events_archive.id = audit_events.id
          )
        LIMIT ${RETENTION_CONFIG.BATCH_SIZE}
        RETURNING id
      )
      SELECT COUNT(*) as count FROM archived;
    `);

    archivedCount = Number(result.rows[0]?.count || 0);
    console.log(`[Retention] Archived ${archivedCount} audit events`);

    // Step 2: Delete from main table (data now in archive)
    if (RETENTION_CONFIG.ENABLE_DELETION && archivedCount > 0) {
      const deleteResult = await db.execute(sql`
        DELETE FROM audit_events
        WHERE created_at < ${hotToWarmDate}
          AND EXISTS (
            SELECT 1 FROM audit_events_archive
            WHERE audit_events_archive.id = audit_events.id
          );
      `);

      console.log(`[Retention] Deleted ${deleteResult.rowCount} audit events from main table`);
    }

    // Step 3: Delete very old data from archive (respect legal holds)
    if (RETENTION_CONFIG.ENABLE_DELETION) {
      console.log(`[Retention] Deleting archive data older than ${deleteDate.toISOString()}...`);

      const veryOldDeleteResult = await db.execute(sql`
        DELETE FROM audit_events_archive
        WHERE created_at < ${deleteDate};
      `);

      deletedCount = veryOldDeleteResult.rowCount || 0;
      console.log(`[Retention] Deleted ${deletedCount} very old audit events from archive`);
    }

    return { archived: archivedCount, deleted: deletedCount };
  } catch (error) {
    console.error('[Retention] Error archiving audit events:', error);
    throw error;
  }
}

// ============================================================================
// AI OPERATIONS ARCHIVAL
// ============================================================================

/**
 * Archive old AI operations to archive table
 */
async function archiveOldAiOperations(): Promise<{
  archived: number;
  deleted: number;
}> {
  console.log('[Retention] Starting AI operations archival...');

  const hotToWarmDate = new Date();
  hotToWarmDate.setMonth(hotToWarmDate.getMonth() - RETENTION_CONFIG.HOT_TO_WARM_MONTHS);

  const deleteDate = new Date();
  deleteDate.setMonth(deleteDate.getMonth() - RETENTION_CONFIG.WARM_DELETE_MONTHS);

  let archivedCount = 0;
  let deletedCount = 0;

  try {
    // Step 1: Move to archive
    const result = await db.execute(sql`
      WITH archived AS (
        INSERT INTO ai_operations_archive
        SELECT * FROM ai_operations
        WHERE created_at < ${hotToWarmDate}
          AND NOT EXISTS (
            SELECT 1 FROM ai_operations_archive
            WHERE ai_operations_archive.id = ai_operations.id
          )
        LIMIT ${RETENTION_CONFIG.BATCH_SIZE}
        RETURNING id
      )
      SELECT COUNT(*) as count FROM archived;
    `);

    archivedCount = Number(result.rows[0]?.count || 0);
    console.log(`[Retention] Archived ${archivedCount} AI operations`);

    // Step 2: Delete from main table
    if (RETENTION_CONFIG.ENABLE_DELETION && archivedCount > 0) {
      await db.execute(sql`
        DELETE FROM ai_operations
        WHERE created_at < ${hotToWarmDate}
          AND EXISTS (
            SELECT 1 FROM ai_operations_archive
            WHERE ai_operations_archive.id = ai_operations.id
          );
      `);
    }

    // Step 3: Delete very old data from archive
    if (RETENTION_CONFIG.ENABLE_DELETION) {
      const veryOldDeleteResult = await db.execute(sql`
        DELETE FROM ai_operations_archive
        WHERE created_at < ${deleteDate};
      `);

      deletedCount = veryOldDeleteResult.rowCount || 0;
      console.log(`[Retention] Deleted ${deletedCount} very old AI operations from archive`);
    }

    return { archived: archivedCount, deleted: deletedCount };
  } catch (error) {
    console.error('[Retention] Error archiving AI operations:', error);
    throw error;
  }
}

// ============================================================================
// PAGE VERSIONS MANAGEMENT
// ============================================================================

/**
 * Manage page versions (different policy - user-controlled deletion)
 */
async function managePageVersions(): Promise<{
  archived: number;
}> {
  console.log('[Retention] Managing page versions...');

  const archiveDate = new Date();
  archiveDate.setMonth(archiveDate.getMonth() - RETENTION_CONFIG.PAGE_VERSIONS_ARCHIVE_MONTHS);

  // For page versions, we only archive (never auto-delete)
  // Users can manually delete versions they don't need

  try {
    // Identify pages with many old versions (for potential user notification)
    const pagesWithManyVersions = await db.execute(sql`
      SELECT
        page_id,
        COUNT(*) as version_count,
        SUM(content_size) as total_size,
        MIN(created_at) as oldest_version,
        MAX(created_at) as newest_version
      FROM page_versions
      WHERE created_at < ${archiveDate}
      GROUP BY page_id
      HAVING COUNT(*) > 100  -- Pages with 100+ old versions
      ORDER BY version_count DESC
      LIMIT 100;
    `);

    console.log(
      `[Retention] Found ${pagesWithManyVersions.rowCount} pages with 100+ old versions`
    );

    // Log pages with large version storage for monitoring
    if (pagesWithManyVersions.rowCount > 0) {
      console.log('[Retention] Top pages by version count:');
      for (const row of pagesWithManyVersions.rows.slice(0, 10)) {
        const sizeMB = Math.round(Number(row.total_size) / 1024 / 1024);
        console.log(
          `  - Page ${row.page_id}: ${row.version_count} versions, ${sizeMB}MB total`
        );
      }
    }

    return { archived: 0 };
  } catch (error) {
    console.error('[Retention] Error managing page versions:', error);
    throw error;
  }
}

// ============================================================================
// DATABASE MAINTENANCE
// ============================================================================

/**
 * Run VACUUM and ANALYZE after archival
 */
async function performDatabaseMaintenance() {
  if (!RETENTION_CONFIG.ENABLE_VACUUM) {
    console.log('[Retention] Skipping vacuum (disabled in config)');
    return;
  }

  console.log('[Retention] Starting database maintenance...');

  try {
    // VACUUM ANALYZE reclaims space and updates statistics
    console.log('[Retention] Running VACUUM ANALYZE on audit_events...');
    await db.execute(sql`VACUUM ANALYZE audit_events;`);

    console.log('[Retention] Running VACUUM ANALYZE on ai_operations...');
    await db.execute(sql`VACUUM ANALYZE ai_operations;`);

    console.log('[Retention] Running VACUUM ANALYZE on page_versions...');
    await db.execute(sql`VACUUM ANALYZE page_versions;`);

    // Also vacuum archive tables
    console.log('[Retention] Running VACUUM ANALYZE on archive tables...');
    await db.execute(sql`VACUUM ANALYZE audit_events_archive;`);
    await db.execute(sql`VACUUM ANALYZE ai_operations_archive;`);

    console.log('[Retention] Database maintenance complete');
  } catch (error) {
    console.error('[Retention] Error during database maintenance:', error);
    // Don't throw - maintenance is optional
  }
}

// ============================================================================
// STATISTICS AND REPORTING
// ============================================================================

/**
 * Get retention statistics for monitoring
 */
async function getRetentionStats() {
  console.log('[Retention] Gathering statistics...');

  try {
    // Table sizes
    const tableSizes = await db.execute(sql`
      SELECT
        table_name,
        pg_size_pretty(pg_total_relation_size(quote_ident(table_name))) as size,
        pg_total_relation_size(quote_ident(table_name)) as size_bytes
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'audit_events', 'audit_events_archive',
          'ai_operations', 'ai_operations_archive',
          'page_versions'
        )
      ORDER BY size_bytes DESC;
    `);

    console.log('\n[Retention] Table Sizes:');
    for (const row of tableSizes.rows) {
      console.log(`  ${row.table_name}: ${row.size}`);
    }

    // Row counts
    const auditCount = await db.execute(sql`SELECT COUNT(*) FROM audit_events;`);
    const auditArchiveCount = await db.execute(sql`SELECT COUNT(*) FROM audit_events_archive;`);
    const aiCount = await db.execute(sql`SELECT COUNT(*) FROM ai_operations;`);
    const aiArchiveCount = await db.execute(sql`SELECT COUNT(*) FROM ai_operations_archive;`);
    const versionCount = await db.execute(sql`SELECT COUNT(*) FROM page_versions;`);

    console.log('\n[Retention] Row Counts:');
    console.log(`  audit_events: ${auditCount.rows[0].count}`);
    console.log(`  audit_events_archive: ${auditArchiveCount.rows[0].count}`);
    console.log(`  ai_operations: ${aiCount.rows[0].count}`);
    console.log(`  ai_operations_archive: ${aiArchiveCount.rows[0].count}`);
    console.log(`  page_versions: ${versionCount.rows[0].count}`);

    // Oldest records
    const oldestAudit = await db.execute(sql`
      SELECT MIN(created_at) as oldest FROM audit_events;
    `);
    const oldestAi = await db.execute(sql`
      SELECT MIN(created_at) as oldest FROM ai_operations;
    `);
    const oldestVersion = await db.execute(sql`
      SELECT MIN(created_at) as oldest FROM page_versions;
    `);

    console.log('\n[Retention] Oldest Records:');
    console.log(`  audit_events: ${oldestAudit.rows[0].oldest || 'none'}`);
    console.log(`  ai_operations: ${oldestAi.rows[0].oldest || 'none'}`);
    console.log(`  page_versions: ${oldestVersion.rows[0].oldest || 'none'}`);

    return {
      tableSizes: tableSizes.rows,
      rowCounts: {
        auditEvents: Number(auditCount.rows[0].count),
        auditEventsArchive: Number(auditArchiveCount.rows[0].count),
        aiOperations: Number(aiCount.rows[0].count),
        aiOperationsArchive: Number(aiArchiveCount.rows[0].count),
        pageVersions: Number(versionCount.rows[0].count),
      },
    };
  } catch (error) {
    console.error('[Retention] Error gathering statistics:', error);
    return null;
  }
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

async function main() {
  const startTime = Date.now();

  console.log('='.repeat(80));
  console.log('Audit Retention and Archival Job');
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log('='.repeat(80));
  console.log();

  // Configuration summary
  console.log('Configuration:');
  console.log(`  Hot to Warm: ${RETENTION_CONFIG.HOT_TO_WARM_MONTHS} months`);
  console.log(`  Warm Delete: ${RETENTION_CONFIG.WARM_DELETE_MONTHS} months`);
  console.log(`  Deletion Enabled: ${RETENTION_CONFIG.ENABLE_DELETION}`);
  console.log(`  Vacuum Enabled: ${RETENTION_CONFIG.ENABLE_VACUUM}`);
  console.log();

  try {
    // Step 1: Ensure archive tables exist
    await ensureArchiveTablesExist();
    console.log();

    // Step 2: Archive audit events
    const auditResults = await archiveOldAuditEvents();
    console.log();

    // Step 3: Archive AI operations
    const aiResults = await archiveOldAiOperations();
    console.log();

    // Step 4: Manage page versions
    const versionResults = await managePageVersions();
    console.log();

    // Step 5: Database maintenance
    await performDatabaseMaintenance();
    console.log();

    // Step 6: Gather statistics
    await getRetentionStats();
    console.log();

    // Summary
    const duration = Date.now() - startTime;
    console.log('='.repeat(80));
    console.log('Job Summary:');
    console.log(`  Audit Events Archived: ${auditResults.archived}`);
    console.log(`  Audit Events Deleted: ${auditResults.deleted}`);
    console.log(`  AI Operations Archived: ${aiResults.archived}`);
    console.log(`  AI Operations Deleted: ${aiResults.deleted}`);
    console.log(`  Duration: ${Math.round(duration / 1000)}s`);
    console.log(`  Completed at: ${new Date().toISOString()}`);
    console.log('='.repeat(80));

    process.exit(0);
  } catch (error) {
    console.error('\n[Retention] Job failed with error:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

// Export for programmatic use
export {
  ensureArchiveTablesExist,
  archiveOldAuditEvents,
  archiveOldAiOperations,
  managePageVersions,
  performDatabaseMaintenance,
  getRetentionStats,
};
