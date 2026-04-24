import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { deleteNotification } from '@pagespace/lib/notifications/notifications';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const { id } = await context.params;

  try {
    await deleteNotification(id, userId);

    auditRequest(req, { eventType: 'data.delete', userId, resourceType: 'notification', resourceId: id });

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error deleting notification:', error as Error);
    return NextResponse.json(
      { error: 'Failed to delete notification' },
      { status: 500 }
    );
  }
}