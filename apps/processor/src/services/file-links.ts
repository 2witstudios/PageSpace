import { db, filePages, files, pages, eq } from '@pagespace/db';

export interface FileLink {
  fileId: string;
  pageId: string;
  driveId: string;
}

export async function ensureFileLinked(options: {
  fileId: string;
  pageId: string;
  driveId: string;
  linkedBy?: string;
  sizeBytes?: number;
  mimeType?: string | null;
}): Promise<void> {
  const { fileId, pageId, driveId, linkedBy, sizeBytes, mimeType } = options;

  await db.transaction(async tx => {
    await tx
      .insert(files)
      .values({
        id: fileId,
        driveId,
        sizeBytes: sizeBytes ?? 0,
        mimeType: mimeType ?? null,
      })
      .onConflictDoNothing();

    await tx
      .insert(filePages)
      .values({
        fileId,
        pageId,
        linkedBy,
      })
      .onConflictDoUpdate({
        target: [filePages.fileId, filePages.pageId],
        set: {
          linkedBy,
          linkedAt: new Date(),
        },
      });
  });
}

export async function getLinksForFile(fileId: string): Promise<FileLink[]> {
  const results = await db
    .select({
      fileId: filePages.fileId,
      pageId: filePages.pageId,
      driveId: pages.driveId,
    })
    .from(filePages)
    .innerJoin(pages, eq(pages.id, filePages.pageId))
    .where(eq(filePages.fileId, fileId));

  return results;
}

export async function getLinkForPage(pageId: string): Promise<FileLink | null> {
  const [row] = await db
    .select({
      fileId: filePages.fileId,
      pageId: filePages.pageId,
      driveId: pages.driveId,
    })
    .from(filePages)
    .innerJoin(pages, eq(pages.id, filePages.pageId))
    .where(eq(filePages.pageId, pageId))
    .limit(1);

  return row ?? null;
}
