import { db } from '@pagespace/db/db'
import { eq, and } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { taskItems, taskDependencies } from '@pagespace/db/schema/tasks'

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

/**
 * Shape a canonical blocked payload as an AI SDK tool failure result. Generic so
 * both the sub-task and dependency guards reuse it.
 */
export function toToolFailure<T extends object>(p: T): { success: false } & T {
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

// ---------------------------------------------------------------------------
// Dependency guard: a task cannot complete while it is blocked by another task
// (a task_dependencies edge whose blocker has not yet reached a done status).
// ---------------------------------------------------------------------------

export class DependencyBlockedError extends Error {
  readonly code = 'BLOCKED_BY_DEPENDENCY' as const;
  constructor(
    public readonly incomplete: number,
    public readonly total: number,
    public readonly blockers: { taskId: string; title: string }[],
  ) {
    super(`Complete blocking tasks first (${incomplete} of ${total} blockers remaining)`);
    this.name = 'DependencyBlockedError';
  }
}

/**
 * Throws DependencyBlockedError if the task (by task_items id) has any
 * non-trashed blocker task that hasn't been completed. Tasks with no blockers
 * always pass. A blocker is "incomplete" when its completedAt is null — the same
 * signal the PATCH route uses when moving a task into a done-group status.
 */
export async function assertDependenciesComplete(taskId: string): Promise<void> {
  const blockers = await db
    .select({
      blockerTaskId: taskDependencies.blockerTaskId,
      completedAt: taskItems.completedAt,
      isTrashed: pages.isTrashed,
      title: pages.title,
    })
    .from(taskDependencies)
    .innerJoin(taskItems, eq(taskItems.id, taskDependencies.blockerTaskId))
    .innerJoin(pages, eq(pages.id, taskItems.pageId))
    .where(eq(taskDependencies.blockedTaskId, taskId));

  const active = blockers.filter(b => !b.isTrashed);
  if (active.length === 0) return;

  const incomplete = active.filter(b => b.completedAt === null);
  if (incomplete.length > 0) {
    throw new DependencyBlockedError(
      incomplete.length,
      active.length,
      incomplete.map(b => ({ taskId: b.blockerTaskId, title: b.title })),
    );
  }
}

/** HTTP status returned when a completion is blocked by an incomplete blocker. */
export const DEPENDENCY_BLOCKED_STATUS = 422 as const;

/** Canonical, transport-agnostic description of a completion blocked by a dependency. */
export interface DependencyBlockedPayload {
  code: 'BLOCKED_BY_DEPENDENCY';
  error: string;
  incomplete: number;
  total: number;
  blockers: { taskId: string; title: string }[];
}

/** Map a DependencyBlockedError into the canonical blocked payload. */
export function toDependencyBlockedPayload(e: DependencyBlockedError): DependencyBlockedPayload {
  return { code: e.code, error: e.message, incomplete: e.incomplete, total: e.total, blockers: e.blockers };
}

/**
 * Run the dependency completion guard for a task (by task_items id).
 *
 * Returns `null` when completion is allowed, or the canonical
 * DependencyBlockedPayload when the task still has an incomplete blocker.
 * Unexpected errors are rethrown. Single entry point for all completion paths.
 */
export async function checkDependenciesComplete(
  taskId: string,
): Promise<DependencyBlockedPayload | null> {
  try {
    await assertDependenciesComplete(taskId);
    return null;
  } catch (error) {
    if (error instanceof DependencyBlockedError) {
      return toDependencyBlockedPayload(error);
    }
    throw error;
  }
}
