import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  checkDriveAccessForRoles,
  reorderDriveRoles,
} from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

// PATCH /api/drives/[driveId]/roles/reorder - Reorder roles
export async function PATCH(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId } = await context.params;

    // Check if user is owner or admin
    const access = await checkDriveAccessForRoles(driveId, userId);

    if (!access.drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    if (!access.isOwner && !access.isAdmin) {
      return NextResponse.json({ error: 'Only owners and admins can reorder roles' }, { status: 403 });
    }

    const body = await request.json();
    const { roleIds } = body;

    if (!Array.isArray(roleIds)) {
      return NextResponse.json({ error: 'roleIds must be an array' }, { status: 400 });
    }

    await reorderDriveRoles(driveId, roleIds);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error reordering roles:', error);
    if (error instanceof Error && error.message === 'Invalid role IDs') {
      return NextResponse.json({ error: 'Invalid role IDs' }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to reorder roles' }, { status: 500 });
  }
}
