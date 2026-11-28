import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';

/**
 * SPEND-7: an AI call's spend is attributed to the drive of the SESSION it runs in — the
 * conversation it answers — never to the drive an agent page lives in. A global
 * conversation has no drive (SPEND-8: personal credits); a drive conversation names its
 * drive; a page conversation runs in its page's drive.
 */
export async function conversationSessionDriveId(conversation: {
  type: string;
  contextId: string | null;
}): Promise<string | null> {
  if (!conversation.contextId) return null;
  if (conversation.type === 'drive') return conversation.contextId;
  if (conversation.type !== 'page') return null;
  const [page] = await db
    .select({ driveId: pages.driveId })
    .from(pages)
    .where(eq(pages.id, conversation.contextId))
    .limit(1);
  return page?.driveId ?? null;
}
