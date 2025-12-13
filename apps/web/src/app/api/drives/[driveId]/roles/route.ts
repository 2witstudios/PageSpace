import { NextResponse } from 'next/server';
import { db, eq, and, asc } from '@pagespace/db';
import { driveRoles, driveMembers, drives } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS_READ = { allow: ['jwt'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['jwt'] as const, requireCSRF: true };

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

// GET /api/drives/[driveId]/roles - List all roles for a drive
export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId } = await context.params;

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

    // Fetch all roles for the drive
    const roles = await db.query.driveRoles.findMany({
      where: eq(driveRoles.driveId, driveId),
      orderBy: [asc(driveRoles.position)],
    });

    return NextResponse.json({ roles });
  } catch (error) {
    console.error('Error fetching roles:', error);
    return NextResponse.json({ error: 'Failed to fetch roles' }, { status: 500 });
  }
}

// POST /api/drives/[driveId]/roles - Create a new role
export async function POST(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId } = await context.params;

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
      return NextResponse.json({ error: 'Only owners and admins can create roles' }, { status: 403 });
    }

    const body = await request.json();
    const { name, description, color, isDefault, permissions } = body;

    if (!name || !permissions) {
      return NextResponse.json({ error: 'Name and permissions are required' }, { status: 400 });
    }

    const trimmedName = name.trim();
    if (trimmedName.length === 0 || trimmedName.length > 50) {
      return NextResponse.json({ error: 'Role name must be between 1 and 50 characters' }, { status: 400 });
    }

    if (!validatePermissions(permissions)) {
      return NextResponse.json({ error: 'Invalid permissions structure' }, { status: 400 });
    }

    // Get the highest position to add new role at the end
    const existingRoles = await db.query.driveRoles.findMany({
      where: eq(driveRoles.driveId, driveId),
      orderBy: [asc(driveRoles.position)],
    });
    const maxPosition = existingRoles.length > 0
      ? Math.max(...existingRoles.map(r => r.position)) + 1
      : 0;

    // If setting as default, unset other defaults
    if (isDefault) {
      await db.update(driveRoles)
        .set({ isDefault: false })
        .where(eq(driveRoles.driveId, driveId));
    }

    const [newRole] = await db.insert(driveRoles).values({
      driveId,
      name: trimmedName,
      description,
      color,
      isDefault: isDefault || false,
      permissions,
      position: maxPosition,
      updatedAt: new Date(),
    }).returning();

    return NextResponse.json({ role: newRole }, { status: 201 });
  } catch (error) {
    console.error('Error creating role:', error);
    // Check for unique constraint violation
    if (error instanceof Error && error.message.includes('unique')) {
      return NextResponse.json({ error: 'A role with this name already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Failed to create role' }, { status: 500 });
  }
}
