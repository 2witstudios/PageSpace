import { db } from '@pagespace/db/db'
import { eq, ne, and, asc, desc, inArray, notInArray, isNull, isNotNull } from '@pagespace/db/operators'
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
 * How far up the page tree the status-vocabulary walk will look.
 *
 * The bound exists so a pathological chain cannot turn a lazy list init into an
 * unbounded query loop. It is NOT backed by a UI cap, whatever an earlier
 * version of this comment claimed: MAX_TASK_DEPTH caps inline EXPANSION only,
 * and opening a task's own page makes it a root list with its own add
 * affordance, so page nesting has no limit.
 *
 * Past this depth a list falls back to the built-in statuses rather than
 * failing — the same outcome as having no task-list ancestor at all. A 10-deep
 * chain of task pages is far outside anything observed, and the alternative
 * (an unbounded walk on a hot read path) is worse than the fallback.
 */
export const STATUS_INHERITANCE_MAX_DEPTH = 10

/**
 * The status vocabulary a NEW sub-list should be born with: its nearest ancestor
 * task list's, falling back to the defaults.
 *
 * Status configs are per-task-list and `task_items.status` is validated against
 * the configs of the list named in the write's URL. So on a list whose owner
 * renamed or added statuses, seeding a sub-list with DEFAULT_TASK_STATUSES puts a
 * different vocabulary one level down — and any UI that renders the root's
 * statuses on a nested row produces a slug the sub-list does not define, which
 * PATCH rejects with a 400.
 *
 * Inheriting at seed time makes the two sides identical, so nested rows can show
 * the root vocabulary and every option in the dropdown is one the server accepts.
 * Crucially it does this WITHOUT weakening validation: normalizeStatusForList and
 * the POST/PATCH slug checks keep enforcing "a task's status is always a slug its
 * own list defines" exactly as before.
 *
 * No permission check on the ancestor, deliberately, and worth saying out loud
 * because the new GET /api/pages/[pageId]/task in the same change DOES gate on
 * the parent before returning its vocabulary. The two are different questions:
 * that route hands a principal the parent's configs on request, which is a
 * disclosure; this copies them into a page the principal is already looking at,
 * the way a page inherits its drive's settings — a system-level data operation
 * with no requester to check. Gating it would mean a viewer's read seeding the
 * built-ins and permanently deciding the child's vocabulary by who happened to
 * open it first, which is the bug this whole path exists to prevent.
 *
 * Returns rows in ancestor position order, or DEFAULT_TASK_STATUSES when no
 * ancestor list has a vocabulary to inherit.
 */
export async function resolveInheritedStatusSeed(
  tx: Tx,
  forPageId: string,
): Promise<{ name: string; slug: string; color: string; group: 'todo' | 'in_progress' | 'done'; position: number }[]> {
  let cursor: string = forPageId
  for (let depth = 0; depth < STATUS_INHERITANCE_MAX_DEPTH; depth++) {
    const [row] = await tx
      .select({ parentId: pages.parentId })
      .from(pages)
      .where(eq(pages.id, cursor))
      .limit(1)
    const parentId = row?.parentId ?? null
    if (!parentId) break

    const [parentPage] = await tx
      .select({ type: pages.type })
      .from(pages)
      .where(eq(pages.id, parentId))
      .limit(1)
    // Stop at the first non-task ancestor: a task list nested under a folder
    // inherits nothing, which is correct — it is a root list, not a sub-list.
    if (parentPage?.type !== TASK_LIST_TYPE) break

    const ancestorList = await tx.query.taskLists.findFirst({
      where: eq(taskLists.pageId, parentId),
    })
    if (ancestorList) {
      const configs = await tx
        .select({
          name: taskStatusConfigs.name,
          slug: taskStatusConfigs.slug,
          color: taskStatusConfigs.color,
          group: taskStatusConfigs.group,
          position: taskStatusConfigs.position,
        })
        .from(taskStatusConfigs)
        .where(eq(taskStatusConfigs.taskListId, ancestorList.id))
        .orderBy(asc(taskStatusConfigs.position))
        // Deliberately UNBOUNDED, and the only read here that is. This copies a
        // vocabulary wholesale, and nothing caps how many statuses a list may
        // define — the statuses PUT takes any array. Truncating the copy would
        // hand the child a DIFFERENT vocabulary from the one it is supposed to
        // inherit, and if the ancestor's only done-group status fell past the
        // cut the child would have no way to complete a task at all. A bound
        // that can silently change meaning is worse here than a large read of
        // rows that are a few short strings each.
      if (configs.length > 0) return configs
    }

    cursor = parentId
  }

  return DEFAULT_TASK_STATUSES.map(s => ({ ...s }))
}

