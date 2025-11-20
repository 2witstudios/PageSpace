import { NextResponse } from 'next/server';
import { getUserAccessLevel, loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: false } as const;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ pageId: string }> }
) {
  const { pageId } = await params;

  // Support both Bearer tokens (desktop) and cookies (web)
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }

  try {
    const permissions = await getUserAccessLevel(auth.userId, pageId);
    
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