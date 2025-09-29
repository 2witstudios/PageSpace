import 'dotenv/config';
import { db, pages, files, filePages, sql } from '@pagespace/db';

async function backfill(): Promise<void> {
  const rows = await db
    .select({
      id: pages.id,
      driveId: pages.driveId,
      filePath: pages.filePath,
      contentHash: pages.contentHash,
      fileSize: pages.fileSize,
      mimeType: pages.mimeType,
    })
    .from(pages)
    .where(sql`${pages.filePath} IS NOT NULL OR ${pages.contentHash} IS NOT NULL`);

  let filesInserted = 0;
  let linksInserted = 0;

  for (const row of rows) {
    const hash = (row.contentHash ?? row.filePath)?.trim();
    if (!hash) {
      continue;
    }

    const sizeBytes = row.fileSize ? Math.max(0, Math.round(row.fileSize)) : 0;

    await db.transaction(async (tx) => {
      const fileResult = await tx
        .insert(files)
        .values({
          id: hash,
          driveId: row.driveId,
          sizeBytes,
          mimeType: row.mimeType ?? null,
        })
        .onConflictDoNothing()
        .returning();

      if (fileResult.length > 0) {
        filesInserted += 1;
      }

      const linkResult = await tx
        .insert(filePages)
        .values({
          fileId: hash,
          pageId: row.id,
        })
        .onConflictDoNothing({
          target: [filePages.fileId, filePages.pageId],
        })
        .returning();

      if (linkResult.length > 0) {
        linksInserted += 1;
      }
    });
  }

  console.log(`Backfill complete. files inserted: ${filesInserted}, links inserted: ${linksInserted}`);
}

backfill()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Backfill failed', error);
    process.exit(1);
  });
