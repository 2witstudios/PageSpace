import { eq, sql, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { files } from '@pagespace/db/schema/storage';

export interface OrphanedFile {
  id: string;
  storagePath: string | null;
  driveId: string | null;
  sizeBytes: number;
}

type DB = NodePgDatabase<Record<string, unknown>>;

/**
 * Find file records with zero references across all linkage tables.
 *
 * A file is orphaned when:
 * 1. No filePages rows reference it by fileId
 * 2. No channelMessages reference it (via fileId)
 * 3. No pages reference it (via filePath = storagePath pattern)
 * 4. No fileConversations rows reference it by fileId (DM-attached files)
 * 5. No directMessages reference it (via fileId)
 * 6. No other live file record shares the same storagePath — protects content-addressed
 *    blobs that are still needed by a sibling file record referenced via any linkage path.
 *
 * Content-addressed storage means one physical blob may back multiple file records
 * (same storagePath). We only treat a record as orphaned when every sibling sharing
 * that storagePath also has no live references.
 */
export async function findOrphanedFileRecords(database: DB): Promise<OrphanedFile[]> {
  const result = await database.execute(sql`
    SELECT f.id, f."storagePath", f."driveId", f."sizeBytes"
    FROM files f
    LEFT JOIN file_pages fp ON fp."fileId" = f.id
    LEFT JOIN channel_messages cm ON cm."fileId" = f.id
    LEFT JOIN pages p ON p."filePath" = f."storagePath" AND p."filePath" IS NOT NULL
    LEFT JOIN file_conversations fc ON fc."fileId" = f.id
    LEFT JOIN direct_messages dm ON dm."fileId" = f.id
    WHERE fp."fileId" IS NULL
      AND cm."fileId" IS NULL
      AND p.id IS NULL
      AND fc."fileId" IS NULL
      AND dm."fileId" IS NULL
      AND (
        f."storagePath" IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM files other_f
          WHERE other_f."storagePath" = f."storagePath"
            AND other_f.id != f.id
            AND (
              EXISTS (SELECT 1 FROM file_pages WHERE "fileId" = other_f.id)
              OR EXISTS (SELECT 1 FROM channel_messages WHERE "fileId" = other_f.id)
              OR EXISTS (SELECT 1 FROM file_conversations WHERE "fileId" = other_f.id)
              OR EXISTS (SELECT 1 FROM direct_messages WHERE "fileId" = other_f.id)
            )
        )
      )
  `);

  return (result.rows as Array<{
    id: string;
    storagePath: string | null;
    driveId: string | null;
    sizeBytes: string | number;
  }>).map(row => ({
    id: row.id,
    storagePath: row.storagePath,
    driveId: row.driveId,
    sizeBytes: typeof row.sizeBytes === 'string' ? parseInt(row.sizeBytes, 10) : row.sizeBytes,
  }));
}

/**
 * Check if a single file is orphaned (has zero references).
 */
export async function isFileOrphaned(database: DB, fileId: string): Promise<boolean> {
  const result = await database.execute(sql`
    SELECT 1
    FROM files f
    LEFT JOIN file_pages fp ON fp."fileId" = f.id
    LEFT JOIN channel_messages cm ON cm."fileId" = f.id
    LEFT JOIN pages p ON p."filePath" = f."storagePath" AND p."filePath" IS NOT NULL
    LEFT JOIN file_conversations fc ON fc."fileId" = f.id
    LEFT JOIN direct_messages dm ON dm."fileId" = f.id
    WHERE f.id = ${fileId}
      AND fp."fileId" IS NULL
      AND cm."fileId" IS NULL
      AND p.id IS NULL
      AND fc."fileId" IS NULL
      AND dm."fileId" IS NULL
    LIMIT 1
  `);

  return result.rows.length > 0;
}

/**
 * Hard-delete file records from the database by ID.
 * Returns the number of records deleted.
 */
export async function deleteFileRecords(database: DB, fileIds: string[]): Promise<number> {
  if (fileIds.length === 0) return 0;

  const result = await database
    .delete(files)
    .where(inArray(files.id, fileIds))
    .returning({ id: files.id });
  return result.length;
}
