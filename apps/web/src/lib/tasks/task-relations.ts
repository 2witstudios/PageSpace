import { db } from '@pagespace/db/db'
import { eq, and, asc, desc, inArray } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { taskItems, taskLinks, taskDependencies } from '@pagespace/db/schema/tasks'
import { broadcastTaskEvent } from '@/lib/websocket'

/**
 * Cross-list task relations: linked tasks (a task surfaced in another list
 * without moving it) and directed blocker dependencies (a "blocked by" edge).
 *
 * Mutations here are transport-agnostic: callers (REST routes, MCP tools) inject
 * an `EditCheck` so the same logic runs under both `canUserEditPage` (session)
 * and `canActorEditPage` (AI tool) permission models. Data-integrity invariants
 * — same drive, no self-link, no cycle, unique pair — live here so neither
 * transport can bypass them.
 */

/** A failure that carries the HTTP status routes should return / tools surface. */
export class TaskRelationError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'TaskRelationError';
  }
}

/** Resolves whether the actor may edit the given TASK_LIST page. */
export type EditCheck = (pageId: string) => Promise<boolean>;

interface TaskContext {
  id: string;
  pageId: string;
  /** The TASK_LIST page that is this task's home list (pages.parentId). */
  homeListPageId: string | null;
  driveId: string;
  title: string;
  isTrashed: boolean;
}

async function fetchTaskContext(taskId: string): Promise<TaskContext | null> {
  const task = await db.query.taskItems.findFirst({
    where: eq(taskItems.id, taskId),
    with: {
      page: { columns: { id: true, parentId: true, driveId: true, isTrashed: true, title: true } },
    },
  });
  if (!task || !task.page) return null;
  return {
    id: task.id,
    pageId: task.pageId,
    homeListPageId: task.page.parentId,
    driveId: task.page.driveId,
    title: task.page.title,
    isTrashed: task.page.isTrashed,
  };
}

// ---------------------------------------------------------------------------
// Linked tasks
// ---------------------------------------------------------------------------

/**
 * Surface an existing task inside another TASK_LIST page without moving it.
 * Rejects linking into the task's own home list, cross-drive links, and
 * duplicates. Requires edit permission on the destination list.
 */
export async function linkTask(params: {
  taskId: string;
  destTaskListPageId: string;
  userId: string;
  canEdit: EditCheck;
}): Promise<{ link: typeof taskLinks.$inferSelect; driveId: string; taskTitle: string }> {
  const { taskId, destTaskListPageId, userId, canEdit } = params;

  const taskCtx = await fetchTaskContext(taskId);
  if (!taskCtx || taskCtx.isTrashed) throw new TaskRelationError('Task not found', 404);

  const destPage = await db.query.pages.findFirst({
    where: eq(pages.id, destTaskListPageId),
    columns: { id: true, type: true, driveId: true, isTrashed: true },
  });
  if (!destPage || destPage.isTrashed) throw new TaskRelationError('Destination list not found', 404);
  if (destPage.type !== 'TASK_LIST') throw new TaskRelationError('Destination page must be a TASK_LIST', 400);
  if (taskCtx.homeListPageId === destTaskListPageId) throw new TaskRelationError('Task already lives in this list', 400);
  if (taskCtx.driveId !== destPage.driveId) throw new TaskRelationError('Tasks can only be linked within the same drive', 400);

  if (!(await canEdit(destTaskListPageId))) {
    throw new TaskRelationError('You need edit permission on the destination list', 403);
  }

  const existing = await db.query.taskLinks.findFirst({
    where: and(eq(taskLinks.taskId, taskId), eq(taskLinks.taskListPageId, destTaskListPageId)),
  });
  if (existing) throw new TaskRelationError('Task is already linked into this list', 409);

  const [last] = await db
    .select({ position: taskLinks.position })
    .from(taskLinks)
    .where(eq(taskLinks.taskListPageId, destTaskListPageId))
    .orderBy(desc(taskLinks.position))
    .limit(1);
  const position = last ? last.position + 1 : 0;

  const [link] = await db
    .insert(taskLinks)
    .values({ taskId, taskListPageId: destTaskListPageId, position, createdById: userId })
    .returning();

  await broadcastTaskEvent({
    type: 'task_linked',
    taskId,
    userId,
    pageId: destTaskListPageId,
    data: { taskId, linkId: link.id, title: taskCtx.title },
  });

  return { link, driveId: destPage.driveId, taskTitle: taskCtx.title };
}