/**
 * Seed a new `task_lists` row's vocabulary, inherited from its nearest ancestor
 * task list. Conflict-tolerant for the same reason, and by the same means, as
 * seedInheritedTaskStatusConfigs.
 *
 * Conflict tolerance is `onConflictDoNothing`, not a try/catch, for two
 * reasons — one demonstrated, one structural. (Carried over from the default
 * seeder this replaced; the reasoning is about the insert, not the values.)
 *
 * Demonstrated: a real conflict IS reachable on the repair paths, where two
 * callers find the same config-less list and both seed it (the GET route's
 * migration branch, the MCP read, `read_page`). A catch has to recognise the
 * error first, and drizzle rethrows pg errors as DrizzleQueryError with the
 * SQLSTATE on `.cause` — so a message test would have rethrown and 500'd the
 * request. There is an integration test for exactly this race; removing the
 * conflict clause fails it.
 *
 * Structural: the create paths run inside `db.transaction`, where a RAISED
 * constraint violation aborts the transaction, and swallowing it would let the
 * callback return while Postgres converts the COMMIT to a ROLLBACK — handing
 * the caller a `task_lists` row that never committed. ON CONFLICT DO NOTHING
 * never raises, so it cannot become live.
 */
export async function seedInheritedTaskStatusConfigs(
  tx: Tx,
  taskListId: string,
  forPageId: string,
): Promise<void> {
  const seed = await resolveInheritedStatusSeed(tx, forPageId)
  await tx.insert(taskStatusConfigs)
    .values(seed.map(s => ({ taskListId, ...s })))
    .onConflictDoNothing()
  await conformExistingTasksToVocabulary(tx, taskListId, forPageId)
}

/**
 * The three statuses any repair or seed needs, read directly rather than out of a
 * page of the vocabulary.
 *
 * Every one of these used to come from a `findMany` capped at 200. Nothing caps how
 * many statuses a list may define — the statuses PUT accepts any array — so that
 * window could hide the answer and change it: a list whose only open status sits past
 * row 200 handed new tasks a DONE slug, and `resolveSeedCompletedAt` then stamped
 * them, so a task was born complete. A targeted read cannot be wrong that way.
 *
 * These are several small round trips where one ordered read would answer all of
 * them. That is a deliberate trade, and NOT a claim about indexes — an earlier
 * version of this comment said `(taskListId, group)` was indexed and it is not.
 * The schema has `index(taskListId)` and `unique(taskListId, slug)`, so a group
 * filter uses the former and scans the handful of rows it returns. Correctness
 * first: the single read is the thing that had a window in it.
 *
 * `open` and `done` are the two sides of the completion boundary. Never land a row
 * on the wrong side of it: one carrying a completion time stays complete, one without
 * stays actionable. (The per-group deletion guard in the statuses route means a list
 * with any configs keeps at least one of each group, so the later fallbacks are
 * defence rather than live paths.)
 *
 * One resolver, used by the seed, the per-row repair and the set-based sweep alike —
 * this rule written out three times is how the three come to disagree about which
 * side a row belongs on.
 */
