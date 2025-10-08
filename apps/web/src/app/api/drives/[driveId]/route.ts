import { NextResponse } from 'next/server';
import { drives, db, eq, and, driveMembers } from '@pagespace/db';
import { z } from 'zod';
import { loggers } from '@pagespace/lib/server';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/socket-utils';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };

const patchSchema = z.object({
  name: z.string().optional(),
  aiProvider: z.string().optional(),
  aiModel: z.string().optional(),
});

/**
 * GET /api/drives/[driveId]
 * Get drive details including AI model preferences
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const { driveId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      return auth.error;
    }
    const userId = auth.userId;

    // First try to get the drive
    const drive = await db.query.drives.findFirst({
      where: eq(drives.id, driveId),
    });

    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    // Check if user has access (owner or member)
    const isOwned = drive.ownerId === userId;
    let isMember = false;
    
    if (!isOwned) {
      const membership = await db.query.driveMembers.findFirst({
        where: and(
          eq(driveMembers.driveId, drive.id),
          eq(driveMembers.userId, userId)
        ),
      });

      if (!membership) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 });
      }
      
      isMember = true;
    }

    // Return drive with ownership/membership flags
    return NextResponse.json({
      ...drive,
      isOwned,
      isMember
    });
  } catch (error) {
    loggers.api.error('Error fetching drive:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch drive' }, { status: 500 });
  }
}

/**
 * PATCH /api/drives/[driveId]
 * Update drive settings including AI model preferences
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const { driveId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      return auth.error;
    }
    const userId = auth.userId;

    const body = await request.json();
    const validatedBody = patchSchema.parse(body);

    // Find the drive
    const drive = await db.query.drives.findFirst({
      where: eq(drives.id, driveId),
    });

    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    // Check if user is owner or admin
    const isOwner = drive.ownerId === userId;
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
      return NextResponse.json({ error: 'Only drive owners and admins can update drive settings' }, { status: 403 });
    }

    // Update the drive
    await db
      .update(drives)
      .set({
        ...validatedBody,
        updatedAt: new Date(),
      })
      .where(eq(drives.id, drive.id));

    // Fetch updated drive
    const updatedDrive = await db.query.drives.findFirst({
      where: eq(drives.id, drive.id),
    });

    // Broadcast drive update event if name changed
    if (validatedBody.name) {
      await broadcastDriveEvent(
        createDriveEventPayload(drive.id, 'updated', {
          name: updatedDrive?.name,
          slug: updatedDrive?.slug,
        })
      );
    }

    return NextResponse.json(updatedDrive);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request body', details: error.issues }, { status: 400 });
    }
    loggers.api.error('Error updating drive:', error as Error);
    return NextResponse.json({ error: 'Failed to update drive' }, { status: 500 });
  }
}

/**
 * DELETE /api/drives/[driveId]
 * Move drive to trash (soft delete)
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const { driveId } = await context.params;
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      return auth.error;
    }
    const userId = auth.userId;

    // Find the drive
    const drive = await db.query.drives.findFirst({
      where: eq(drives.id, driveId),
    });

    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    // Check if user is owner or admin
    const isOwner = drive.ownerId === userId;
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
      return NextResponse.json({ error: 'Only drive owners and admins can delete drives' }, { status: 403 });
    }

    // Move drive to trash
    await db
      .update(drives)
      .set({
        isTrashed: true,
        trashedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(drives.id, drive.id));

    // Broadcast drive deletion event
    await broadcastDriveEvent(
      createDriveEventPayload(drive.id, 'deleted', {
        name: drive.name,
        slug: drive.slug,
      })
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error deleting drive:', error as Error);
    return NextResponse.json({ error: 'Failed to delete drive' }, { status: 500 });
  }
}
