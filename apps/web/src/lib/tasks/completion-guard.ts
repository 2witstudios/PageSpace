import { db } from '@pagespace/db/db'
import { eq, and } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { taskItems } from '@pagespace/db/schema/tasks'

export class SubtasksIncompleteError extends Error {
  readonly code = 'SUBTASKS_INCOMPLETE' as const;
  constructor(
    public readonly pending: number,
    public readonly total: number,
  ) {
    super(`Complete all sub-tasks first (${pending} of ${total} remaining)`);
    this.name = 'SubtasksIncompleteError';
  }
}

/**
 * Throws SubtasksIncompleteError if the task page has any non-trashed child
 * tasks that haven't been completed. Leaf tasks (no children) always pass.
 */
export async function assertSubTasksComplete(taskPageId: string): Promise<void> {
  const subTasks = await db
    .select({ completedAt: taskItems.completedAt })
    .from(taskItems)
    .innerJoin(pages, eq(pages.id, taskItems.pageId))
    .where(and(
      eq(pages.parentId, taskPageId),
      eq(pages.isTrashed, false),
    ));

  if (subTasks.length === 0) return;

  const pending = subTasks.filter(t => t.completedAt === null).length;
  if (pending > 0) {
    throw new SubtasksIncompleteError(pending, subTasks.length);
  }
}

/** HTTP status returned when a completion is blocked by incomplete sub-tasks. */
export const SUBTASKS_INCOMPLETE_STATUS = 422 as const;

/**
 * Canonical, transport-agnostic description of a completion blocked by
 * incomplete sub-tasks. Every entry point (AI tools, REST/MCP) shapes its
 * response from this single payload so the reason is identical everywhere.
 */
export interface SubtasksBlockedPayload {
  code: 'SUBTASKS_INCOMPLETE';
  error: string;
  pending: number;
  total: number;
}

/** Map a SubtasksIncompleteError into the canonical blocked payload. */
export function toBlockedPayload(e: SubtasksIncompleteError): SubtasksBlockedPayload {
  return { code: e.code, error: e.message, pending: e.pending, total: e.total };
}

/** Shape the canonical payload as an AI SDK tool failure result. */
export function toToolFailure(
  p: SubtasksBlockedPayload,
): { success: false } & SubtasksBlockedPayload {
  return { success: false, ...p };
}

/**
 * Run the sub-task completion guard for a task page.
 *
 * Returns `null` when completion is allowed, or the canonical
 * SubtasksBlockedPayload when the task still has incomplete sub-tasks.
 * Unexpected errors are rethrown. This is the single entry point all
 * completion paths should use instead of calling assertSubTasksComplete +
 * catching SubtasksIncompleteError themselves.
 */
export async function checkSubTasksComplete(
  taskPageId: string,
): Promise<SubtasksBlockedPayload | null> {
  try {
    await assertSubTasksComplete(taskPageId);
    return null;
  } catch (error) {
    if (error instanceof SubtasksIncompleteError) {
      return toBlockedPayload(error);
    }
    throw error;
  }
}