async function resolveVocabularyPicks(tx: Tx, taskListId: string): Promise<{
  first: { slug: string };
  open: { slug: string };
  done: { slug: string };
} | null> {
  const byPosition = (extra?: ReturnType<typeof eq>) => ({
    where: extra
      ? and(eq(taskStatusConfigs.taskListId, taskListId), extra)
      : eq(taskStatusConfigs.taskListId, taskListId),
    orderBy: [asc(taskStatusConfigs.position)],
  })
  const first = await tx.query.taskStatusConfigs.findFirst(byPosition())
  // No vocabulary at all: nothing to conform to, and nothing to seed from.
  if (!first) return null

  const open = await tx.query.taskStatusConfigs.findFirst(
    byPosition(eq(taskStatusConfigs.group, 'todo')),
  ) ?? await tx.query.taskStatusConfigs.findFirst(
    byPosition(ne(taskStatusConfigs.group, 'done')),
  ) ?? first
  const done = await tx.query.taskStatusConfigs.findFirst(
    byPosition(eq(taskStatusConfigs.group, 'done')),
  ) ?? await tx.query.taskStatusConfigs.findFirst({
    where: eq(taskStatusConfigs.taskListId, taskListId),
    // The LAST config by position. Reading it directly is also stricter than the
    // in-memory version this replaced, which took the 200th row and called it last.
    orderBy: [desc(taskStatusConfigs.position)],
  }) ?? first

  return { first, open, done }
}

/**
 * Bring a list's EXISTING task rows into the vocabulary just seeded for it.
 *
 * Only matters on the repair path, and it is the price of inheriting there. The
 * old behaviour seeded DEFAULT_TASK_STATUSES, which always defines 'pending' —
 * the schema default for `task_items.status`, and therefore exactly what a
 * legacy row carries. Seeding the ancestor's vocabulary instead leaves those
 * rows holding a slug their own list does not define, which is the invariant
 * normalizeStatusForList exists to protect and which PATCH enforces with a 400.
 *
 * Two set-based UPDATEs rather than a read-then-loop, and that shape is
 * load-bearing rather than a micro-optimisation. This runs ONCE per list — every
 * caller reaches it only while the vocabulary is empty, so the pass that writes
 * the configs is the only pass there will ever be. A row-at-a-time repair had to
 * be bounded, and any row past the bound would have kept an undefined slug
 * permanently: PATCH 400s on it, the badge renders the raw slug, and no later
 * read would come back for it. There is no second chance to be partial with.
 *
 * Trashed pages included, deliberately. Skipping them costs nothing today and
 * hands back a broken row the moment one is restored.
 *
 * TWO THINGS A REVIEWER SHOULD WEIGH, because they are escalations rather than
 * accidents:
 *
 *  1. This runs on a VIEW-permission read. The lazy-init pattern already wrote
 *     on read — the route has always inserted a task_lists row and its configs
 *     for a viewer — but this is the first time a read rewrites task ROWS. It
 *     is not optional: the alternative is leaving rows whose slug their own
 *     list does not define, which PATCH answers 400 on and which the badge
 *     renders as a raw slug. It fires only while a vocabulary is empty, i.e.
 *     once per legacy list, and never on data created since this shipped.
 *  2. It is not audited and does not broadcast. Every deliberate status write
 *     logs and emits a task event; this one has no request and no actor to
 *     attribute, so another tab keeps showing pre-sweep statuses until it
 *     refetches. Giving the service an actor is the fix, and it is a change to
 *     the whole service's signature rather than to this function.
 *
 * A row whose slug the new vocabulary DOES define is untouched — `notInArray`
 * says so — which keeps the same promise normalizeStatusForList makes: a defined
 * slug is never rewritten, even when its group disagrees with completedAt.
 */
