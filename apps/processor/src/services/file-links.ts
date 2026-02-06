import { db, filePages, pages, eq } from '@pagespace/db';

export interface FileLink {
  fileId: string;
  pageId: string;
  driveId: string;
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