/**
 * Remove a linked-task reference. Resolves the link by id, or by the
 * (taskId, destTaskListPageId) pair. Never affects the underlying task.
 */
export async function unlinkTask(params: {
  linkId?: string;
  taskId?: string;
  destTaskListPageId?: string;
  userId: string;
  canEdit: EditCheck;
}): Promise<{ linkId: string; destTaskListPageId: string; taskId: string }> {
  const { linkId, taskId, destTaskListPageId, userId, canEdit } = params;

  const link = linkId
    ? await db.query.taskLinks.findFirst({ where: eq(taskLinks.id, linkId) })
    : taskId && destTaskListPageId
      ? await db.query.taskLinks.findFirst({
          where: and(eq(taskLinks.taskId, taskId), eq(taskLinks.taskListPageId, destTaskListPageId)),
        })
      : null;

  if (!link) throw new TaskRelationError('Link not found', 404);
  if (!(await canEdit(link.taskListPageId))) {
    throw new TaskRelationError('You need edit permission on this list', 403);
  }

  await db.delete(taskLinks).where(eq(taskLinks.id, link.id));

  await broadcastTaskEvent({
    type: 'task_unlinked',
    taskId: link.taskId,
    userId,
    pageId: link.taskListPageId,
    data: { taskId: link.taskId, linkId: link.id },
  });

  return { linkId: link.id, destTaskListPageId: link.taskListPageId, taskId: link.taskId };
}

// ---------------------------------------------------------------------------
// Dependencies (blocker edges)
// ---------------------------------------------------------------------------

/**
 * Following existing (blocker -> blocked) edges, can we already reach
 * `targetTaskId` starting from `fromTaskId`? Used to reject a new edge that
 * would close a cycle. BFS over task_dependencies; all edges are within one
 * drive so the traversal never leaves it.
 */
async function isReachable(fromTaskId: string, targetTaskId: string): Promise<boolean> {
  const visited = new Set<string>([fromTaskId]);
  let frontier = [fromTaskId];
  while (frontier.length > 0) {
    const rows = await db
      .select({ next: taskDependencies.blockedTaskId })
      .from(taskDependencies)
      .where(inArray(taskDependencies.blockerTaskId, frontier));
    const next: string[] = [];
    for (const r of rows) {
      if (r.next === targetTaskId) return true;
      if (!visited.has(r.next)) {
        visited.add(r.next);
        next.push(r.next);
      }
    }
    frontier = next;
  }
  return false;
}

/**
 * Add a "blockedTask is blocked by blockerTask" edge. The blocker must reach a
 * done status before the blocked task can complete (see completion-guard).
 * Rejects self-edges, cross-drive edges, duplicates, and cycles. Requires edit
 * permission on the blocked task's list.
 */
export async function addDependency(params: {
  blockedTaskId: string;
  blockerTaskId: string;
  userId: string;
  canEdit: EditCheck;
}): Promise<{ dependency: typeof taskDependencies.$inferSelect }> {
  const { blockedTaskId, blockerTaskId, userId, canEdit } = params;

  if (blockedTaskId === blockerTaskId) throw new TaskRelationError('A task cannot block itself', 400);

  const blocked = await fetchTaskContext(blockedTaskId);
  const blocker = await fetchTaskContext(blockerTaskId);
  if (!blocked || blocked.isTrashed) throw new TaskRelationError('Blocked task not found', 404);
  if (!blocker || blocker.isTrashed) throw new TaskRelationError('Blocker task not found', 404);
  if (blocked.driveId !== blocker.driveId) {
    throw new TaskRelationError('Tasks can only depend on tasks in the same drive', 400);
  }
  if (!blocked.homeListPageId) throw new TaskRelationError('Blocked task has no task list', 400);

  if (!(await canEdit(blocked.homeListPageId))) {
    throw new TaskRelationError("You need edit permission on the blocked task's list", 403);
  }

  const existing = await db.query.taskDependencies.findFirst({
    where: and(
      eq(taskDependencies.blockerTaskId, blockerTaskId),
      eq(taskDependencies.blockedTaskId, blockedTaskId),
    ),
  });
  if (existing) throw new TaskRelationError('This dependency already exists', 409);

  // Adding blocker -> blocked creates a cycle iff blocked can already reach blocker.
  if (await isReachable(blockedTaskId, blockerTaskId)) {
    throw new TaskRelationError('This dependency would create a cycle', 409);
  }

  const [dependency] = await db
    .insert(taskDependencies)
    .values({ blockerTaskId, blockedTaskId, createdById: userId })
    .returning();

  const payload = { blockedTaskId, blockerTaskId, dependencyId: dependency.id };
  await broadcastTaskEvent({
    type: 'dependency_added',
    taskId: blockedTaskId,
    userId,
    pageId: blocked.homeListPageId,
    data: payload,
  });
  if (blocker.homeListPageId && blocker.homeListPageId !== blocked.homeListPageId) {
    await broadcastTaskEvent({
      type: 'dependency_added',
      taskId: blockerTaskId,
      userId,
      pageId: blocker.homeListPageId,
      data: payload,
    });
  }

  return { dependency };
}

