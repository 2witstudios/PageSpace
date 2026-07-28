/**
 * Pure decision logic for task-list membership.
 *
 * Membership of a page in a task list is determined by the page tree: a TASK_LIST
 * page whose `parentId` points to another TASK_LIST page is a task in that parent.
 * The `task_items` row is a metadata sidecar (status, priority, assignee)
 * that must mirror that relationship. Ordering is NOT part of it — that lives on
 * `pages.position` alone (#2143).
 *
 * These functions decide WHAT must change. The imperative shells in
 * `task-sync-service.ts` look up types and perform the database I/O.
 */

export const TASK_LIST_TYPE = 'TASK_LIST';

/**
 * A page belongs in its parent's task list iff it is a TASK_LIST nested under a
 * TASK_LIST. A root page (null/undefined parent type) never qualifies.
 */
export const shouldHaveTaskItem = (input: {
  pageType: string;
  parentType: string | null | undefined;
}): boolean =>
  input.pageType === TASK_LIST_TYPE && input.parentType === TASK_LIST_TYPE;

export interface TaskItemSyncAction {
  readonly shouldRemove: boolean;
  readonly shouldAdd: boolean;
}

/**
 * Decide which `task_items` mutations a page move requires:
 * - remove the row when the page LEAVES task-list membership entirely
 * - add the row when the page lands under a TASK_LIST parent
 *
 * No-op for non-TASK_LIST pages and for pure reorders (parent unchanged).
 *
 * Moving between two TASK_LIST parents WITHIN A DRIVE deliberately does NOT remove.
 * The row is keyed by pageId and carries no pointer to its list — membership is
 * derived from pages.parentId — so it stays valid under the new parent. Removing
 * and re-adding would destroy the user's data: addTaskItemUnderParent re-inserts
 * bare defaults (status 'pending', priority 'medium'), and task_assignees cascades
 * on the delete, so a task dragged between two lists silently lost its status,
 * priority, due date, metadata and every assignee. `shouldAdd` stays true for that
 * case so the destination list is still seeded (task_lists row + default status
 * configs) and a genuinely missing row is still backfilled — addTaskItemUnderParent
 * returns early when a row already exists, which is what preserves it.
 *
 * A CROSS-DRIVE move preserves the row too, but the caller must first scrub what IS
 * drive-scoped — see scrubDriveScopedTaskAssociations. Deleting the row instead would
 * throw away priority, dueDate and metadata, none of which are drive-scoped, and would
 * only cover the moved ROOTS: a descendant's parentId never changes, so no membership
 * event fires for it even though its drive did change.
 */
export const resolveTaskItemSyncAction = (input: {
  movedPageType: string;
  oldParentId: string | null;
  newParentId: string | null;
  oldParentType: string | null | undefined;
  newParentType: string | null | undefined;
}): TaskItemSyncAction => {
  if (input.movedPageType !== TASK_LIST_TYPE || input.oldParentId === input.newParentId) {
    return { shouldRemove: false, shouldAdd: false };
  }
  const landsInTaskList = input.newParentId !== null && input.newParentType === TASK_LIST_TYPE;
  const leavesTaskList = input.oldParentId !== null && input.oldParentType === TASK_LIST_TYPE;
  return {
    shouldRemove: leavesTaskList && !landsInTaskList,
    shouldAdd: landsInTaskList,
  };
};

export interface TaskItemInsert {
  readonly userId: string;
  readonly pageId: string;
  readonly status: string;
  readonly priority: 'medium';
}

/**
 * Build the row for a new task item linked to a page.
 *
 * Carries no position: order lives solely on the linked page's `pages.position`
 * (#2143), which the page itself already has by the time this row is created.
 */
export const buildTaskItemInsert = (input: {
  pageId: string;
  userId: string;
  /**
   * Slug to seed. Defaults to 'pending' — the first of DEFAULT_TASK_STATUSES — but a
   * list whose owner deleted that status (permitted, via migrateToSlug) does not define
   * it, and a hardcoded seed would create exactly the orphaned-status row that
   * normalizeStatusForList exists to prevent. Callers that know the destination's
   * vocabulary pass its default instead.
   */
  status?: string;
}): TaskItemInsert => ({
  userId: input.userId,
  pageId: input.pageId,
  status: input.status ?? 'pending',
  priority: 'medium',
});

/**
 * Given candidate child page ids and the ids that already have a task item,
 * return those still missing one — order preserved, deduped.
 */
export const selectMissingTaskItemPageIds = (input: {
  childPageIds: readonly string[];
  existingTaskItemPageIds: readonly string[];
}): string[] => {
  const existing = new Set(input.existingTaskItemPageIds);
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const id of input.childPageIds) {
    if (existing.has(id) || seen.has(id)) continue;
    seen.add(id);
    missing.push(id);
  }
  return missing;
};
