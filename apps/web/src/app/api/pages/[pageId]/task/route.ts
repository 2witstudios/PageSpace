import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq, and, asc, count, isNotNull } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { taskLists, taskItems, taskStatusConfigs } from '@pagespace/db/schema/tasks';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { canPrincipalViewPage } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };

/**
 * GET /api/pages/[pageId]/task
 *
 * The page's OWN task row — "is this page itself a task, and if so what is its
 * state" — as opposed to `/tasks`, which returns the page's children.
 *
 * This exists because opening a task shows a task list scoped to its children:
 * the task becomes the container, and a container renders no row for itself. So
 * the view had no way to complete, or even display the status of, the very task
 * you were looking at.
 *
 * Three things make it a separate route rather than a read of the parent's
 * `/tasks`:
 *
 *  - `/tasks` on the parent fetches up to 100 sibling rows to find one.
 *  - It runs `getOrCreateTaskListForPage`, which lazily WRITES a task_lists row
 *    plus status configs. Mounting a header must not do that to the parent.
 *  - Writes to this task are addressed to the PARENT's page, and the status
 *    vocabulary that validates them is the parent list's — both of which this
 *    route returns explicitly rather than leaving the client to infer.
 *
 * Returns `{ task: null }` for a page that is not a task (a top-level list, or
 * any non-task page), which the header renders as nothing.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ pageId: string }> },
) {
  const { pageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const canView = await canPrincipalViewPage(auth, pageId);
  if (!canView) {
    return NextResponse.json({
      error: 'You need view permission to access this page',
    }, { status: 403 });
  }

  const [page] = await db
    .select({ parentId: pages.parentId })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);

  if (!page?.parentId) {
    return NextResponse.json({ task: null, listPageId: null, statusConfigs: [] });
  }

  // Columns only, no relations: the header renders a checkbox and a status
  // dropdown, so joining assignees (and through them users) would cost a
  // three-table join on every task screen for data nothing displays — and
  // returning those user rows would mean shipping field-encrypted columns this
  // route has no reason to decrypt.
  const taskItem = await db.query.taskItems.findFirst({
    where: eq(taskItems.pageId, pageId),
    columns: {
      id: true, status: true, priority: true,
      completedAt: true, dueDate: true, updatedAt: true,
    },
  });

  if (!taskItem) {
    return NextResponse.json({ task: null, listPageId: null, statusConfigs: [] });
  }

  // The vocabulary the PATCH that this header issues will be validated against
  // is the parent list's, not this page's own.
  const parentList = await db.query.taskLists.findFirst({
    where: eq(taskLists.pageId, page.parentId),
  });

  // Deliberately a read: no getOrCreateTaskListForPage. A parent with no
  // task_lists row yet yields an empty vocabulary, and the header falls back to
  // a plain complete/reopen toggle rather than lazily writing rows.
  const statusConfigs = parentList
    ? await db
      .select()
      .from(taskStatusConfigs)
      .where(eq(taskStatusConfigs.taskListId, parentList.id))
      .orderBy(asc(taskStatusConfigs.position))
      .limit(200)
    : [];

  // This page's own children, so the header honours the same sub-task
  // completion guard the rows do instead of discovering it via a 422.
  const [totals] = await db
    .select({ total: count() })
    .from(taskItems)
    .innerJoin(pages, eq(pages.id, taskItems.pageId))
    .where(and(eq(pages.parentId, pageId), eq(pages.isTrashed, false)));
  const [completed] = await db
    .select({ total: count() })
    .from(taskItems)
    .innerJoin(pages, eq(pages.id, taskItems.pageId))
    .where(and(
      eq(pages.parentId, pageId),
      eq(pages.isTrashed, false),
      isNotNull(taskItems.completedAt),
    ));

  auditRequest(req, {
    eventType: 'data.read',
    userId: auth.userId,
    resourceType: 'task',
    resourceId: taskItem.id,
    details: { pageId },
  });

  return NextResponse.json({
    listPageId: page.parentId,
    statusConfigs,
    task: {
      id: taskItem.id,
      status: taskItem.status,
      priority: taskItem.priority,
      completedAt: taskItem.completedAt,
      dueDate: taskItem.dueDate,
      updatedAt: taskItem.updatedAt,
      subTaskCount: Number(totals?.total ?? 0),
      subTaskCompletedCount: Number(completed?.total ?? 0),
    },
  });
}
