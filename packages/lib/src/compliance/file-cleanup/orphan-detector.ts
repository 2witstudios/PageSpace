import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export interface OrphanedFile {
  id: string;
  storagePath: string | null;
  driveId: string | null;
  sizeBytes: number;
  createdBy: string | null;
}

type DB = NodePgDatabase<Record<string, unknown>>;

// Shared predicate for "is file `f` referenced anywhere". Every fragment below
// assumes the base `files` row is aliased `f`. Kept as one definition so
// findOrphanedFileRecords, isFileOrphaned, and deleteFileRecords's recheck
// can't silently drift from each other the way isFileOrphaned previously did
// (it was missing the sibling-blob guard findOrphanedFileRecords already had).
const REFERENCE_JOINS = sql`
  LEFT JOIN file_pages fp ON fp."fileId" = f.id
  LEFT JOIN channel_messages cm ON cm."fileId" = f.id
  LEFT JOIN pages p ON p."filePath" = f."storagePath" AND p."filePath" IS NOT NULL
  LEFT JOIN file_conversations fc ON fc."fileId" = f.id
  LEFT JOIN direct_messages dm ON dm."fileId" = f.id AND dm."isActive" = true
`;

const IS_UNREFERENCED = sql`
  fp."fileId" IS NULL
  AND cm."fileId" IS NULL
  AND p.id IS NULL
  AND fc."fileId" IS NULL
  AND dm."fileId" IS NULL
`;

// Content-addressed storage means one physical blob may back multiple file
// records (same storagePath). A row is only truly reclaimable when every
// sibling sharing that storagePath also has no live references.
const NO_LIVE_SIBLING_SHARES_BLOB = sql`
  (
    f."storagePath" IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM files other_f
      WHERE other_f."storagePath" = f."storagePath"
        AND other_f.id != f.id
        AND (
          EXISTS (SELECT 1 FROM file_pages WHERE "fileId" = other_f.id)
          OR EXISTS (SELECT 1 FROM channel_messages WHERE "fileId" = other_f.id)
          OR EXISTS (SELECT 1 FROM file_conversations WHERE "fileId" = other_f.id)
          OR EXISTS (SELECT 1 FROM direct_messages WHERE "fileId" = other_f.id AND "isActive" = true)
        )
    )
  )
`;

/**
 * Find file records with zero references across all linkage tables.
 *
 * A file is orphaned when:
 * 1. No filePages rows reference it by fileId
 * 2. No channelMessages reference it (via fileId)
 * 3. No pages reference it (via filePath = storagePath pattern)
 * 4. No fileConversations rows reference it by fileId (DM-attached files)
 * 5. No live (isActive=true) directMessages reference it (via fileId) — soft-deleted
 *    DM messages must not keep files alive, otherwise their storage never reclaims.
 * 6. No other live file record shares the same storagePath — protects content-addressed
 *    blobs that are still needed by a sibling file record referenced via any linkage path.
 *
 * Content-addressed storage means one physical blob may back multiple file records
 * (same storagePath). We only treat a record as orphaned when every sibling sharing
 * that storagePath also has no live references.
 *
 * When `restrictToFileIds` is provided, only those file records are considered
 * (all the same reference + content-addressed sibling checks still apply). This
 * lets a user-facing delete reap just the files its subtree orphaned instead of
 * sweeping the whole table inline. An empty array reaps nothing; `undefined`
 * scans every file (the weekly cron's behaviour).
 */
export async function findOrphanedFileRecords(
  database: DB,
  restrictToFileIds?: string[],
): Promise<OrphanedFile[]> {
  if (restrictToFileIds && restrictToFileIds.length === 0) return [];

  const idFilter = restrictToFileIds
    ? sql` AND f.id = ANY(${restrictToFileIds}::text[])`
    : sql``;

  const result = await database.execute(sql`
    SELECT f.id, f."storagePath", f."driveId", f."sizeBytes", f."createdBy"
    FROM files f
    ${REFERENCE_JOINS}
    WHERE ${IS_UNREFERENCED}${idFilter}
      AND ${NO_LIVE_SIBLING_SHARES_BLOB}
  `);

  return (result.rows as Array<{
    id: string;
    storagePath: string | null;
    driveId: string | null;
    sizeBytes: string | number;
    createdBy: string | null;
  }>).map(row => ({
    id: row.id,
    storagePath: row.storagePath,
    driveId: row.driveId,
    sizeBytes: typeof row.sizeBytes === 'string' ? parseInt(row.sizeBytes, 10) : row.sizeBytes,
    createdBy: row.createdBy,
  }));
}

/**
 * Check if a single file is orphaned (has zero references).
 */
export async function isFileOrphaned(database: DB, fileId: string): Promise<boolean> {
  const result = await database.execute(sql`
    SELECT 1
    FROM files f
    ${REFERENCE_JOINS}
    WHERE f.id = ${fileId}
      AND ${IS_UNREFERENCED}
      AND ${NO_LIVE_SIBLING_SHARES_BLOB}
    LIMIT 1
  `);

  return result.rows.length > 0;
}

/**
 * Hard-delete file records from the database by ID.
 * Returns the IDs of the records actually deleted. Because the DELETE is
 * atomic, only the single invocation that removes a given row gets its ID
 * back — callers can credit storage off this set without double-counting
 * when two reaps race on the same orphan.
 *
 * The scan that decided `fileIds` (findOrphanedFileRecords) may be long past
 * by the time this runs — reapOrphanedFiles loops per-orphan doing an HTTP
 * call to the processor before batching this call. A message send racing
 * that window (insertDmMessageWithAttachment/insertChannelMessageWithAttachment)
 * takes FOR UPDATE on the same `files` row before referencing it, so we lock
 * the candidate rows first and re-verify referencedness in a *separate*
 * statement afterward — mirroring purgeInactiveMessages's two-statement
 * protocol (dm-message-repository.ts). A single locking DELETE would keep
 * its pre-block snapshot and could still drop a row a just-committed insert
 * now depends on.
 */
export async function deleteFileRecords(database: DB, fileIds: string[]): Promise<string[]> {
  if (fileIds.length === 0) return [];

  return database.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT 1 FROM files WHERE id = ANY(${fileIds}::text[]) FOR UPDATE
    `);

    const result = await tx.execute(sql`
      DELETE FROM files f
      WHERE f.id = ANY(${fileIds}::text[])
        AND f.id IN (
          SELECT f.id
          FROM files f
          ${REFERENCE_JOINS}
          WHERE f.id = ANY(${fileIds}::text[])
            AND ${IS_UNREFERENCED}
            AND ${NO_LIVE_SIBLING_SHARES_BLOB}
        )
      RETURNING f.id
    `);

    return (result.rows as Array<{ id: string }>).map(row => row.id);
  });
}
