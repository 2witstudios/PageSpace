import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { z } from 'zod/v4';
import { createPermissionNotification } from '@pagespace/lib';
import { loggers, getActorInfo } from '@pagespace/lib/server';
import { logPermissionActivity } from '@pagespace/lib';
import { permissionManagementService } from '@/services/api';
import { db, pages, pagePermissions, eq, and } from '@pagespace/db';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

export async function GET(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const { pageId } = await params;

  try {
    // Check authorization
    const canView = await permissionManagementService.canUserViewPermissions(userId, pageId);
    if (!canView) {
      loggers.api.warn('Unauthorized permission list access attempt', { userId, pageId });
      return NextResponse.json(
        {
          error: 'You need share permission to view the permission list for this page',
          details: 'Only users who can manage permissions can view who has access'
        },
        { status: 403 }
      );
    }

    // Get permissions
    const result = await permissionManagementService.getPagePermissions(pageId);
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({
      owner: result.owner,
      permissions: result.permissions,
    });
  } catch (error) {
    loggers.api.error('Error fetching permissions:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch permissions' },
      { status: 500 }
    );
  }
}

const postSchema = z.object({
  userId: z.string(),
  canView: z.boolean().default(false),
  canEdit: z.boolean().default(false),
  canShare: z.boolean().default(false),
  canDelete: z.boolean().default(false),
});

export async function POST(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const currentUserId = auth.userId;

  const { pageId } = await params;

  try {
    const body = await req.json();
    const { userId, canView, canEdit, canShare, canDelete } = postSchema.parse(body);

    // Check authorization
    const canManage = await permissionManagementService.canUserManagePermissions(currentUserId, pageId);
    if (!canManage) {
      return NextResponse.json({ error: 'You do not have permission to share this page' }, { status: 403 });
    }

    // Grant or update permission
    const existingPermission = await db.query.pagePermissions.findFirst({
      where: and(
        eq(pagePermissions.pageId, pageId),
        eq(pagePermissions.userId, userId)
      ),
    });

    const result = await permissionManagementService.grantOrUpdatePermission({
      pageId,
      targetUserId: userId,
      permissions: { canView, canEdit, canShare, canDelete },
      grantedBy: currentUserId,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    // Send notification
    await createPermissionNotification(
      userId,
      pageId,
      result.isUpdate ? 'updated' : 'granted',
      { canView, canEdit, canShare, canDelete },
      currentUserId
    );

    // Log to activity audit trail with actor info
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      columns: { driveId: true, title: true },
    });
    if (page?.driveId) {
      const actorInfo = await getActorInfo(currentUserId);
      const previousValues = existingPermission ? {
        canView: existingPermission.canView,
        canEdit: existingPermission.canEdit,
        canShare: existingPermission.canShare,
        canDelete: existingPermission.canDelete,
        grantedBy: existingPermission.grantedBy,
        note: existingPermission.note,
      } : undefined;
      logPermissionActivity(
        currentUserId,
        result.isUpdate ? 'permission_update' : 'permission_grant',
        {
          pageId,
          driveId: page.driveId,
          targetUserId: userId,
          permissions: { canView, canEdit, canShare, canDelete },
          pageTitle: page.title ?? undefined,
        },
        {
          ...actorInfo,
          previousValues: result.isUpdate ? previousValues : undefined,
        }
      );
    }

    return NextResponse.json(result.permission, { status: result.isUpdate ? 200 : 201 });
  } catch (error) {
    loggers.api.error('Error creating permission:', error as Error);
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to create permission' }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const currentUserId = auth.userId;

  const { pageId } = await params;

  try {
    const { userId } = await req.json();

    // Check authorization
    const canManage = await permissionManagementService.canUserManagePermissions(currentUserId, pageId);
    if (!canManage) {
      return NextResponse.json({ error: 'You do not have permission to manage this page' }, { status: 403 });
    }

    // Revoke permission
    const existingPermission = await db.query.pagePermissions.findFirst({
      where: and(
        eq(pagePermissions.pageId, pageId),
        eq(pagePermissions.userId, userId)
      ),
    });

    const result = await permissionManagementService.revokePermission({
      pageId,
      targetUserId: userId,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    // Send notification
    await createPermissionNotification(
      userId,
      pageId,
      'revoked',
      {},
      currentUserId
    );

    // Log to activity audit trail with actor info
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      columns: { driveId: true, title: true },
    });
    if (page?.driveId) {
      const actorInfo = await getActorInfo(currentUserId);
      const previousValues = existingPermission ? {
        canView: existingPermission.canView,
        canEdit: existingPermission.canEdit,
        canShare: existingPermission.canShare,
        canDelete: existingPermission.canDelete,
        grantedBy: existingPermission.grantedBy,
        note: existingPermission.note,
      } : undefined;
      logPermissionActivity(currentUserId, 'permission_revoke', {
        pageId,
        driveId: page.driveId,
        targetUserId: userId,
        pageTitle: page.title ?? undefined,
      }, {
        ...actorInfo,
        previousValues,
      });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error deleting permission:', error as Error);
    return NextResponse.json({ error: 'Failed to delete permission' }, { status: 500 });
  }
}
