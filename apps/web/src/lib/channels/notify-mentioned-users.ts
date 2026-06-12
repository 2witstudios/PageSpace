import { expandMentionsToUserIds } from './expand-group-mentions';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
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

    const viewChecks = await Promise.all(
      candidates.map(async (id) => ({ id, canView: await canUserViewPage(id, pageId) }))
    );

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
