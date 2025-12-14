import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  checkDriveAccessForRoles,
  listDriveRoles,
  createDriveRole,
  validateRolePermissions,
} from '@pagespace/lib/server';

const AUTH_OPTIONS_READ = { allow: ['jwt'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['jwt'] as const, requireCSRF: true };

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

    // Check if user has access to this drive
    const access = await checkDriveAccessForRoles(driveId, userId);

    if (!access.drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    if (!access.isOwner && !access.isMember) {
      return NextResponse.json({ error: 'Not a member of this drive' }, { status: 403 });
    }

    // Fetch all roles for the drive
    const roles = await listDriveRoles(driveId);

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

    // Check if user is owner or admin
    const access = await checkDriveAccessForRoles(driveId, userId);

    if (!access.drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    if (!access.isOwner && !access.isAdmin) {
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

    if (!validateRolePermissions(permissions)) {
      return NextResponse.json({ error: 'Invalid permissions structure' }, { status: 400 });
    }

    const newRole = await createDriveRole(driveId, {
      name: trimmedName,
      description,
      color,
      isDefault,
      permissions,
    });

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
