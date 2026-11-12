/**
 * Everything that points at a content hash — pages, file rows, messages,
 * drives and the people who put it there. Read-only: a takedown records these
 * on the case and leaves the rows as they are (readers answer "removed" from
 * the blocklist instead).
 *
 * IDs only. No titles, filenames or message text ever leave this module.
 */

import { db } from '@pagespace/db/db';
import { eq, inArray, like, or } from '@pagespace/db/operators';
import { channelMessageAttachments, channelMessages } from '@pagespace/db/schema/chat';
import { messages } from '@pagespace/db/schema/conversations';
import { pages } from '@pagespace/db/schema/core';
import { directMessageAttachments, directMessages } from '@pagespace/db/schema/social';
import { fileConversations, filePages, files } from '@pagespace/db/schema/storage';
import { escapeLikePattern } from '../db/like-pattern';
import { normalizeContentHash } from './policy';
import type { ContentReferences } from './takedown';

/** Per-list cap. A hash referenced more widely than this is recorded as truncated. */
export const REFERENCE_LIMIT = 1000;

/** Both forms a stored reference to the hash can take (see `toContentHash` in the web app). */
export function storedFormsOf(contentHash: string): string[] {
  return [contentHash, `files/${contentHash}/original`];
}

export async function collectContentReferences(rawHash: string): Promise<ContentReferences> {
  const contentHash = normalizeContentHash(rawHash);
  if (!contentHash) throw new Error('Invalid content hash');
  const forms = storedFormsOf(contentHash);
  let truncated = false;
  const capped = <T>(rows: T[]): T[] => {
    if (rows.length > REFERENCE_LIMIT) {
      truncated = true;
      return rows.slice(0, REFERENCE_LIMIT);
    }
    return rows;
  };
  const fetchLimit = REFERENCE_LIMIT + 1;

  const pageIds = new Set<string>();
  const driveIds = new Set<string>();
  const uploaders = new Set<string>();
  const conversationIds = new Set<string>();

  const pageRows = capped(
    await db
      .select({ id: pages.id, driveId: pages.driveId, createdBy: pages.createdBy })
      .from(pages)
      .where(or(inArray(pages.filePath, forms), eq(pages.contentHash, contentHash)))
      .limit(fetchLimit),
  );
  for (const row of pageRows) {
    pageIds.add(row.id);
    driveIds.add(row.driveId);
    if (row.createdBy) uploaders.add(row.createdBy);
  }

  const fileRows = capped(
    await db
      .select({ id: files.id, driveId: files.driveId, createdBy: files.createdBy })
      .from(files)
      .where(or(eq(files.id, contentHash), inArray(files.storagePath, forms)))
      .limit(fetchLimit),
  );
  const fileIds = fileRows.map((row) => row.id);
  for (const row of fileRows) {
    if (row.driveId) driveIds.add(row.driveId);
    if (row.createdBy) uploaders.add(row.createdBy);
  }

  const channelMessageIds = new Set<string>();
  const directMessageIds = new Set<string>();

  if (fileIds.length > 0) {
    const linkedPages = capped(
      await db
        .select({ pageId: filePages.pageId })
        .from(filePages)
        .where(inArray(filePages.fileId, fileIds))
        .limit(fetchLimit),
    );
    // A link attaches a file that is already stored. The linker is recorded
    // through the page, not as an uploader: `uploaderUserIds` drives the
    // optional suspension, and it names only who brought the bytes in.
    for (const row of linkedPages) pageIds.add(row.pageId);

    const linkedConversations = capped(
      await db
        .select({ conversationId: fileConversations.conversationId })
        .from(fileConversations)
        .where(inArray(fileConversations.fileId, fileIds))
        .limit(fetchLimit),
    );
    for (const row of linkedConversations) conversationIds.add(row.conversationId);

    for (const row of capped(
      await db.select({ id: channelMessages.id }).from(channelMessages).where(inArray(channelMessages.fileId, fileIds)).limit(fetchLimit),
    )) channelMessageIds.add(row.id);
    for (const row of capped(
      await db
        .select({ id: channelMessageAttachments.messageId })
        .from(channelMessageAttachments)
        .where(inArray(channelMessageAttachments.fileId, fileIds))
        .limit(fetchLimit),
    )) channelMessageIds.add(row.id);

    for (const row of capped(
      await db
        .select({ id: directMessages.id, conversationId: directMessages.conversationId })
        .from(directMessages)
        .where(inArray(directMessages.fileId, fileIds))
        .limit(fetchLimit),
    )) {
      directMessageIds.add(row.id);
      conversationIds.add(row.conversationId);
    }
    for (const row of capped(
      await db
        .select({ id: directMessageAttachments.messageId })
        .from(directMessageAttachments)
        .where(inArray(directMessageAttachments.fileId, fileIds))
        .limit(fetchLimit),
    )) directMessageIds.add(row.id);
  }

  // AI chat attachments have no `files` row: the message body carries the
  // storage key. This is an unindexed scan of `messages`, acceptable for an
  // operation an admin runs by hand.
  const aiRows = capped(
    await db
      .select({ id: messages.id, conversationId: messages.conversationId, userId: messages.userId })
      .from(messages)
      .where(like(messages.content, `%${escapeLikePattern(`chat-attachments/${contentHash}/original`)}%`))
      .limit(fetchLimit),
  );
  for (const row of aiRows) {
    conversationIds.add(row.conversationId);
    if (row.userId) uploaders.add(row.userId);
  }

  return {
    pageIds: [...pageIds],
    fileIds,
    driveIds: [...driveIds],
    uploaderUserIds: [...uploaders],
    channelMessageIds: [...channelMessageIds],
    directMessageIds: [...directMessageIds],
    aiMessageIds: aiRows.map((row) => row.id),
    conversationIds: [...conversationIds],
    truncated,
  };
}
