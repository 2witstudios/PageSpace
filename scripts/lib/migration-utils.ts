import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { readFile, writeFile, stat } from 'fs/promises';
import path from 'path';
import type { ExportManifest, FileChecksum } from './migration-types';

/**
 * Escape a SQL value for safe inclusion in INSERT statements.
 * Returns the SQL literal representation (e.g., 'text', 42, NULL, TRUE).
 */
export function escapeSqlValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'NULL';
    return String(value);
  }
  if (value instanceof Date) {
    return `'${value.toISOString()}'`;
  }
  if (typeof value === 'object') {
    // JSON columns (jsonb)
    return `'${escapeString(JSON.stringify(value))}'::jsonb`;
  }
  if (typeof value === 'string') {
    return `'${escapeString(value)}'`;
  }
  return 'NULL';
}

/** Escape single quotes in a string for SQL */
function escapeString(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Build a SQL IN-list from an array of string IDs, with escaping.
 * Returns "''" (empty string literal) for empty arrays to keep SQL valid.
 */
export function toSqlInList(ids: string[] | Set<string> | readonly string[]): string {
  const arr = Array.from(ids);
  if (arr.length === 0) return "''";
  return arr.map((id) => `'${escapeString(id)}'`).join(', ');
}

/**
 * Build an INSERT statement with ON CONFLICT DO NOTHING for idempotency.
 */
export function buildInsert(
  tableName: string,
  columns: string[],
  rows: Record<string, unknown>[],
): string {
  if (rows.length === 0) return '';

  const quotedCols = columns.map((c) => `"${c}"`).join(', ');
  const valueRows = rows.map((row) => {
    const vals = columns.map((col) => escapeSqlValue(row[col]));
    return `  (${vals.join(', ')})`;
  });

  return [
    `INSERT INTO "${tableName}" (${quotedCols})`,
    'VALUES',
    valueRows.join(',\n'),
    'ON CONFLICT DO NOTHING;',
    '',
  ].join('\n');
}

/**
 * Compute SHA-256 checksum of a file.
 */
export async function fileChecksum(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Compute checksum info for a file.
 */
export async function computeFileChecksum(
  filePath: string,
  relativePath: string,
): Promise<FileChecksum> {
  const [sha256, fileStat] = await Promise.all([
    fileChecksum(filePath),
    stat(filePath),
  ]);
  return {
    path: relativePath,
    sha256,
    sizeBytes: fileStat.size,
  };
}

/**
 * Write the export manifest to disk.
 */
export async function writeManifest(
  outputDir: string,
  manifest: ExportManifest,
): Promise<void> {
  const manifestPath = path.join(outputDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
}

/**
 * Read and parse the export manifest from a bundle.
 */
export async function readManifest(
  bundleDir: string,
): Promise<ExportManifest> {
  const manifestPath = path.join(bundleDir, 'manifest.json');
  const raw = await readFile(manifestPath, 'utf-8');
  return JSON.parse(raw) as ExportManifest;
}

/**
 * Validate file checksums in a bundle against the manifest.
 * Returns list of mismatches.
 */
export async function validateChecksums(
  bundleDir: string,
  manifest: ExportManifest,
): Promise<{ path: string; expected: string; actual: string }[]> {
  const mismatches: { path: string; expected: string; actual: string }[] = [];

  for (const entry of manifest.fileChecksums) {
    const filePath = path.join(bundleDir, 'files', entry.path);
    try {
      const actual = await fileChecksum(filePath);
      if (actual !== entry.sha256) {
        mismatches.push({ path: entry.path, expected: entry.sha256, actual });
      }
    } catch {
      mismatches.push({
        path: entry.path,
        expected: entry.sha256,
        actual: 'FILE_NOT_FOUND',
      });
    }
  }

  return mismatches;
}
