import { db } from '@pagespace/db/db'
import { eq, inArray } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { taskLists, taskItems, taskStatusConfigs, DEFAULT_TASK_STATUSES } from '@pagespace/db/schema/tasks'
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
async function addTaskItemUnderParent(
  tx: Tx,
  params: { pageId: string; parentId: string; userId: string },
): Promise<void> {
  const { pageId, parentId, userId } = params

  await ensureTaskListForPage(tx, { pageId: parentId, title: 'Task List', userId })

  const existing = await tx.query.taskItems.findFirst({
    where: eq(taskItems.pageId, pageId),
  })
  if (existing) return

  // ON CONFLICT DO NOTHING guards the self-heal race: concurrent GETs on a legacy list
  // can both pass the findFirst check above, and task_items.pageId is unique — without
  // this a second insert would 500 the read. The findFirst stays as a cheap fast path.
  await tx.insert(taskItems).values(
    buildTaskItemInsert({ pageId, userId }),
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
