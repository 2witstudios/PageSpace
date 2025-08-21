import { NextResponse } from 'next/server';
import { parse } from 'cookie';
import { decodeToken } from '@pagespace/lib/server';
import { getUserNotifications, getUnreadNotificationCount } from '@pagespace/lib';
import { loggers } from '@pagespace/lib/logger-config';

export async function GET(req: Request) {
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
    const { searchParams } = new URL(req.url);
    const limit = searchParams.get('limit') ? parseInt(searchParams.get('limit')!) : 50;
    const countOnly = searchParams.get('countOnly') === 'true';

    if (countOnly) {
      const count = await getUnreadNotificationCount(decoded.userId);
      return NextResponse.json({ count });
    }

    const notifications = await getUserNotifications(decoded.userId, limit);
    const unreadCount = await getUnreadNotificationCount(decoded.userId);

    return NextResponse.json({
      notifications,
      unreadCount,
    });
  } catch (error) {
    loggers.api.error('Error fetching notifications:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch notifications' },
      { status: 500 }
    );
  }
}