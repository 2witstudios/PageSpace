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
 * - remove the row when the page leaves a TASK_LIST parent
 * - add the row when the page lands under a TASK_LIST parent
 *
 * No-op for non-TASK_LIST pages and for pure reorders (parent unchanged).
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
  return {
    shouldRemove: input.oldParentId !== null && input.oldParentType === TASK_LIST_TYPE,
    shouldAdd: input.newParentId !== null && input.newParentType === TASK_LIST_TYPE,
  };
};

export interface TaskItemInsert {
  readonly userId: string;
  readonly pageId: string;
  readonly status: 'pending';
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
}): TaskItemInsert => ({
  userId: input.userId,
  pageId: input.pageId,
  status: 'pending',
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
