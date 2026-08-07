import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { readFile, writeFile, stat } from 'fs/promises';
import path from 'path';
import { resolvePathWithin } from '@pagespace/lib/security/path-validator';
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

/** Alphanumeric + underscore pattern for safe SQL interpolation of IDs */
const SAFE_ID_PATTERN = /^[a-z0-9_-]+$/i;

/**
 * Validate that all IDs are safe for SQL interpolation.
 * Throws if any ID contains unexpected characters.
 */
export function validateIds(ids: string[], label = 'ID'): void {
  for (const id of ids) {
    if (!SAFE_ID_PATTERN.test(id)) {
      throw new Error(`Invalid ${label}: "${id}" — expected alphanumeric/underscore/hyphen characters only`);
    }
  }
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
 * WHICH CONVERSATIONS A BUNDLE CARRIES — the exporter's selection rule, in one
 * place so the validator cannot ask a narrower question than the export
 * answered.
 *
 * Three arms, because the sets are gathered along different axes:
 *  - owned by a requested user;
 *  - `type='page'`, attached to an exported page via `contextId`;
 *  - `type='client'` (API thread), attached via `agentPageId`.
 *
 * The last two are `unifiedPageScope`'s pair in SQL, and they are not optional:
 * a page chat started by a drive member OUTSIDE `--user-ids` still belongs to
 * an exported page, and `messages.conversationId` is NOT NULL and FK'd, so
 * dropping it would abort the import.
 *
 * Extracted because `tenant-validate` open-coded only the FIRST arm when
 * building the conversation id list it validates `messages` against. The
 * exporter carried those extra conversations and all of their messages; the
 * validator compared them on neither side, so `[PASS] messages` printed even
 * if the import had dropped every one of them — a false PASS on exactly the
 * row population the exporter's own comment says was the historical loss.
 *
 * Returns the WHERE predicate alone (no projection), so the exporter can
 * `SELECT *` and the validator `SELECT id` off the identical rule.
 */
export function conversationSelectionWhere(userInList: string, pageInList: string): string {
  return `"userId" IN (${userInList})`
    + ` OR (type = 'page' AND "contextId" IN (${pageInList}))`
    + ` OR (type = 'client' AND "agentPageId" IN (${pageInList}))`;
}

/**
 * The workspaces a bundle carries: owned by an exported user AND bound to one
 * of the exported conversations.
 *
 * `ownerInList` must be the set of ALL exported users — the requested ones plus
 * the conversation owners DISCOVERED by `conversationSelectionWhere`'s page
 * arms — not just the requested ones. The validator used the requested set
 * alone, so a workspace (and its shells, which hold `coldTail` terminal
 * scrollback) owned by a discovered user was carried and checked on neither
 * side.
 */
export function workspaceSelectionWhere(ownerInList: string, conversationInList: string): string {
  return `"ownerId" IN (${ownerInList})`
    + ` AND id IN (SELECT "workspaceId" FROM conversations WHERE id IN (${conversationInList}) AND "workspaceId" IS NOT NULL)`;
}

/**
 * Build an INSERT statement with ON CONFLICT DO NOTHING for idempotency.
 */
export function buildInsert(
  tableName: string,
  columns: readonly string[],
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
 * Build `UPDATE ... SET <cols> WHERE "id" = ...` statements for columns that
 * are carried but cannot ride in their own table's INSERT because they
 * reference a table inserted LATER (a forward FK — `drives.homePageId` and
 * `drives.not_found_page_id` point at `pages`, while `pages.driveId` points
 * back at `drives`, so no insert order satisfies both).
 *
 * Emitted after the referenced table has landed. Rows whose deferred columns
 * are all NULL produce no statement — there is nothing to set, and the INSERT
 * already left them NULL. Re-running the bundle re-applies identical values,
 * so this stays as idempotent as the `ON CONFLICT DO NOTHING` inserts around it.
 */
export function buildDeferredUpdate(
  tableName: string,
  columns: readonly string[],
  rows: Record<string, unknown>[],
): string {
  if (columns.length === 0 || rows.length === 0) return '';

  const statements: string[] = [];
  for (const row of rows) {
    if (columns.every((col) => row[col] === null || row[col] === undefined)) continue;
    const assignments = columns
      .map((col) => `"${col}" = ${escapeSqlValue(row[col])}`)
      .join(', ');
    statements.push(
      `UPDATE "${tableName}" SET ${assignments} WHERE "id" = ${escapeSqlValue(row.id)};`,
    );
  }

  if (statements.length === 0) return '';
  return `${statements.join('\n')}\n`;
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
    const filePath = await resolvePathWithin(path.join(bundleDir, 'files'), entry.path);
    if (!filePath) {
      mismatches.push({ path: entry.path, expected: entry.sha256, actual: 'INVALID_PATH' });
      continue;
    }
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
