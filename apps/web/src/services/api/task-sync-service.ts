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
 * Upper bound on the status vocabulary scanned when remapping. Lists carry 4 defaults
 * and a handful of custom statuses; the cap exists to satisfy the unbounded-findMany
 * rule, and overshooting it could only cost a remap to a different valid slug.
 */
const STATUS_CONFIG_REMAP_LIMIT = 200

/**
 * Postgres caps a statement at 65535 bind parameters. The cascade binds one inArray per
 * tree level, which is naturally bounded; a whole-subtree scrub is not, so it chunks.
 */
const SCRUB_CHUNK_SIZE = 1000

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

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
 * Only the genuinely broken case is repaired: a slug the destination does not define at
 * all. `completedAt` is the intent signal for the replacement, so a finished task stays
 * finished and an unfinished one stays actionable. A slug the list DOES define is left
 * untouched — see the note at the short-circuit for why neither field may be rewritten.
 */
async function normalizeStatusForList(
  tx: Tx,
  params: { item: { id: string; status: string; completedAt: Date | null }; taskListId: string },
): Promise<void> {
  const { item, taskListId } = params

  // Fast path: one indexed lookup on the (taskListId, slug) unique key.
  //
  // A slug match is not proof the status means the same thing — slugs come from
  // slugify(name) and each list picks its own group, so "Review" can be `done` in one
  // list and `in_progress` in another, leaving the row's group at odds with its own
  // completedAt. That is knowingly tolerated; see below for why neither field may be
  // rewritten to reconcile it.
  const alreadyValid = await tx.query.taskStatusConfigs.findFirst({
    where: and(
      eq(taskStatusConfigs.taskListId, taskListId),
      eq(taskStatusConfigs.slug, item.status),
    ),
  })
  // A defined slug is left completely alone, even when its group disagrees with
  // completedAt. Both available "repairs" are worse than the disagreement:
  //   • rewriting `status` reverses a deliberate regroup — the owner who moved "Review"
  //     out of the done group would find every such task flung back into Done;
  //   • rewriting `completedAt` fabricates a completion time (bypassing the sub-task
  //     guard that makes PATCH return 422, and permanently disabling the task's
  //     due-date trigger) or destroys a real one that nothing else records.
  // The disagreement is not new or move-specific either: PUT /tasks/statuses regroups a
  // config in place and DELETE+migrateToSlug re-points tasks, both leaving it inside a
  // single list. The product already tolerates it there, so a move must not pay for it
  // with the user's data.
  if (alreadyValid) return

  const configs = await tx.query.taskStatusConfigs.findMany({
    where: eq(taskStatusConfigs.taskListId, taskListId),
    orderBy: [asc(taskStatusConfigs.position)],
    limit: STATUS_CONFIG_REMAP_LIMIT,
  })
  // A list with no configs at all has no vocabulary to conform to.
  if (configs.length === 0) return

  // Never land on the wrong side of the done boundary. (The per-group deletion guard in
  // the statuses route means a list with any configs keeps at least one of each group,
  // so the final `?? configs[...]` arms are defence rather than live paths.)
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
async function resolveSeedStatus(
  tx: Tx,
  taskListId: string,
  cache?: Map<string, string>,
): Promise<string> {
  const cached = cache?.get(taskListId)
  if (cached !== undefined) return cached
  const resolved = await resolveSeedStatusUncached(tx, taskListId)
  cache?.set(taskListId, resolved)
  return resolved
}

async function resolveSeedStatusUncached(tx: Tx, taskListId: string): Promise<string> {
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
 * Only associations that genuinely stayed behind are dropped: an agent page that moved
 * WITH the task (a project folder carrying both its task list and its agent) is still
 * valid in the new drive and is left alone. Everything runs in the caller's
 * transaction, so a failed move takes the scrub with it, and every id list is chunked
 * because a whole subtree can exceed Postgres' bind-parameter cap.
 */
export async function scrubDriveScopedTaskAssociations(
  tx: Tx,
  params: { pageIds: string[]; targetDriveId: string },
): Promise<void> {
  const { pageIds, targetDriveId } = params
  if (pageIds.length === 0) return

  const taskItemIds: string[] = []
  const agentPageIds = new Set<string>()
  for (const batch of chunk(pageIds, SCRUB_CHUNK_SIZE)) {
    const rows = await tx
      .select({ id: taskItems.id, assigneeAgentId: taskItems.assigneeAgentId })
      .from(taskItems)
      .where(inArray(taskItems.pageId, batch))
    for (const row of rows) {
      taskItemIds.push(row.id)
      if (row.assigneeAgentId) agentPageIds.add(row.assigneeAgentId)
    }
  }
  if (taskItemIds.length === 0) return

  for (const batch of chunk(taskItemIds, SCRUB_CHUNK_SIZE)) {
    const rows = await tx
      .select({ agentPageId: taskAssignees.agentPageId })
      .from(taskAssignees)
      .where(and(inArray(taskAssignees.taskId, batch), isNotNull(taskAssignees.agentPageId)))
    for (const row of rows) if (row.agentPageId) agentPageIds.add(row.agentPageId)
  }

  // An agent that travelled WITH the task is not stale — moving a project folder that
  // contains both a task list and the agent it assigns work to must not silently drop
  // the assignment. Only agents left behind in the old drive are scrubbed.
  const residency: DriveResidency = new Map()
  const staleAgentIds = await resolveAgentsOutsideDrive(tx, [...agentPageIds], targetDriveId, residency)

  // Trigger staleness is resolved SEPARATELY from assignment staleness. A trigger's
  // agent comes from workflows.agentPageId, which PUT /api/tasks/:id/triggers sets
  // without touching task_items.assigneeAgentId — a task can carry a trigger and no
  // assignee at all, or a trigger naming a different agent than its assignee. Keying
  // the sweep off the assignee set let exactly those workflows survive a move, still
  // pointing at a source-drive agent, which is the leak this whole function exists to
  // stop. Workflows whose agent came along are repointed at the new drive instead of
  // being deleted, since their driveId is stamped once at creation and never rewritten.
  await reconcileTaskTriggerWorkflows(tx, taskItemIds, targetDriveId, residency)

  if (staleAgentIds.length === 0) return

  for (const batch of chunk(taskItemIds, SCRUB_CHUNK_SIZE)) {
    await tx
      .delete(taskAssignees)
      .where(and(inArray(taskAssignees.taskId, batch), inArray(taskAssignees.agentPageId, staleAgentIds)))

    await tx
      .update(taskItems)
      .set({ assigneeAgentId: null })
      .where(and(inArray(taskItems.id, batch), inArray(taskItems.assigneeAgentId, staleAgentIds)))
  }
}

/**
 * Delete the workflows backing these tasks' triggers, by explicit id.
 *
 * Order is the whole point: `task_triggers.taskItemId` cascades from `task_items`, so
 * anything that removes the task (or its triggers) first leaves the workflows behind,
 * unreachable from any task and never cleaned up. `disableTaskTriggers` documents the
 * same hazard for the hard-delete paths; this variant runs inside the caller's
 * transaction so a failed move rolls the deletion back with it.
 *
 * A task-trigger workflow is created 1:1 with its trigger and never shared (the
 * (taskItemId, triggerType) unique constraint enforces it), so deleting by id cannot
 * affect another task.
 */
async function deleteTaskTriggerWorkflows(tx: Tx, taskItemIds: string[]): Promise<void> {
  for (const wfBatch of chunk(await collectTriggerWorkflowIds(tx, taskItemIds), SCRUB_CHUNK_SIZE)) {
    await tx.delete(workflows).where(inArray(workflows.id, wfBatch))
  }
}

/** The workflow ids backing these tasks' triggers. */
async function collectTriggerWorkflowIds(tx: Tx, taskItemIds: string[]): Promise<string[]> {
  const workflowIds: string[] = []
  for (const batch of chunk(taskItemIds, SCRUB_CHUNK_SIZE)) {
    const rows = await tx
      .select({ workflowId: taskTriggers.workflowId })
      .from(taskTriggers)
      .where(inArray(taskTriggers.taskItemId, batch))
    for (const row of rows) workflowIds.push(row.workflowId)
  }
  return workflowIds
}

/**
 * Bring these tasks' trigger workflows into line with the drive they now live in.
 *
 * A trigger's agent is `workflows.agentPageId`, set by the triggers route independently
 * of any task assignee, so its staleness must be resolved on its own terms. A workflow
 * whose agent stayed behind is deleted; one whose agent travelled along is still valid
 * and is instead REPOINTED at the new drive — `workflows.driveId` is stamped once at
 * creation and never rewritten, so leaving it would have the workflow execute against
 * the old drive, filtering its own context pages out by driveId and telling the agent to
 * create work back in the drive it left.
 */
async function reconcileTaskTriggerWorkflows(
  tx: Tx,
  taskItemIds: string[],
  targetDriveId: string,
  residency: DriveResidency = new Map(),
): Promise<void> {
  const byAgent = new Map<string, string[]>()
  const instructionPageByWorkflow = new Map<string, string>()
  for (const batch of chunk(taskItemIds, SCRUB_CHUNK_SIZE)) {
    const rows = await tx
      .select({
        workflowId: taskTriggers.workflowId,
        agentPageId: workflows.agentPageId,
        instructionPageId: workflows.instructionPageId,
      })
      .from(taskTriggers)
      .innerJoin(workflows, eq(workflows.id, taskTriggers.workflowId))
      .where(inArray(taskTriggers.taskItemId, batch))
    for (const row of rows) {
      // workflows.agentPageId is nullable at the column level (step-based,
      // deterministic-only workflows have no agent), but task-trigger-backed
      // workflows are created exclusively through the agent-required
      // task-trigger route and stay AI-only for the life of the trigger — a
      // null here would mean that invariant broke elsewhere, not a case this
      // reconciliation should silently mis-key under the string "null".
      if (!row.agentPageId) continue
      const list = byAgent.get(row.agentPageId) ?? []
      list.push(row.workflowId)
      byAgent.set(row.agentPageId, list)
      if (row.instructionPageId) instructionPageByWorkflow.set(row.workflowId, row.instructionPageId)
    }
  }
  if (byAgent.size === 0) return

  const staleTriggerAgents = new Set(
    await resolveAgentsOutsideDrive(tx, [...byAgent.keys()], targetDriveId, residency),
  )

  const doomed: string[] = []
  const surviving: string[] = []
  for (const [agentPageId, workflowIds] of byAgent) {
    ;(staleTriggerAgents.has(agentPageId) ? doomed : surviving).push(...workflowIds)
  }

  for (const batch of chunk(doomed, SCRUB_CHUNK_SIZE)) {
    await tx.delete(workflows).where(inArray(workflows.id, batch))
  }
  for (const batch of chunk(surviving, SCRUB_CHUNK_SIZE)) {
    await tx.update(workflows).set({ driveId: targetDriveId }).where(inArray(workflows.id, batch))
  }

  // contextPageIds need no repair: executeWorkflow re-filters them by the run's driveId,
  // so repointing above already turns a left-behind page into a dropped one.
  // instructionPageId gets no such backstop — loadInstructionPage gates only on the
  // workflow CREATOR's membership, and that creator is a source-drive user, so a runbook
  // left behind would keep being read and its content persisted into a destination-drive
  // agent page for every viewer there. Cleared when its page did not travel.
  const survivingWithInstruction = surviving.filter((id) => instructionPageByWorkflow.has(id))
  if (survivingWithInstruction.length === 0) return

  const instructionPageIds = [
    ...new Set(survivingWithInstruction.map((id) => instructionPageByWorkflow.get(id)!)),
  ]
  const strandedInstructionPages = new Set(
    await resolvePagesOutsideDrive(tx, instructionPageIds, targetDriveId, residency),
  )
  const workflowsToClear = survivingWithInstruction.filter((id) =>
    strandedInstructionPages.has(instructionPageByWorkflow.get(id)!),
  )
  for (const batch of chunk(workflowsToClear, SCRUB_CHUNK_SIZE)) {
    await tx.update(workflows).set({ instructionPageId: null }).where(inArray(workflows.id, batch))
  }
}

/** Same, addressed by page rather than task-item id (the remove branch has no id yet). */
async function deleteTaskTriggerWorkflowsForPages(tx: Tx, pageIds: string[]): Promise<void> {
  const rows = await tx
    .select({ id: taskItems.id })
    .from(taskItems)
    .where(inArray(taskItems.pageId, pageIds))
  if (rows.length === 0) return
  await deleteTaskTriggerWorkflows(tx, rows.map((row) => row.id))
}

/**
 * pageId -> "did this page end up in the target drive". Shared across one scrub so the
 * assignee agents and the trigger agents — usually the same pages — are looked up once.
 */
type DriveResidency = Map<string, boolean>

/** Memo key. Includes the drive so one memo can never answer for a different one. */
const residencyKey = (driveId: string, pageId: string) => `${driveId}:${pageId}`

/** The subset of `pageIds` that do NOT live in `driveId` — i.e. did not travel. */
async function resolvePagesOutsideDrive(
  tx: Tx,
  pageIds: string[],
  driveId: string,
  residency: DriveResidency = new Map(),
): Promise<string[]> {
  if (pageIds.length === 0) return []
  const unresolved = [...new Set(pageIds.filter((id) => !residency.has(residencyKey(driveId, id))))]
  for (const batch of chunk(unresolved, SCRUB_CHUNK_SIZE)) {
    const rows = await tx
      .select({ id: pages.id })
      .from(pages)
      .where(and(inArray(pages.id, batch), eq(pages.driveId, driveId)))
    const found = new Set(rows.map((row) => row.id))
    // Every id in the batch is recorded, including the ones the query did not return —
    // that is the `false` case, and it is what keeps the lookup below total.
    for (const id of batch) residency.set(residencyKey(driveId, id), found.has(id))
  }
  return pageIds.filter((id) => !residency.get(residencyKey(driveId, id)))
}

/** Agent pages that stayed behind. Same question, named for its caller. */
const resolveAgentsOutsideDrive = resolvePagesOutsideDrive

/**
 * Create the `task_items` row for a page under a known TASK_LIST parent.
 * Idempotent — does nothing if the row already exists. Ensures the parent's
 * `task_lists` row and default status configs exist first, and brings a
 * pre-existing row's status into the destination list's vocabulary.
 */
async function addTaskItemUnderParent(
  tx: Tx,
  params: {
    pageId: string;
    parentId: string;
    userId: string;
    /** Shared across a backfill loop: the parent is fixed, so the seed is too. */
    seedStatusCache?: Map<string, string>;
  },
): Promise<void> {
  const { pageId, parentId, userId, seedStatusCache } = params

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
    buildTaskItemInsert({
      pageId,
      userId,
      status: await resolveSeedStatus(tx, taskList.id, seedStatusCache),
    }),
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
    // Delete the trigger workflows BEFORE the row: task_triggers.taskItemId cascades
    // from task_items, so dropping the row first wipes the triggers and strands their
    // workflows rows — unreachable from any task, and never cleaned up.
    await deleteTaskTriggerWorkflowsForPages(tx, [movedPageId])
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
    // parentId is fixed for the whole loop, so its seed status is resolved once
    // rather than re-queried for every missing row on this hot read path.
    const seedStatusCache = new Map<string, string>()
    for (const pageId of missing) {
      await addTaskItemUnderParent(tx, { pageId, parentId, userId, seedStatusCache })
    }
  })
}
