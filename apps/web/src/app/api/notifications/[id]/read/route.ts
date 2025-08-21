import { NextResponse } from 'next/server';
import { parse } from 'cookie';
import { decodeToken } from '@pagespace/lib/server';
import { markNotificationAsRead } from '@pagespace/lib';
import { loggers } from '@pagespace/lib/logger-config';

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  const cookieHeader = req.headers.get('cookie');
  const cookies = parse(cookieHeader || '');
  const accessToken = cookies.accessToken;

  if (!accessToken) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const decoded = await decodeToken(accessToken);
  if (!decoded || !decoded.userId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const notification = await markNotificationAsRead(id, decoded.userId);
    
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