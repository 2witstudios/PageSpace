import { db } from '@pagespace/db/db';
import { logActivityWithTx } from '@pagespace/lib/monitoring/activity-logger';
import { createChangeGroupId } from '@pagespace/lib/monitoring/change-group';

/**
 * Record an addressed sheet write in the activity log.
 *
 * Cell writes stopped going through `applyPageMutation`, which was the only
 * thing calling `logActivityWithTx` and returning the deferred workflow
 * trigger. Without a replacement, an agent editing a spreadsheet produced no
 * activity entry and silently stopped firing any workflow wired to that page —
 * the same failure this codebase already hit once on the form-submission path.
 *
 * Deliberately carries NO content payload. The whole point of the row store is
 * that a cell write does not persist the document; describing the change is
 * enough, and `sheet_changes` holds the per-cell detail.
 */
export async function logSheetCellActivity(input: {
  pageId: string;
  driveId: string;
  pageTitle?: string | null;
  userId: string;
  actorEmail?: string | null;
  actorDisplayName?: string | null;
  changeGroupId?: string;
  isAiGenerated?: boolean;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const trigger = await db.transaction((tx) =>
    logActivityWithTx(
      {
        userId: input.userId,
        actorEmail: input.actorEmail ?? 'unknown@system',
        actorDisplayName: input.actorDisplayName ?? undefined,
        operation: 'update',
        resourceType: 'page',
        resourceId: input.pageId,
        resourceTitle: input.pageTitle ?? undefined,
        driveId: input.driveId,
        pageId: input.pageId,
        updatedFields: ['content'],
        changeGroupId: input.changeGroupId ?? createChangeGroupId(),
        changeGroupType: input.isAiGenerated ? 'ai' : 'automation',
        isAiGenerated: input.isAiGenerated,
        metadata: input.metadata,
      },
      tx
    )
  );

  // After commit, so a workflow never observes a rolled-back write.
  trigger?.();
}
