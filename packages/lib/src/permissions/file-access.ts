/**
 * File Access Authorization
 *
 * Files can be linked to pages (via `filePages`) or to DM conversations
 * (via `fileConversations`). When linkages exist, access requires qualifying
 * on at least one of them — page-view permission for any linked page, or
 * participation in any linked conversation. With no linkages, access falls
 * back to drive membership; conversation-uploaded files have `driveId = null`
 * and no linkage means deny.
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { fileConversations, filePages } from '@pagespace/db/schema/storage';
import { dmConversations } from '@pagespace/db/schema/social';
import { canUserViewPage, isUserDriveMember } from './permissions';

export async function canUserAccessFile(
  userId: string,
  fileId: string,
  driveId: string | null
): Promise<boolean> {
  const [linkedPages, linkedConversations] = await Promise.all([
    db
      .select({ pageId: filePages.pageId })
      .from(filePages)
      .where(eq(filePages.fileId, fileId)),
    db
      .select({
        participant1Id: dmConversations.participant1Id,
        participant2Id: dmConversations.participant2Id,
      })
      .from(fileConversations)
      .innerJoin(dmConversations, eq(dmConversations.id, fileConversations.conversationId))
      .where(eq(fileConversations.fileId, fileId)),
  ]);

  const hasLinkages = linkedPages.length > 0 || linkedConversations.length > 0;

  if (hasLinkages) {
    for (const { pageId } of linkedPages) {
      if (await canUserViewPage(userId, pageId)) return true;
    }
    for (const { participant1Id, participant2Id } of linkedConversations) {
      if (participant1Id === userId || participant2Id === userId) return true;
    }
    return false;
  }

  if (driveId === null) return false;
  return isUserDriveMember(userId, driveId);
}
