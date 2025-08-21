import { NextResponse } from 'next/server';
import { parse } from 'cookie';
import { decodeToken } from '@pagespace/lib/server';
import { deleteNotification } from '@pagespace/lib';
import { loggers } from '@pagespace/lib/logger-config';

export async function DELETE(
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
    await deleteNotification(id, decoded.userId);
    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error deleting notification:', error as Error);
    return NextResponse.json(
      { error: 'Failed to delete notification' },
      { status: 500 }
    );
  }
}