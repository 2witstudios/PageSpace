import { db } from '@pagespace/db/db'
import { eq, and, asc, inArray, isNotNull } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { taskLists, taskItems, taskAssignees, taskStatusConfigs, DEFAULT_TASK_STATUSES } from '@pagespace/db/schema/tasks'
import { taskTriggers } from '@pagespace/db/schema/task-triggers'
import { workflows } from '@pagespace/db/schema/workflows'
import {
  TASK_LIST_TYPE,
  shouldHaveTaskItem,
  resolveTaskItemSyncAction,
  buildTaskItemInsert,
  selectMissingTaskItemPageIds,
} from './task-membership'

type Tx = typeof db

/**
 * Imperative shells over the pure membership logic in `task-membership.ts`.
 *
 * Invariant: every TASK_LIST page whose `pages.parentId` points to another TASK_LIST
 * page must have exactly one `task_items` row with pageId = that page's id. These shells
 * are the single place that enforces it; the pure functions decide what to do.
 */

async function getPageType(tx: Tx, pageId: string): Promise<string | null> {
  const [page] = await tx
    .select({ type: pages.type })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1)
  return page?.type ?? null
}

/**
 * Seed the default `task_status_configs` for a `task_lists` row. Swallows a
 * unique-constraint violation on `(taskListId, slug)` — a concurrent caller may have
 * seeded the same list a moment earlier; the caller only needed the configs to exist.
 */
