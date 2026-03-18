#!/usr/bin/env tsx
/**
 * Tenant data import script.
 *
 * Imports an export bundle into a target tenant database.
 * All inserts use ON CONFLICT DO NOTHING for idempotency.
 *
 * Usage:
 *   tsx scripts/tenant-import.ts \
 *     --bundle ./export-bundle/ \
 *     --database-url postgres://tenant-db:5432/pagespace \
 *     [--file-storage-path /data/files] \
 *     [--dry-run]
 */
import { Pool } from 'pg';
import { readFile, copyFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { ImportOptions, ExportManifest } from './lib/migration-types';
import { readManifest, validateChecksums } from './lib/migration-utils';

export interface ImportResult {
  manifest: ExportManifest;
  checksumMismatches: { path: string; expected: string; actual: string }[];
  rowsImported: number;
  rowsSkipped: number;
  filesImported: number;
}

/**
 * Run the full import pipeline.
 */
export async function runImport(options: ImportOptions): Promise<ImportResult> {
  const { bundleDir, databaseUrl, fileStoragePath, dryRun } = options;

  // 1. Read and validate manifest
  const manifest = await readManifest(bundleDir);

  // 2. Validate checksums
  const checksumMismatches = await validateChecksums(bundleDir, manifest);
  if (checksumMismatches.length > 0) {
    console.warn(`WARNING: ${checksumMismatches.length} checksum mismatch(es) detected:`);
    for (const m of checksumMismatches) {
      console.warn(`  ${m.path}: expected ${m.expected}, got ${m.actual}`);
    }
  }

  // 3. Read SQL
  const sqlPath = path.join(bundleDir, 'data.sql');
  const sqlContent = await readFile(sqlPath, 'utf-8');

  // Count expected rows from manifest
  const totalExpected = Object.values(manifest.tableCounts).reduce(
    (sum, n) => sum + n,
    0,
  );

  if (dryRun) {
    // Parse SQL to estimate what would happen
    const insertCount = (sqlContent.match(/^INSERT INTO/gm) || []).length;
    console.log(`[DRY RUN] Would execute ${insertCount} INSERT statements`);
    console.log(`[DRY RUN] Expected rows: ${totalExpected}`);
    console.log(`[DRY RUN] Files to copy: ${manifest.fileChecksums.length}`);

    return {
      manifest,
      checksumMismatches,
      rowsImported: 0,
      rowsSkipped: 0,
      filesImported: 0,
    };
  }

  // 4. Execute SQL as a single multi-statement query
  // The pg driver natively handles multi-statement strings and returns
  // an array of QueryResult objects. The SQL already contains BEGIN/COMMIT.
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  let rowsImported = 0;
  let rowsSkipped = 0;

  try {
    const result = await client.query(sqlContent);
    // pg returns QueryResult[] for multi-statement queries
    const results = Array.isArray(result) ? result : [result];
    for (const r of results) {
      if (typeof r.rowCount === 'number') {
        rowsImported += r.rowCount;
      }
    }
    rowsSkipped = Math.max(0, totalExpected - rowsImported);
  } catch (err) {
    // The SQL's BEGIN started a transaction; clear the aborted state
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }

  // 5. Copy file blobs
  let filesImported = 0;
  for (const entry of manifest.fileChecksums) {
    const srcPath = path.join(bundleDir, 'files', entry.path);
    if (!existsSync(srcPath)) continue;

    const destPath = path.join(fileStoragePath, entry.path);
    await mkdir(path.dirname(destPath), { recursive: true });
    await copyFile(srcPath, destPath);
    filesImported++;
  }

  return {
    manifest,
    checksumMismatches,
    rowsImported,
    rowsSkipped,
    filesImported,
  };
}

// ─── CLI entry point ──────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const getArg = (name: string): string | undefined => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 ? args[idx + 1] : undefined;
  };

  const bundleDir = getArg('bundle') || getArg('input');
  const databaseUrl = getArg('database-url') || process.env.DATABASE_URL;
  const fileStoragePath = getArg('file-storage-path') || process.env.FILE_STORAGE_PATH || './uploads';
  const dryRun = args.includes('--dry-run');

  if (!bundleDir) {
    console.error('Usage: tenant-import.ts --bundle ./export-bundle/ --database-url postgres://... [--dry-run]');
    process.exit(1);
  }

  if (!databaseUrl) {
    console.error('Error: --database-url or DATABASE_URL env var required');
    process.exit(1);
  }

  console.log(`Importing from: ${bundleDir}`);
  if (dryRun) console.log('[DRY RUN] No data will be written.');

  const result = await runImport({
    bundleDir,
    databaseUrl,
    fileStoragePath,
    dryRun,
  });

  console.log('\nImport summary:');
  console.log(`  Rows imported: ${result.rowsImported}`);
  console.log(`  Rows skipped (already exist): ${result.rowsSkipped}`);
  console.log(`  Files imported: ${result.filesImported}`);

  if (result.checksumMismatches.length > 0) {
    console.warn(`  ⚠ ${result.checksumMismatches.length} checksum mismatch(es)`);
  }
}

const isDirectExecution = process.argv[1]?.endsWith('tenant-import.ts');
if (isDirectExecution) {
  main().catch((err) => {
    console.error('Import failed:', err);
    process.exit(1);
  });
}
