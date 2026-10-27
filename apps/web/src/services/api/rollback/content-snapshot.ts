/**
 * Content-snapshot resolution shell.
 *
 * Resolves an activity's content snapshot, reading from the content store via
 * the injected readContent when only a ref is present. A read failure is logged
 * and swallowed (returns null) to match the pre-refactor behavior.
 */
import type { RollbackDeps } from './deps';
import type { ActivityLogForRollback } from './types';

export async function resolveActivityContentSnapshot(
  deps: RollbackDeps,
  activity: ActivityLogForRollback
): Promise<string | null> {
  if (activity.contentSnapshot) {
    return activity.contentSnapshot;
  }

  if (activity.contentRef) {
    try {
      return await deps.readContent(activity.contentRef);
    } catch (error) {
      deps.logger.warn('[RollbackService] Failed to read content snapshot', {
        activityId: activity.id,
        contentRef: activity.contentRef,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  return null;
}
