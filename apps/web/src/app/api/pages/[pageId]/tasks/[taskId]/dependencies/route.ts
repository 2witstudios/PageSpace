import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq } from '@pagespace/db/operators'
import { taskItems } from '@pagespace/db/schema/tasks';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/permissions/permissions'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { addDependency, TaskRelationError } from '@/lib/tasks/task-relations';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

/**
 * POST /api/pages/[pageId]/tasks/[taskId]/dependencies
 * Add a blocker: this task ([taskId], whose home list is [pageId]) becomes
 * blocked by `blockerTaskId`. Body: { blockerTaskId }.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ pageId: string; taskId: string }> }
) {
  const { pageId, taskId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const canEdit = await canUserEditPage(userId, pageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'You need edit permission to add dependencies' }, { status: 403 });
  }

  // Verify the blocked task is a direct child of this task list page.
  const blockedTask = await db.query.taskItems.findFirst({
    where: eq(taskItems.id, taskId),
    with: { page: { columns: { parentId: true } } },
  });
  if (!blockedTask || blockedTask.page?.parentId !== pageId) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  const body = await req.json().catch(() => ({}));
  const blockerTaskId = typeof body?.blockerTaskId === 'string' ? body.blockerTaskId : '';
  if (!blockerTaskId) {
    return NextResponse.json({ error: 'blockerTaskId is required' }, { status: 400 });
  }

  try {
    const { dependency } = await addDependency({
      blockedTaskId: taskId,
      blockerTaskId,
      userId,
      canEdit: (p) => canUserEditPage(userId, p),
    });

    auditRequest(req, {
      eventType: 'data.write', userId, resourceType: 'task', resourceId: taskId,
      details: { action: 'add_task_dependency', pageId, blockerTaskId, dependencyId: dependency.id },
    });

    return NextResponse.json({ dependency }, { status: 201 });
  } catch (error) {
    if (error instanceof TaskRelationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