/** Remove a blocker edge by id. Requires edit permission on the blocked task's list. */
export async function removeDependency(params: {
  dependencyId: string;
  userId: string;
  canEdit: EditCheck;
}): Promise<{ dependencyId: string; blockedTaskId: string; blockerTaskId: string }> {
  const { dependencyId, userId, canEdit } = params;

  const dep = await db.query.taskDependencies.findFirst({ where: eq(taskDependencies.id, dependencyId) });
  if (!dep) throw new TaskRelationError('Dependency not found', 404);

  const blocked = await fetchTaskContext(dep.blockedTaskId);
  if (blocked?.homeListPageId && !(await canEdit(blocked.homeListPageId))) {
    throw new TaskRelationError("You need edit permission on the blocked task's list", 403);
  }

  await db.delete(taskDependencies).where(eq(taskDependencies.id, dependencyId));

  const payload = { dependencyId, blockedTaskId: dep.blockedTaskId, blockerTaskId: dep.blockerTaskId };
  await broadcastTaskEvent({
    type: 'dependency_removed',
    taskId: dep.blockedTaskId,
    userId,
    pageId: blocked?.homeListPageId ?? undefined,
    data: payload,
  });

  return payload;
}

// ---------------------------------------------------------------------------
// Read-side enrichment
// ---------------------------------------------------------------------------

/** A task referenced by a dependency edge, shaped for chips/graph rendering. */
export interface RelatedTaskRef {
  dependencyId: string;
  taskId: string;
  title: string;
  status: string;
  completedAt: Date | null;
  pageId: string;
  homeListPageId: string | null;
}

export interface TaskRelations {
  blockedBy: RelatedTaskRef[];
  blocks: RelatedTaskRef[];
  /** True when at least one non-trashed blocker is not yet complete. */
  isBlocked: boolean;
}

function emptyRelations(): TaskRelations {
  return { blockedBy: [], blocks: [], isBlocked: false };
}

/**
 * Batch-load blocker/blocked edges for a set of tasks. Returns a Map keyed by
 * task id with `blockedBy`, `blocks`, and a computed `isBlocked`. Edges whose
 * related task's page is trashed are filtered out.
 */