async function conformExistingTasksToVocabulary(
  tx: Tx,
  taskListId: string,
  listPageId: string,
): Promise<void> {
  // The vocabulary is expressed as a SUBQUERY, not a materialised slug list.
  // Nothing caps how many statuses a list may define — the statuses PUT accepts
  // any array — so reading them into memory under any limit would make every
  // slug past that window read as "not defined" and rewrite perfectly valid
  // rows. Worse, if the list's only done-group status sat past the window, a
  // completed task would be rewritten to an OPEN status. `IN (SELECT …)` has no
  // window to fall outside of.
  const vocabulary = tx
    .select({ slug: taskStatusConfigs.slug })
    .from(taskStatusConfigs)
    .where(eq(taskStatusConfigs.taskListId, taskListId))

  const picks = await resolveVocabularyPicks(tx, taskListId)
  if (!picks) return
  const { open, done } = picks

  const membersOfThisList = tx
    .select({ id: pages.id })
    .from(pages)
    .where(eq(pages.parentId, listPageId))

  for (const [replacement, completionFilter] of [
    [open, isNull(taskItems.completedAt)],
    [done, isNotNull(taskItems.completedAt)],
  ] as const) {
    await tx
      .update(taskItems)
      .set({ status: replacement.slug })
      .where(and(
        inArray(taskItems.pageId, membersOfThisList),
        notInArray(taskItems.status, vocabulary),
        completionFilter,
      ))
  }
}

/**
 * Ensure a TASK_LIST page has its `task_lists` row and default `task_status_configs`
 * seeded. Idempotent — a no-op if the `task_lists` row already exists. Callers that
 * separately look up `task_status_configs` for display (the MCP documents `read` route,
 * `page-read-tools.ts`'s `read_page`) also call `seedInheritedTaskStatusConfigs` when that
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

    await seedInheritedTaskStatusConfigs(tx, created.id, pageId)
  }

  return taskList
}


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

  // Never land on the wrong side of the done boundary. Read directly rather than out
  // of a page of the vocabulary — see resolveVocabularyPicks for what a window can do
  // to this choice.
  const picks = await resolveVocabularyPicks(tx, taskListId)
  // A list with no configs at all has no vocabulary to conform to.
  if (!picks) return
  const replacement = item.completedAt !== null ? picks.done : picks.open

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
export async function resolveSeedStatus(
  tx: Tx,
  taskListId: string,
  cache?: SeedCache,
): Promise<string> {
  const cached = cache?.get(taskListId)
  if (cached !== undefined) return cached.slug
  const slug = await resolveSeedStatusUncached(tx, taskListId)
  cache?.set(taskListId, { slug })
  return slug
}

/**
 * The seed a whole backfill loop shares.
 *
 * The loop's parent — and therefore its list, its vocabulary and the seed
 * derived from them — is fixed, so both queries behind a seed are worth
 * resolving once for the run rather than per missing row on a read path. The
 * `completedAt` field is absent until something asks for it, so a caller that
 * only needs the slug never pays for the second lookup.
 */
export type SeedCache = Map<string, { slug: string; completedAt?: Date | null }>

/**
 * Should a task seeded with this status be stamped complete?
 *
 * `resolveSeedStatus` falls back to the list's first config by position, and a
 * vocabulary whose statuses were all regrouped to `done` (permitted — the
 * statuses PUT validates each group but never requires one per group) makes
 * that a done slug. A row carrying a done status with a null `completedAt`
 * reads as complete to `isCompletedStatus` while every counter that asks the
 * database — `subTaskCompletedCount`, the header's own guard — counts
 * `completedAt IS NOT NULL` and does not see it. The row then looks finished
 * and blocks its parent at the same time.
 *
 * Every path that seeds a task goes through here, not just POST: the self-heal
 * backfill on an ordinary read, page creation, and re-parenting all create rows
 * the same way, and a rule applied to one of them is a divergence rather than a
 * fix.
 */
export async function resolveSeedCompletedAt(
  tx: Tx,
  taskListId: string,
  seedStatus: string,
  cache?: SeedCache,
): Promise<Date | null> {
  const cached = cache?.get(taskListId)
  // Only reusable when it is the SAME status: the cache is keyed by list, and a
  // caller passing an explicit status can hand us a different one.
  if (cached?.slug === seedStatus && cached.completedAt !== undefined) return cached.completedAt
  const resolved = await resolveSeedCompletedAtUncached(tx, taskListId, seedStatus)
  if (cached?.slug === seedStatus) cache?.set(taskListId, { ...cached, completedAt: resolved })
  return resolved
}

