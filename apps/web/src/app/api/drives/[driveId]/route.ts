import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getDriveById,
  getDriveAccess,
  getDriveWithAccess,
  updateDrive,
  trashDrive,
} from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { getActorInfo, logDriveActivity } from '@pagespace/lib/monitoring/activity-logger';

const AUTH_OPTIONS_READ = { allow: ['jwt', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['jwt', 'mcp'] as const, requireCSRF: true };

const patchSchema = z.object({
  name: z.string().optional(),
  aiProvider: z.string().optional(),
  aiModel: z.string().optional(),
  drivePrompt: z.string().max(10000).optional(),
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
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) {
      return auth.error;
    }
    const userId = auth.userId;

    const driveWithAccess = await getDriveWithAccess(driveId, userId);

    if (!driveWithAccess) {
      // Check if drive exists at all for proper error
      const drive = await getDriveById(driveId);
      if (!drive) {
        return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
      }
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    return NextResponse.json(driveWithAccess);
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
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) {
      return auth.error;
    }
    const userId = auth.userId;

    const body = await request.json();
    const validatedBody = patchSchema.parse(body);

    // Check drive exists
    const drive = await getDriveById(driveId);
    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    // Check authorization
    const access = await getDriveAccess(driveId, userId);
    if (!access.isOwner && !access.isAdmin) {
      return NextResponse.json(
        { error: 'Only drive owners and admins can update drive settings' },
        { status: 403 }
      );
    }

    // Update the drive
    const updatedDrive = await updateDrive(driveId, {
      name: validatedBody.name,
      drivePrompt: validatedBody.drivePrompt,
    });

    // Broadcast drive update event if name changed
    if (validatedBody.name && updatedDrive) {
      await broadcastDriveEvent(
        createDriveEventPayload(drive.id, 'updated', {
          name: updatedDrive.name,
          slug: updatedDrive.slug,
        })
      );
    }

    // Log activity for audit trail
    const actorInfo = await getActorInfo(userId);
    const updatedFields = Object.keys(validatedBody).filter(
      (key) => validatedBody[key as keyof typeof validatedBody] !== undefined
    );
    const previousValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};
    if (validatedBody.name !== undefined) {
      previousValues.name = drive.name;
      newValues.name = updatedDrive?.name ?? drive.name;
    }
    if (validatedBody.drivePrompt !== undefined) {
      previousValues.drivePrompt = drive.drivePrompt;
      newValues.drivePrompt = updatedDrive?.drivePrompt ?? drive.drivePrompt;
    }

    logDriveActivity(userId, 'update', {
      id: driveId,
      name: updatedDrive?.name ?? drive.name,
    }, {
      ...actorInfo,
      metadata: {
        updatedFields,
        previousName: drive.name,
        newName: validatedBody.name,
      },
      previousValues: Object.keys(previousValues).length > 0 ? previousValues : undefined,
      newValues: Object.keys(newValues).length > 0 ? newValues : undefined,
    });

    return NextResponse.json(updatedDrive);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request body', details: error.issues },
        { status: 400 }
      );
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
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) {
      return auth.error;
    }
    const userId = auth.userId;

    // Check drive exists
    const drive = await getDriveById(driveId);
    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    // Check authorization
    const access = await getDriveAccess(driveId, userId);
    if (!access.isOwner && !access.isAdmin) {
      return NextResponse.json(
        { error: 'Only drive owners and admins can delete drives' },
        { status: 403 }
      );
    }

    // Move drive to trash
    await trashDrive(driveId);

    // Broadcast drive deletion event
    await broadcastDriveEvent(
      createDriveEventPayload(drive.id, 'deleted', {
        name: drive.name,
        slug: drive.slug,
      })
    );

    // Log activity for audit trail
    const actorInfo = await getActorInfo(userId);
    logDriveActivity(userId, 'trash', {
      id: driveId,
      name: drive.name,
    }, {
      ...actorInfo,
      previousValues: { isTrashed: drive.isTrashed },
      newValues: { isTrashed: true },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error deleting drive:', error as Error);
    return NextResponse.json({ error: 'Failed to delete drive' }, { status: 500 });
  }
}
