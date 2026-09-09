import { db } from '@pagespace/db/db';
import { logActivityWithTx } from '@pagespace/lib/monitoring/activity-logger';
import { createChangeGroupId } from '@pagespace/lib/monitoring/change-group';
import { loggers } from '@pagespace/lib/logging/logger-config';

/**
 * Record an addressed sheet write in the activity log.
 *
 * Cell writes stopped going through `applyPageMutation`, which was the only
 * thing calling `logActivityWithTx` and returning the deferred workflow
 * trigger. Without a replacement, an agent editing a spreadsheet produced no
 * activity entry and silently stopped firing any workflow wired to that page —
 * the same failure this codebase already hit once on the form-submission path.
 *
 * NEVER THROWS. Every caller runs this AFTER the cell write has committed, so
 * a failure here cannot undo anything — rethrowing would turn a successful
 * write into a 500 and invite the agent to retry an edit that already landed,
 * double-applying relative updates. The write is the user's data; the activity
 * entry is our bookkeeping, and losing the latter must not corrupt the former.
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
  let trigger: (() => void) | undefined | null;
  try {
    trigger = await db.transaction((tx) =>
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
          metadata: {
            ...input.metadata,
            // Marks this entry as an addressed cell write, which carries no
            // content to restore. Rollback reports it as ineligible rather than
            // throwing "No values to restore" — so no Undo affordance is offered
            // that could only fail. `sheet_changes` holds the per-cell
            // before/after for a future change that can replay it.
            sheetCellWrite: true,
          },
        },
        tx
      )
    );
  } catch (error) {
    loggers.api.error(
      'Failed to log sheet cell activity',
      error instanceof Error ? error : new Error(String(error)),
      { pageId: input.pageId, driveId: input.driveId }
    );
    return;
  }

  // After commit, so a workflow never observes a rolled-back write.
  try {
    trigger?.();
  } catch (error) {
    loggers.api.error(
      'Sheet cell activity workflow trigger failed',
      error instanceof Error ? error : new Error(String(error)),
      { pageId: input.pageId }
    );
  }
}
