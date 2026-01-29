import { NextResponse } from 'next/server';
import {
  authenticateRequestWithOptions,
  authenticateWithEnforcedContext,
  isAuthError,
  isEnforcedAuthError,
} from '@/lib/auth';
import { z } from 'zod/v4';
import { createPermissionNotification } from '@pagespace/lib';
import {
  loggers,
  grantPagePermission,
  revokePagePermission,
} from '@pagespace/lib/server';
import { permissionManagementService } from '@/services/api';
import { db, pages, eq } from '@pagespace/db';
import { kickUserFromPage, kickUserFromPageActivity } from '@/lib/websocket';

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
  // Authenticate and get EnforcedAuthContext for zero-trust operations
  const auth = await authenticateWithEnforcedContext(req, AUTH_OPTIONS_WRITE);
  if (isEnforcedAuthError(auth)) return auth.error;
  const { ctx } = auth;

  const { pageId } = await params;

  try {
    const body = await req.json();
    const parsed = postSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues }, { status: 400 });
    }
    const { userId: targetUserId, canView, canEdit, canShare, canDelete } = parsed.data;

    // Zero-trust grant - authorization happens inside the function
    const result = await grantPagePermission(ctx, {
      pageId,
      targetUserId,
      permissions: { canView, canEdit, canShare, canDelete },
    });

    if (!result.ok) {
      // Map error codes to HTTP responses
      switch (result.error.code) {
        case 'VALIDATION_FAILED':
          return NextResponse.json({ error: result.error.issues }, { status: 400 });
        case 'INVALID_PERMISSION_COMBINATION':
          return NextResponse.json({ error: result.error.message }, { status: 400 });
        case 'SELF_PERMISSION_DENIED':
          return NextResponse.json({ error: result.error.reason }, { status: 400 });
        case 'PAGE_NOT_ACCESSIBLE':
          return NextResponse.json({ error: 'You do not have permission to share this page' }, { status: 403 });
        case 'USER_NOT_FOUND':
          return NextResponse.json({ error: 'Target user not found' }, { status: 404 });
        case 'INSUFFICIENT_PERMISSION':
          return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
        default:
          return NextResponse.json({ error: 'Permission operation failed' }, { status: 500 });
      }
    }

    // Send notification (audit logging already handled by zero-trust function)
    await createPermissionNotification(
      targetUserId,
      pageId,
      result.data.isUpdate ? 'updated' : 'granted',
      { canView, canEdit, canShare, canDelete },
      ctx.userId
    );

    // Fetch permission details for response
    const page = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      columns: { driveId: true },
    });

    return NextResponse.json({
      id: result.data.permissionId,
      pageId,
      userId: targetUserId,
      canView,
      canEdit,
      canShare,
      canDelete,
      grantedBy: ctx.userId,
      driveId: page?.driveId,
    }, { status: result.data.isUpdate ? 200 : 201 });
  } catch (error) {
    loggers.api.error('Error creating permission:', error as Error);
    return NextResponse.json({ error: 'Failed to create permission' }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  // Authenticate and get EnforcedAuthContext for zero-trust operations
  const auth = await authenticateWithEnforcedContext(req, AUTH_OPTIONS_WRITE);
  if (isEnforcedAuthError(auth)) return auth.error;
  const { ctx } = auth;

  const { pageId } = await params;

  try {
    const { userId: targetUserId } = await req.json();

    // Zero-trust revoke - authorization happens inside the function
    const result = await revokePagePermission(ctx, {
      pageId,
      targetUserId,
    });

    if (!result.ok) {
      // Map error codes to HTTP responses
      switch (result.error.code) {
        case 'VALIDATION_FAILED':
          return NextResponse.json({ error: result.error.issues }, { status: 400 });
        case 'SELF_PERMISSION_DENIED':
          return NextResponse.json({ error: result.error.reason }, { status: 400 });
        case 'PAGE_NOT_ACCESSIBLE':
          return NextResponse.json({ error: 'You do not have permission to manage this page' }, { status: 403 });
        case 'INSUFFICIENT_PERMISSION':
          return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
        default:
          return NextResponse.json({ error: 'Permission operation failed' }, { status: 500 });
      }
    }

    // Send notification and kick user only if permission was actually revoked
    // (Audit logging already handled by zero-trust function with previousValues)
    if (result.data.revoked) {
      await createPermissionNotification(
        targetUserId,
        pageId,
        'revoked',
        {},
        ctx.userId
      );

      // CRITICAL: Kick user from real-time rooms immediately (zero-trust revocation)
      await Promise.all([
        kickUserFromPage(pageId, targetUserId, 'permission_revoked'),
        kickUserFromPageActivity(pageId, targetUserId, 'permission_revoked'),
      ]);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error deleting permission:', error as Error);
    return NextResponse.json({ error: 'Failed to delete permission' }, { status: 500 });
  }
}
