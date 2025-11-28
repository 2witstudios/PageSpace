import { NextResponse } from 'next/server';
import { db, eq, and } from '@pagespace/db';
import { driveRoles, driveMembers, drives } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

// Type for role permissions structure (Record<pageId, permissions>)
type RolePermissions = Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>;

// Validate that permissions has the correct structure
function validatePermissions(permissions: unknown): permissions is RolePermissions {
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return false;

  // Validate each page's permissions
  for (const [pageId, perms] of Object.entries(permissions)) {
    if (typeof pageId !== 'string') return false;
    if (!perms || typeof perms !== 'object') return false;
    const p = perms as Record<string, unknown>;
    if (typeof p.canView !== 'boolean' ||
        typeof p.canEdit !== 'boolean' ||
        typeof p.canShare !== 'boolean') return false;
  }

  return true;
}

// GET /api/drives/[driveId]/roles/[roleId] - Get a specific role
export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string; roleId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId, roleId } = await context.params;

    // Get drive and check access
    const drive = await db.select()
      .from(drives)
      .where(eq(drives.id, driveId))
      .limit(1);

    if (drive.length === 0) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    // Check if user is owner or member of the drive
    const isOwner = drive[0].ownerId === userId;
    if (!isOwner) {
      const membership = await db.query.driveMembers.findFirst({
        where: and(
          eq(driveMembers.driveId, driveId),
          eq(driveMembers.userId, userId)
        ),
      });

      if (!membership) {
        return NextResponse.json({ error: 'Not a member of this drive' }, { status: 403 });
      }
    }

    const role = await db.query.driveRoles.findFirst({
      where: and(
        eq(driveRoles.id, roleId),
        eq(driveRoles.driveId, driveId)
      ),
    });

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
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId, roleId } = await context.params;

    // Get drive and check ownership
    const drive = await db.select()
      .from(drives)
      .where(eq(drives.id, driveId))
      .limit(1);

    if (drive.length === 0) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    // Check if user is owner or admin
    const isOwner = drive[0].ownerId === userId;
    let isAdmin = false;

    if (!isOwner) {
      const adminMembership = await db.select()
        .from(driveMembers)
        .where(and(
          eq(driveMembers.driveId, driveId),
          eq(driveMembers.userId, userId),
          eq(driveMembers.role, 'ADMIN')
        ))
        .limit(1);

      isAdmin = adminMembership.length > 0;
    }

    if (!isOwner && !isAdmin) {
      return NextResponse.json({ error: 'Only owners and admins can update roles' }, { status: 403 });
    }

    // Check role exists
    const existingRole = await db.query.driveRoles.findFirst({
      where: and(
        eq(driveRoles.id, roleId),
        eq(driveRoles.driveId, driveId)
      ),
    });

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
    if (permissions !== undefined && !validatePermissions(permissions)) {
      return NextResponse.json({ error: 'Invalid permissions structure' }, { status: 400 });
    }

    // If setting as default, unset other defaults
    if (isDefault && !existingRole.isDefault) {
      await db.update(driveRoles)
        .set({ isDefault: false })
        .where(eq(driveRoles.driveId, driveId));
    }

    const [updatedRole] = await db.update(driveRoles)
      .set({
        ...(name !== undefined && { name: name.trim() }),
        ...(description !== undefined && { description }),
        ...(color !== undefined && { color }),
        ...(isDefault !== undefined && { isDefault }),
        ...(permissions !== undefined && { permissions }),
        updatedAt: new Date(),
      })
      .where(and(
        eq(driveRoles.id, roleId),
        eq(driveRoles.driveId, driveId)
      ))
      .returning();

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
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId, roleId } = await context.params;

    // Get drive and check ownership
    const drive = await db.select()
      .from(drives)
      .where(eq(drives.id, driveId))
      .limit(1);

    if (drive.length === 0) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    // Check if user is owner or admin
    const isOwner = drive[0].ownerId === userId;
    let isAdmin = false;

    if (!isOwner) {
      const adminMembership = await db.select()
        .from(driveMembers)
        .where(and(
          eq(driveMembers.driveId, driveId),
          eq(driveMembers.userId, userId),
          eq(driveMembers.role, 'ADMIN')
        ))
        .limit(1);

      isAdmin = adminMembership.length > 0;
    }

    if (!isOwner && !isAdmin) {
      return NextResponse.json({ error: 'Only owners and admins can delete roles' }, { status: 403 });
    }

    // Check role exists
    const existingRole = await db.query.driveRoles.findFirst({
      where: and(
        eq(driveRoles.id, roleId),
        eq(driveRoles.driveId, driveId)
      ),
    });

    if (!existingRole) {
      return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    }

    // Delete the role (members with this role will have customRoleId set to null via FK)
    await db.delete(driveRoles)
      .where(and(
        eq(driveRoles.id, roleId),
        eq(driveRoles.driveId, driveId)
      ));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting role:', error);
    return NextResponse.json({ error: 'Failed to delete role' }, { status: 500 });
  }
}