async function resolveSeedCompletedAtUncached(
  tx: Tx,
  taskListId: string,
  seedStatus: string,
): Promise<Date | null> {
  const config = await tx.query.taskStatusConfigs.findFirst({
    where: and(
      eq(taskStatusConfigs.taskListId, taskListId),
      eq(taskStatusConfigs.slug, seedStatus),
    ),
    columns: { group: true },
  })
  // No config for the slug means the list has no custom vocabulary, where the
  // built-in rule is that only 'completed' is done.
  if (!config) return seedStatus === 'completed' ? new Date() : null
  return config.group === 'done' ? new Date() : null
}

async function resolveSeedStatusUncached(tx: Tx, taskListId: string): Promise<string> {
  const defaultSlug = DEFAULT_TASK_STATUSES[0].slug
  const hasDefault = await tx.query.taskStatusConfigs.findFirst({
    where: and(
      eq(taskStatusConfigs.taskListId, taskListId),
      eq(taskStatusConfigs.slug, defaultSlug),
    ),
    columns: { group: true },
  })
  // Defined is not enough — it has to still MEAN "not started". The statuses PUT
  // lets a list regroup 'pending' into the done group and validates only that the
  // group is one of the three literals, so a list can define 'pending' as a DONE
  // status. Seeding it there hands the new task a done slug, and
  // resolveSeedCompletedAt then stamps it: the task is created already finished,
  // counted in its parent's completed total, satisfying the completion guard, and
  // with its due-date trigger permanently disabled. The list usually has a
  // perfectly good open status; fall through and find it.
  if (hasDefault && hasDefault.group !== 'done') return defaultSlug

  // The open side of the vocabulary, read directly. Through a 200-row window this
  // could miss a list's only open status and hand back a DONE slug instead — and
  // resolveSeedCompletedAt would then stamp the new task complete on creation.
  const picks = await resolveVocabularyPicks(tx, taskListId)
  return picks?.open.slug ?? defaultSlug
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
    seedStatusCache?: SeedCache;
    /**
     * The parent's already-resolved list. Same reasoning as seedStatusCache: the
     * parent does not vary across a backfill loop, so re-deriving its list per
     * missing row is a query — and a possible seeding write — repeated for
     * nothing, inside a transaction the read is holding open.
     */
    taskList?: typeof taskLists.$inferSelect;
  },
): Promise<void> {
  const { pageId, parentId, userId, seedStatusCache } = params

  const taskList = params.taskList
    ?? await ensureTaskListForPage(tx, { pageId: parentId, title: 'Task List', userId })

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
  const seedStatus = await resolveSeedStatus(tx, taskList.id, seedStatusCache)
  await tx.insert(taskItems).values(
    buildTaskItemInsert({
      pageId,
      userId,
      status: seedStatus,
      // Same rule POST applies. Without it the self-heal backfill — which runs
      // on every list read — and page creation write a done-group status with a
      // null completedAt, which no counter can see.
      completedAt: await resolveSeedCompletedAt(tx, taskList.id, seedStatus, seedStatusCache),
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
    // parentId is fixed for the whole loop, so everything derived from it — the
    // list itself and the seed resolved from its vocabulary — is resolved once
    // rather than per missing row. This runs on an ordinary list read, inside a
    // write transaction, so a hundred missing rows meant a few hundred round
    // trips holding it open.
    const taskList = await ensureTaskListForPage(tx, {
      pageId: parentId, title: 'Task List', userId,
    })
    const seedStatusCache: SeedCache = new Map()
    for (const pageId of missing) {
      await addTaskItemUnderParent(tx, { pageId, parentId, userId, seedStatusCache, taskList })
    }
  })
}
