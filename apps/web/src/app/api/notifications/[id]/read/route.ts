import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { markNotificationAsRead } from '@pagespace/lib';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const { id } = await context.params;

  try {
    const notification = await markNotificationAsRead(id, userId);
    
    if (!notification) {
      return NextResponse.json(
        { error: 'Notification not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(notification);
  } catch (error) {
    loggers.api.error('Error marking notification as read:', error as Error);
    return NextResponse.json(
      { error: 'Failed to mark notification as read' },
      { status: 500 }
    );
  }
}