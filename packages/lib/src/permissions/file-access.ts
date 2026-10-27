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
import type { AccessActor } from './access-actor';
import { checkActorDriveAuthentication } from './actor-authentication';

export async function canUserAccessFile(
  actor: AccessActor,
  fileId: string,
  driveId: string | null
): Promise<boolean> {
  const { userId } = actor;
  // SEC-2/3: a file stored in an org drive is that org's content, whatever links it elsewhere.
  if (driveId !== null && !(await checkActorDriveAuthentication(actor, driveId)).allowed) return false;
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
      if (await canUserViewPage(actor, pageId)) return true;
    }
    for (const { participant1Id, participant2Id } of linkedConversations) {
      if (participant1Id === userId || participant2Id === userId) return true;
    }
    return false;
  }

  if (driveId === null) return false;
  return isUserDriveMember(actor, driveId);
}