export async function getTaskRelations(taskIds: string[]): Promise<Map<string, TaskRelations>> {
  const result = new Map<string, TaskRelations>();
  for (const id of taskIds) result.set(id, emptyRelations());
  if (taskIds.length === 0) return result;

  // blockedBy: edges where one of our tasks is the blocked side; related = blocker.
  const blockedByRows = await db
    .select({
      ownerTaskId: taskDependencies.blockedTaskId,
      dependencyId: taskDependencies.id,
      taskId: taskDependencies.blockerTaskId,
      status: taskItems.status,
      completedAt: taskItems.completedAt,
      pageId: taskItems.pageId,
      title: pages.title,
      homeListPageId: pages.parentId,
      isTrashed: pages.isTrashed,
    })
    .from(taskDependencies)
    .innerJoin(taskItems, eq(taskItems.id, taskDependencies.blockerTaskId))
    .innerJoin(pages, eq(pages.id, taskItems.pageId))
    .where(inArray(taskDependencies.blockedTaskId, taskIds));

  for (const r of blockedByRows) {
    if (r.isTrashed) continue;
    const entry = result.get(r.ownerTaskId);
    if (!entry) continue;
    entry.blockedBy.push({
      dependencyId: r.dependencyId,
      taskId: r.taskId,
      title: r.title,
      status: r.status,
      completedAt: r.completedAt,
      pageId: r.pageId,
      homeListPageId: r.homeListPageId,
    });
    if (r.completedAt === null) entry.isBlocked = true;
  }

  // blocks: edges where one of our tasks is the blocker side; related = blocked.
  const blocksRows = await db
    .select({
      ownerTaskId: taskDependencies.blockerTaskId,
      dependencyId: taskDependencies.id,
      taskId: taskDependencies.blockedTaskId,
      status: taskItems.status,
      completedAt: taskItems.completedAt,
      pageId: taskItems.pageId,
      title: pages.title,
      homeListPageId: pages.parentId,
      isTrashed: pages.isTrashed,
    })
    .from(taskDependencies)
    .innerJoin(taskItems, eq(taskItems.id, taskDependencies.blockedTaskId))
    .innerJoin(pages, eq(pages.id, taskItems.pageId))
    .where(inArray(taskDependencies.blockerTaskId, taskIds));

  for (const r of blocksRows) {
    if (r.isTrashed) continue;
    const entry = result.get(r.ownerTaskId);
    if (!entry) continue;
    entry.blocks.push({
      dependencyId: r.dependencyId,
      taskId: r.taskId,
      title: r.title,
      status: r.status,
      completedAt: r.completedAt,
      pageId: r.pageId,
      homeListPageId: r.homeListPageId,
    });
  }

  return result;
}

/** A task linked into a list, enriched for rendering in the "Linked" group. */
export interface LinkedTask {
  linkId: string;
  linkPosition: number;
  id: string;
  pageId: string;
  title: string;
  status: string;
  priority: string;
  completedAt: Date | null;
  dueDate: Date | null;
  assigneeId: string | null;
  assigneeAgentId: string | null;
  assignees: {
    userId: string | null;
    agentPageId: string | null;
    user: { id: string; name: string | null } | null;
    agentPage: { id: string; title: string } | null;
  }[];
  homeTaskListPageId: string | null;
  homeTaskListPageTitle: string | null;
}

/**
 * Load the tasks linked into a TASK_LIST page (ordered by link position),
 * skipping links whose underlying task page is trashed. The home-list title is
 * resolved so the UI can show a "from <list>" source chip.
 */
export async function getLinkedTasksForList(taskListPageId: string): Promise<LinkedTask[]> {
  const links = await db.query.taskLinks.findMany({
    where: eq(taskLinks.taskListPageId, taskListPageId),
    orderBy: [asc(taskLinks.position)],
    with: {
      task: {
        with: {
          page: { columns: { id: true, title: true, parentId: true, isTrashed: true } },
          assignees: {
            with: {
              user: { columns: { id: true, name: true } },
              agentPage: { columns: { id: true, title: true } },
            },
          },
        },
      },
    },
  });

  const live = links.filter(l => l.task?.page && !l.task.page.isTrashed);

  // Resolve home-list titles in one batch.
  const homeListIds = Array.from(
    new Set(live.map(l => l.task!.page!.parentId).filter((id): id is string => Boolean(id))),
  );
  const homeListTitles = new Map<string, string>();
  if (homeListIds.length > 0) {
    const homeListPages = await db
      .select({ id: pages.id, title: pages.title })
      .from(pages)
      .where(inArray(pages.id, homeListIds));
    for (const p of homeListPages) homeListTitles.set(p.id, p.title);
  }

  return live.map((l) => {
    const task = l.task!;
    const homeListPageId = task.page!.parentId;
    return {
      linkId: l.id,
      linkPosition: l.position,
      id: task.id,
      pageId: task.pageId,
      title: task.page!.title,
      status: task.status,
      priority: task.priority,
      completedAt: task.completedAt,
      dueDate: task.dueDate,
      assigneeId: task.assigneeId,
      assigneeAgentId: task.assigneeAgentId,
      assignees: (task.assignees ?? []).map(a => ({
        userId: a.userId,
        agentPageId: a.agentPageId,
        user: a.user ? { id: a.user.id, name: a.user.name } : null,
        agentPage: a.agentPage ? { id: a.agentPage.id, title: a.agentPage.title } : null,
      })),
      homeTaskListPageId: homeListPageId,
      homeTaskListPageTitle: homeListPageId ? homeListTitles.get(homeListPageId) ?? null : null,
    };
  });
}
