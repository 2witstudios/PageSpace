import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  checkDriveAccessForRoles,
  getRoleById,
  updateDriveRole,
  deleteDriveRole,
  validateRolePermissions,
} from '@pagespace/lib/server';
import { getActorInfo, logRoleActivity } from '@pagespace/lib/monitoring/activity-logger';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

/**
 * Transform RolePermissions to Record<string, boolean> for audit logging.
 * Each page key maps to true if any permission (canView, canEdit, canShare) is granted.
 */
function summarizePermissions(
  permissions: Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>
): Record<string, boolean> {
  return Object.entries(permissions).reduce(
    (acc, [key, perms]) => {
      acc[key] = perms.canView || perms.canEdit || perms.canShare;
      return acc;
    },
    {} as Record<string, boolean>
  );
}

// GET /api/drives/[driveId]/roles/[roleId] - Get a specific role
export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string; roleId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId, roleId } = await context.params;

    // Check if user has access to this drive
    const access = await checkDriveAccessForRoles(driveId, userId);

    if (!access.drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    if (!access.isOwner && !access.isMember) {
      return NextResponse.json({ error: 'Not a member of this drive' }, { status: 403 });
    }

    const role = await getRoleById(driveId, roleId);

    if (!role) {
      return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    }

    return NextResponse.json({ role });
  } catch (error) {
    console.error('Error fetching role:', error);
    return NextResponse.json({ error: 'Failed to fetch role' }, { status: 500 });
  }
}

// PATCH /api/drives/[driveId]/roles/[roleId] - Update a role
export async function PATCH(
  request: Request,
  context: { params: Promise<{ driveId: string; roleId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId, roleId } = await context.params;

    // Check if user is owner or admin
    const access = await checkDriveAccessForRoles(driveId, userId);

    if (!access.drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    if (!access.isOwner && !access.isAdmin) {
      return NextResponse.json({ error: 'Only owners and admins can update roles' }, { status: 403 });
    }

    // Check role exists
    const existingRole = await getRoleById(driveId, roleId);

    if (!existingRole) {
      return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    }

    const body = await request.json();
    const { name, description, color, isDefault, permissions } = body;

    // Validate name length if provided
    if (name !== undefined) {
      const trimmedName = name.trim();
      if (trimmedName.length === 0 || trimmedName.length > 50) {
        return NextResponse.json({ error: 'Role name must be between 1 and 50 characters' }, { status: 400 });
      }
    }

    // Validate permissions structure if provided
    if (permissions !== undefined && !validateRolePermissions(permissions)) {
      return NextResponse.json({ error: 'Invalid permissions structure' }, { status: 400 });
    }

    const { role: updatedRole } = await updateDriveRole(driveId, roleId, {
      name,
      description,
      color,
      isDefault,
      permissions,
    });

    // Log activity for audit trail
    const actorInfo = await getActorInfo(userId);
    logRoleActivity(userId, 'update', {
      roleId,
      roleName: updatedRole.name,
      driveId,
      permissions: permissions ? summarizePermissions(permissions) : undefined,
      previousPermissions: summarizePermissions(existingRole.permissions),
    }, actorInfo);

    return NextResponse.json({ role: updatedRole });
  } catch (error) {
    console.error('Error updating role:', error);
    if (error instanceof Error && error.message.includes('unique')) {
      return NextResponse.json({ error: 'A role with this name already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Failed to update role' }, { status: 500 });
  }
}

// DELETE /api/drives/[driveId]/roles/[roleId] - Delete a role
export async function DELETE(
  request: Request,
  context: { params: Promise<{ driveId: string; roleId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId, roleId } = await context.params;

    // Check if user is owner or admin
    const access = await checkDriveAccessForRoles(driveId, userId);

    if (!access.drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    if (!access.isOwner && !access.isAdmin) {
      return NextResponse.json({ error: 'Only owners and admins can delete roles' }, { status: 403 });
    }

    // Check role exists
    const existingRole = await getRoleById(driveId, roleId);

    if (!existingRole) {
      return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    }

    await deleteDriveRole(driveId, roleId);

    // Log activity for audit trail
    const actorInfo = await getActorInfo(userId);
    logRoleActivity(userId, 'delete', {
      roleId,
      roleName: existingRole.name,
      driveId,
      previousPermissions: summarizePermissions(existingRole.permissions),
    }, actorInfo);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting role:', error);
    return NextResponse.json({ error: 'Failed to delete role' }, { status: 500 });
  }
}
