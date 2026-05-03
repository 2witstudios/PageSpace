import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { fileConversations, filePages, files } from '@pagespace/db/schema/storage';
import { pages } from '@pagespace/db/schema/core';
import { dmConversations } from '@pagespace/db/schema/social';

export interface FileLink {
  fileId: string;
  pageId: string;
  driveId: string;
}

export interface ConversationFileLink {
  fileId: string;
  conversationId: string;
  participant1Id: string;
  participant2Id: string;
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

export async function getConversationLinksForFile(fileId: string): Promise<ConversationFileLink[]> {
  const results = await db
    .select({
      fileId: fileConversations.fileId,
      conversationId: fileConversations.conversationId,
      participant1Id: dmConversations.participant1Id,
      participant2Id: dmConversations.participant2Id,
    })
    .from(fileConversations)
    .innerJoin(dmConversations, eq(dmConversations.id, fileConversations.conversationId))
    .where(eq(fileConversations.fileId, fileId));

  return results;
}

export async function getFileDriveId(fileId: string): Promise<string | undefined> {
  const result = await db.query.files.findFirst({
    where: eq(files.id, fileId),
    columns: { driveId: true },
  });
  return result?.driveId ?? undefined;
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
