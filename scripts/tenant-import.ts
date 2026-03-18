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

  // 4. Execute SQL in a transaction
  const pool = new Pool({ connectionString: databaseUrl, ssl: false });
  const client = await pool.connect();

  let rowsImported = 0;
  let rowsSkipped = 0;

  try {
    // Split the SQL into individual statements, filtering out comments/empty
    const statements = splitSqlStatements(sqlContent);

    await client.query('BEGIN');

    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed || trimmed === 'BEGIN;' || trimmed === 'COMMIT;') continue;

      const result = await client.query(trimmed);
      if (result.rowCount !== null && result.rowCount !== undefined) {
        rowsImported += result.rowCount;
      }
    }

    await client.query('COMMIT');

    // Calculate skipped rows (expected - actual imported)
    rowsSkipped = Math.max(0, totalExpected - rowsImported);
  } catch (err) {
    await client.query('ROLLBACK');
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

/**
 * Split a SQL file into individual statements.
 * Handles multi-line INSERT statements correctly.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';

  for (const line of sql.split('\n')) {
    const trimmed = line.trim();

    // Skip comments
    if (trimmed.startsWith('--')) continue;

    current += line + '\n';

    // Statement ends with semicolon
    if (trimmed.endsWith(';')) {
      const stmt = current.trim();
      if (stmt) statements.push(stmt);
      current = '';
    }
  }

  // Handle any trailing statement without semicolon
  const remaining = current.trim();
  if (remaining) statements.push(remaining);

  return statements;
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
