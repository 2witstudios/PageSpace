import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/permissions/permissions'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { removeDependency, TaskRelationError } from '@/lib/tasks/task-relations';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

/**
 * DELETE /api/pages/[pageId]/tasks/[taskId]/dependencies/[depId]
 * Remove a blocker edge from this task.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ pageId: string; taskId: string; depId: string }> }
) {
  const { pageId, depId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const canEdit = await canUserEditPage(userId, pageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'You need edit permission to remove dependencies' }, { status: 403 });
  }

  try {
    const removed = await removeDependency({
      dependencyId: depId,
      userId,
      canEdit: (p) => canUserEditPage(userId, p),
    });

    auditRequest(req, {
      eventType: 'data.delete', userId, resourceType: 'task', resourceId: removed.blockedTaskId,
      details: { action: 'remove_task_dependency', pageId, dependencyId: depId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof TaskRelationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
