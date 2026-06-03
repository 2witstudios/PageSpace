import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/permissions/permissions'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { unlinkTask, TaskRelationError } from '@/lib/tasks/task-relations';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

/**
 * DELETE /api/pages/[pageId]/tasks/links/[linkId]
 * Remove a linked-task reference from this list. Never affects the task itself.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ pageId: string; linkId: string }> }
) {
  const { pageId, linkId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const canEdit = await canUserEditPage(userId, pageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'You need edit permission to unlink tasks from this list' }, { status: 403 });
  }

  try {
    const removed = await unlinkTask({
      linkId,
      userId,
      canEdit: (p) => canUserEditPage(userId, p),
    });

    auditRequest(req, {
      eventType: 'data.delete', userId, resourceType: 'task', resourceId: removed.taskId,
      details: { action: 'unlink_task', pageId, linkId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof TaskRelationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
