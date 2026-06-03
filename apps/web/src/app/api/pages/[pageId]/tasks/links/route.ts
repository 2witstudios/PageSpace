import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { canUserEditPage } from '@pagespace/lib/permissions/permissions'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { linkTask, TaskRelationError } from '@/lib/tasks/task-relations';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const, requireCSRF: true };

/**
 * POST /api/pages/[pageId]/tasks/links
 * Link an existing task into this TASK_LIST page ([pageId]) without moving it.
 * Body: { taskId }.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ pageId: string }> }
) {
  const { pageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  const canEdit = await canUserEditPage(userId, pageId);
  if (!canEdit) {
    return NextResponse.json({ error: 'You need edit permission to link tasks into this list' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const taskId = typeof body?.taskId === 'string' ? body.taskId : '';
  if (!taskId) {
    return NextResponse.json({ error: 'taskId is required' }, { status: 400 });
  }

  try {
    const { link } = await linkTask({
      taskId,
      destTaskListPageId: pageId,
      userId,
      canEdit: (p) => canUserEditPage(userId, p),
    });

    auditRequest(req, {
      eventType: 'data.write', userId, resourceType: 'task', resourceId: taskId,
      details: { action: 'link_task', pageId, linkId: link.id },
    });

    return NextResponse.json({ link }, { status: 201 });
  } catch (error) {
    if (error instanceof TaskRelationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
