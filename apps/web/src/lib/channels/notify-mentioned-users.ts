import { expandMentionsToUserIds } from './expand-group-mentions';
import { getUsersWhoCanViewPage } from '@pagespace/lib/permissions/permissions';
import { createMentionNotification } from '@pagespace/lib/notifications/notifications';
import { loggers } from '@pagespace/lib/logging/logger-config';

const logger = loggers.realtime;

export async function notifyMentionedUsers(opts: {
  content: string;
  pageId: string;
  driveId: string;
  triggeredByUserId: string;
  mentionerNameOverride?: string;
}): Promise<void> {
  try {
    const { content, pageId, driveId, triggeredByUserId, mentionerNameOverride } = opts;
    const mentionedIds = await expandMentionsToUserIds(content, driveId);
    const candidates = mentionedIds.filter((id) => id !== triggeredByUserId);
    if (candidates.length === 0) return;

    // Who may be notified is an audience question about third parties, not an access decision for a caller.
    const viewers = await getUsersWhoCanViewPage(pageId, candidates);
    const viewChecks = candidates.map((id) => ({ id, canView: viewers.has(id) }));

    await Promise.all(
      viewChecks
        .filter((e) => e.canView)
        .map((e) =>
          createMentionNotification(
            e.id,
            pageId,
            triggeredByUserId,
            mentionerNameOverride ? { mentionerNameOverride } : undefined
          ).catch((err) =>
            logger.error('Failed to send agent mention notification', err as Error)
          )
        )
    );
  } catch (err) {
    logger.error('Failed to resolve agent mention targets', err as Error);
  }
}
