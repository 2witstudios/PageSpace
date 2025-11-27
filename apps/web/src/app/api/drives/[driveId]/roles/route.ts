import { NextResponse } from 'next/server';
import { db, eq, and, asc } from '@pagespace/db';
import { driveRoles, driveMembers } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

// Type for role permissions structure
type RolePermissions = {
  defaultPermissions: { canView: boolean; canEdit: boolean; canShare: boolean };
  pageOverrides?: Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>;
};

// Validate that permissions has the correct structure
function validatePermissions(permissions: unknown): permissions is RolePermissions {
  if (!permissions || typeof permissions !== 'object') return false;
  const p = permissions as Record<string, unknown>;

  // Validate defaultPermissions
  if (!p.defaultPermissions || typeof p.defaultPermissions !== 'object') return false;
  const dp = p.defaultPermissions as Record<string, unknown>;
  if (typeof dp.canView !== 'boolean' ||
      typeof dp.canEdit !== 'boolean' ||
      typeof dp.canShare !== 'boolean') return false;

  // Validate pageOverrides if present
  if (p.pageOverrides !== undefined) {
    if (typeof p.pageOverrides !== 'object' || p.pageOverrides === null) return false;
    for (const override of Object.values(p.pageOverrides as Record<string, unknown>)) {
      if (!override || typeof override !== 'object') return false;
      const o = override as Record<string, unknown>;
      if (typeof o.canView !== 'boolean' ||
          typeof o.canEdit !== 'boolean' ||
          typeof o.canShare !== 'boolean') return false;
    }
  }

  return true;
}

// GET /api/drives/[driveId]/roles - List all roles for a drive
export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId } = await context.params;

    // Check if user is a member of the drive
    const membership = await db.query.driveMembers.findFirst({
      where: and(
        eq(driveMembers.driveId, driveId),
        eq(driveMembers.userId, userId)
      ),
    });

    if (!membership) {
      return NextResponse.json({ error: 'Not a member of this drive' }, { status: 403 });
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
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { driveId } = await context.params;

    // Check if user is owner or admin
    const membership = await db.query.driveMembers.findFirst({
      where: and(
        eq(driveMembers.driveId, driveId),
        eq(driveMembers.userId, userId)
      ),
    });

    if (!membership || (membership.role !== 'OWNER' && membership.role !== 'ADMIN')) {
      return NextResponse.json({ error: 'Only owners and admins can create roles' }, { status: 403 });
    }

    const body = await request.json();
    const { name, description, color, isDefault, permissions } = body;

    if (!name || !permissions) {
      return NextResponse.json({ error: 'Name and permissions are required' }, { status: 400 });
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
      name,
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
