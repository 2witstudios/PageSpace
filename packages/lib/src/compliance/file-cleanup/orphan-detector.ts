import { eq, sql, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { files } from '@pagespace/db';

export interface OrphanedFile {
  id: string;
  storagePath: string | null;
  driveId: string;
  sizeBytes: number;
}

type DB = NodePgDatabase<Record<string, unknown>>;

/**
 * Find file records with zero references across filePages, channelMessages, and pages.
 *
 * A file is orphaned when:
 * 1. No filePages rows reference it
 * 2. No channelMessages reference it (via fileId)
 * 3. No pages reference it (via filePath = storagePath pattern)
 *
 * Content-addressed storage means one physical file may serve multiple pages/drives,
 * so we only consider a file orphaned when ALL references are gone.
 */
export async function findOrphanedFileRecords(database: DB): Promise<OrphanedFile[]> {
  const result = await database.execute(sql`
    SELECT f.id, f."storagePath", f."driveId", f."sizeBytes"
    FROM files f
    LEFT JOIN file_pages fp ON fp."fileId" = f.id
    LEFT JOIN channel_messages cm ON cm."fileId" = f.id
    LEFT JOIN pages p ON p."filePath" = f."storagePath" AND p."filePath" IS NOT NULL
    WHERE fp."fileId" IS NULL
      AND cm."fileId" IS NULL
      AND p.id IS NULL
  `);

  return (result.rows as Array<{
    id: string;
    storagePath: string | null;
    driveId: string;
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
    WHERE f.id = ${fileId}
      AND fp."fileId" IS NULL
      AND cm."fileId" IS NULL
      AND p.id IS NULL
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
