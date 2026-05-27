import { db } from '@pagespace/db/db'
import { eq, and, desc } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { taskLists, taskItems, taskStatusConfigs, DEFAULT_TASK_STATUSES } from '@pagespace/db/schema/tasks'

type Tx = typeof db

/**
 * Sync task_items membership when a page is moved.
 *
 * Invariant: every TASK_LIST page whose pages.parentId points to another TASK_LIST page
 * must have exactly one task_items row with pageId = that page's id.
 *
 * - Moving INTO a TASK_LIST parent → create the task_items row (idempotent)
 * - Moving OUT OF a TASK_LIST parent → delete the task_items row
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

  if (movedPageType !== 'TASK_LIST') return

  // Remove from old parent if it was a TASK_LIST
  if (oldParentId) {
    const [oldParent] = await tx
      .select({ type: pages.type })
      .from(pages)
      .where(eq(pages.id, oldParentId))
      .limit(1)

    if (oldParent?.type === 'TASK_LIST') {
      await tx.delete(taskItems).where(eq(taskItems.pageId, movedPageId))
    }
  }

  // Add to new parent if it's a TASK_LIST
  if (newParentId) {
    const [newParent] = await tx
      .select({ type: pages.type })
      .from(pages)
      .where(eq(pages.id, newParentId))
      .limit(1)

    if (newParent?.type !== 'TASK_LIST') return

    // Get or create task_lists row for the new parent page
    let taskList = await tx.query.taskLists.findFirst({
      where: eq(taskLists.pageId, newParentId),
    })

    if (!taskList) {
      const [created] = await tx.insert(taskLists).values({
        userId,
        pageId: newParentId,
        title: 'Task List',
        status: 'pending',
      }).returning()
      taskList = created

      await tx.insert(taskStatusConfigs).values(
        DEFAULT_TASK_STATUSES.map(s => ({ taskListId: created.id, ...s }))
      )
    }

    // Idempotent: skip if task_items row already exists
    const existing = await tx.query.taskItems.findFirst({
      where: eq(taskItems.pageId, movedPageId),
    })
    if (existing) return

    // Position after the last task in the new parent
    const lastChild = await tx.query.pages.findFirst({
      where: and(eq(pages.parentId, newParentId), eq(pages.isTrashed, false)),
      orderBy: [desc(pages.position)],
    })
    const position = (lastChild?.position ?? 0) + 1

    await tx.insert(taskItems).values({
      userId,
      pageId: movedPageId,
      status: 'pending',
      priority: 'medium',
      position,
    })
  }
}
