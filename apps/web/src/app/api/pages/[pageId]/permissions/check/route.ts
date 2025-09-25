import { NextResponse } from 'next/server';
import { getUserAccessLevel } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { decodeToken } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ pageId: string }> }
) {
  const { pageId } = await params;
  
  // Get user ID from cookie
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
    const permissions = await getUserAccessLevel(decoded.userId, pageId);
    
    if (!permissions) {
      return NextResponse.json({
        canView: false,
        canEdit: false,
        canShare: false,
        canDelete: false
      });
    }

    return NextResponse.json(permissions);
  } catch (error) {
    loggers.api.error('Error checking permissions:', error as Error);
    return NextResponse.json(
      { error: 'Failed to check permissions' },
      { status: 500 }
    );
  }
}