export async function seedDefaultTaskStatusConfigs(tx: Tx, taskListId: string): Promise<void> {
  try {
    await tx.insert(taskStatusConfigs).values(
      DEFAULT_TASK_STATUSES.map(s => ({ taskListId, ...s }))
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : ''
    if (!message.includes('unique') && !message.includes('duplicate')) throw err
  }
}

/**
 * Ensure a TASK_LIST page has its `task_lists` row and default `task_status_configs`
 * seeded. Idempotent — a no-op if the `task_lists` row already exists. Callers that
 * separately look up `task_status_configs` for display (the MCP documents `read` route,
 * `page-read-tools.ts`'s `read_page`) also call `seedDefaultTaskStatusConfigs` when that
 * lookup comes back empty, so a legacy `task_lists` row missed by a pre-fix lazy-init
 * path gets backfilled on next read instead of staying half-initialized forever.
 *
 * Called from every page-creation and lazy-init entry point that seeds a TASK_LIST
 * page's *own* task list (`page-service.ts`, `page-write-tools.ts`'s `create_page`,
 * the MCP documents `read` route, and `page-read-tools.ts`'s `read_page`) — skipping
 * it is what leaves `taskStatusConfigs` empty and crashes the Kanban UI
 * (`STATUS_GROUP_CONFIG[group]` lookup with no matching group).
 */
export async function ensureTaskListForPage(
  tx: Tx,
  params: { pageId: string; title: string; userId: string; metadata?: Record<string, unknown> },
): Promise<typeof taskLists.$inferSelect> {
  const { pageId, title, userId, metadata } = params

  let taskList = await tx.query.taskLists.findFirst({
    where: eq(taskLists.pageId, pageId),
  })

  if (!taskList) {
    const [created] = await tx.insert(taskLists).values({
      userId,
      pageId,
      title,
      status: 'pending',
      ...(metadata ? { metadata } : {}),
    }).returning()
    taskList = created

    await seedDefaultTaskStatusConfigs(tx, created.id)
  }

  return taskList
}

/**
 * Create the `task_items` row for a page under a known TASK_LIST parent.
 * Idempotent — does nothing if the row already exists. Ensures the parent's
 * `task_lists` row and default status configs exist first.
 */
/**
 * Upper bound on the status vocabulary scanned when remapping. Lists carry 4 defaults
 * and a handful of custom statuses; the cap exists to satisfy the unbounded-findMany
 * rule, and overshooting it could only cost a remap to a different valid slug.
 */
const STATUS_CONFIG_REMAP_LIMIT = 200

/**
 * Keep a PRESERVED task row's status inside its new list's vocabulary.
 *
 * `task_items.status` is a bare slug with no foreign key; its meaning comes from the
 * owning list's `task_status_configs`, unique per (taskListId, slug). Every write path
 * enforces that — POST/PATCH reject an unknown slug, and deleting a config demands a
 * migrateToSlug — so a move is the only way to produce a task whose status its list
 * does not define. Left alone, such a task falls into the board's first column
 * regardless of meaning, renders its raw slug as a badge, drops out of status-filtered
 * queries, and (when the slug was a done one) shows unticked while `completedAt` still
 * counts it complete in the parent's progress.
 *
 * Re-mapping uses `completedAt`, which lives on the row itself and is list-independent,
 * so a finished task stays finished and an unfinished one stays actionable.
 */
async function normalizeStatusForList(
  tx: Tx,
  params: { item: { id: string; status: string; completedAt: Date | null }; taskListId: string },
): Promise<void> {
  const { item, taskListId } = params

  // Fast path: one indexed lookup on the (taskListId, slug) unique key. The status is
  // valid for its new list in every case except the one this function exists for, so
  // the full vocabulary is only fetched when a remap is actually needed.
  const alreadyValid = await tx.query.taskStatusConfigs.findFirst({
    where: and(
      eq(taskStatusConfigs.taskListId, taskListId),
      eq(taskStatusConfigs.slug, item.status),
    ),
  })
  if (alreadyValid) return

  const configs = await tx.query.taskStatusConfigs.findMany({
    where: eq(taskStatusConfigs.taskListId, taskListId),
    orderBy: [asc(taskStatusConfigs.position)],
    limit: STATUS_CONFIG_REMAP_LIMIT,
  })
  // A list with no configs at all has no vocabulary to conform to.
  if (configs.length === 0) return

  // Never fall back across the done boundary. PUT /tasks/statuses validates each
  // config's group but does not guarantee a list retains one of each, so a plain
  // `?? configs[0]` could drop an unfinished task onto a done-group slug (ticked and
  // struck through while every completedAt-based count still calls it incomplete) or
  // the reverse. Completed work stays in a done slug or, failing that, the last one;
  // unfinished work stays in any non-done slug.
  const replacement = item.completedAt
    ? (configs.find((config) => config.group === 'done') ?? configs[configs.length - 1])
    : (configs.find((config) => config.group === 'todo')
        ?? configs.find((config) => config.group !== 'done')
        ?? configs[0])

  await tx
    .update(taskItems)
    .set({ status: replacement.slug })
    .where(eq(taskItems.id, item.id))
}

/**
 * The slug a brand-new task should start in for THIS list. Defaults to 'pending' only
 * when the list still defines it; a list whose owner deleted that status (permitted via
 * migrateToSlug) gets its own first todo-group slug instead, so the seed can never be a
 * status its own list does not define.
 */
async function resolveSeedStatus(tx: Tx, taskListId: string): Promise<string> {
  const defaultSlug = DEFAULT_TASK_STATUSES[0].slug
  const hasDefault = await tx.query.taskStatusConfigs.findFirst({
    where: and(
      eq(taskStatusConfigs.taskListId, taskListId),
      eq(taskStatusConfigs.slug, defaultSlug),
    ),
  })
  if (hasDefault) return defaultSlug

  const configs = await tx.query.taskStatusConfigs.findMany({
    where: eq(taskStatusConfigs.taskListId, taskListId),
    orderBy: [asc(taskStatusConfigs.position)],
    limit: STATUS_CONFIG_REMAP_LIMIT,
  })
  const seed = configs.find((config) => config.group === 'todo')
    ?? configs.find((config) => config.group !== 'done')
    ?? configs[0]
  return seed?.slug ?? defaultSlug
}

/**
 * Drop the associations on a task row that are scoped to the drive it just LEFT.
 *
 * A cross-drive move preserves the row — priority, dueDate, metadata and human
 * assignees are all drive-independent — but three things are not, and the task write
 * paths actively refuse to create them across a boundary:
 *   • `assigneeAgentId` and `task_assignees.agentPageId` name agent pages in the old
 *     drive; left in place, a drive-A agent's title renders to every drive-B viewer and
 *     cannot be edited away, because a PATCH re-sending that agent id now 400s.
 *   • `task_triggers` link the task to `workflows`, which carry their own NOT NULL
 *     driveId; a drive-B member completing the task would otherwise fire a drive-A
 *     agent run seeded with drive-B content.
 *
 * The workflows rows are deleted FIRST and by explicit id: `task_triggers.taskItemId`
 * cascades from `task_items`, so any approach that removes triggers first leaves the
 * workflows behind, orphaned and unreachable (the hazard task-trigger-helpers'
 * disableTaskTriggers documents). Everything runs in the caller's transaction, so a
 * failed move takes the scrub with it.
 */
export async function scrubDriveScopedTaskAssociations(
  tx: Tx,
  params: { pageIds: string[] },
): Promise<void> {
  const { pageIds } = params
  if (pageIds.length === 0) return

  const rows = await tx
    .select({ id: taskItems.id })
    .from(taskItems)
    .where(inArray(taskItems.pageId, pageIds))
  if (rows.length === 0) return
  const taskItemIds = rows.map((row) => row.id)

  const triggerRows = await tx
    .select({ workflowId: taskTriggers.workflowId })
    .from(taskTriggers)
    .where(inArray(taskTriggers.taskItemId, taskItemIds))
  if (triggerRows.length > 0) {
    // Deleting the workflow cascades its task_triggers rows away.
    await tx.delete(workflows).where(inArray(workflows.id, triggerRows.map((r) => r.workflowId)))
  }

  await tx
    .delete(taskAssignees)
    .where(and(inArray(taskAssignees.taskId, taskItemIds), isNotNull(taskAssignees.agentPageId)))

  await tx
    .update(taskItems)
    .set({ assigneeAgentId: null })
    .where(inArray(taskItems.id, taskItemIds))
}

async function addTaskItemUnderParent(
  tx: Tx,
  params: { pageId: string; parentId: string; userId: string },
): Promise<void> {
  const { pageId, parentId, userId } = params

  const taskList = await ensureTaskListForPage(tx, { pageId: parentId, title: 'Task List', userId })

  const existing = await tx.query.taskItems.findFirst({
    where: eq(taskItems.pageId, pageId),
  })
  if (existing) {
    await normalizeStatusForList(tx, { item: existing, taskListId: taskList.id })
    return
  }

  // ON CONFLICT DO NOTHING guards the self-heal race: concurrent GETs on a legacy list
  // can both pass the findFirst check above, and task_items.pageId is unique — without
  // this a second insert would 500 the read. The findFirst stays as a cheap fast path.
  await tx.insert(taskItems).values(
    buildTaskItemInsert({ pageId, userId, status: await resolveSeedStatus(tx, taskList.id) }),
  ).onConflictDoNothing({ target: taskItems.pageId })
}

/**
 * Ensure a freshly created or re-parented page has its `task_items` row when it is a
 * TASK_LIST nested under a TASK_LIST. No-op otherwise. Use from every page-creation path.
 */
export async function ensureTaskItemForPage(
  tx: Tx,
  params: { pageId: string; pageType: string; parentId: string | null; userId: string },
): Promise<void> {
  const { pageId, pageType, parentId, userId } = params

  // Short-circuit before any I/O: only TASK_LIST pages with a parent can qualify.
  if (pageType !== TASK_LIST_TYPE || !parentId) return

  const parentType = await getPageType(tx, parentId)
  if (!shouldHaveTaskItem({ pageType, parentType })) return

  await addTaskItemUnderParent(tx, { pageId, parentId, userId })
}

/**
 * Sync `task_items` membership when a page is moved.
 * - Moving INTO a TASK_LIST parent → create the row (idempotent)
 * - Moving OUT OF a TASK_LIST parent → delete the row
 */
export async function syncTaskItemOnMove(
  tx: Tx,
  params: {
    movedPageId: string;
    movedPageType: string;
    oldParentId: string | null;
    newParentId: string | null;
    userId: string;
  }
): Promise<void> {
  const { movedPageId, movedPageType, oldParentId, newParentId, userId } = params

  // Cheap guards before any parent lookups.
  if (movedPageType !== TASK_LIST_TYPE || oldParentId === newParentId) return

  const oldParentType = oldParentId ? await getPageType(tx, oldParentId) : null
  const newParentType = newParentId ? await getPageType(tx, newParentId) : null

  const action = resolveTaskItemSyncAction({
    movedPageType,
    oldParentId,
    newParentId,
    oldParentType,
    newParentType,
  })

  if (action.shouldRemove) {
    await tx.delete(taskItems).where(eq(taskItems.pageId, movedPageId))
  }

  if (action.shouldAdd && newParentId) {
    await addTaskItemUnderParent(tx, { pageId: movedPageId, parentId: newParentId, userId })
  }
}

/**
 * Self-heal: ensure every given TASK_LIST child of `parentId` has a `task_items` row.
 * Backfills rows missed by any creation/move path (or created before this invariant
 * was enforced). Caller is responsible for passing only TASK_LIST children of `parentId`.
 *
 * Reads on the connection first and only opens a transaction when something is actually
 * missing, so the common (nothing-to-heal) case on this hot read path stays cheap.
 */
export async function backfillMissingTaskItems(
  database: Tx,
  params: { parentId: string; childPageIds: string[]; userId: string },
): Promise<void> {
  const { parentId, childPageIds, userId } = params
  if (childPageIds.length === 0) return

  const existingRows = await database
    .select({ pageId: taskItems.pageId })
    .from(taskItems)
    .where(inArray(taskItems.pageId, childPageIds))

  const missing = selectMissingTaskItemPageIds({
    childPageIds,
    existingTaskItemPageIds: existingRows.map(r => r.pageId),
  })
  if (missing.length === 0) return

  await database.transaction(async (tx) => {
    for (const pageId of missing) {
      await addTaskItemUnderParent(tx, { pageId, parentId, userId })
    }
  })
}
