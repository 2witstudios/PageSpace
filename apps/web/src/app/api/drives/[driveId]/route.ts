import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getDriveById, getDriveWithAccess, updateDrive, trashDrive, isValidDriveHomePage } from '@pagespace/lib/services/drive-service';
import { isReservedDriveName, isHomeDrive, homeDriveActionError } from '@pagespace/lib/services/drive-guards';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getDriveRecipientUserIds } from '@pagespace/lib/services/drive-member-service';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/websocket';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope, isMCPAuthResult, isScopedMCPAuth, isPrincipalDriveOwnerOrAdmin } from '@/lib/auth';
import { getAppDriveMembership, getAppDriveAccessLevel } from '@pagespace/lib/permissions/app-permissions';
import { getActorInfo, logDriveActivity } from '@pagespace/lib/monitoring/activity-logger';
import { trackDriveOperation } from '@pagespace/lib/monitoring/activity-tracker';
import { syncPublishedHomeRoot } from '@/lib/canvas/publish-page';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp', 'oauth'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

const patchSchema = z.object({
  name: z.string().optional(),
  aiProvider: z.string().optional(),
  aiModel: z.string().optional(),
  drivePrompt: z.string().max(10000).optional(),
  // min(1): "" must never reach the FK; null is the only clear signal
  homePageId: z.string().min(1).nullable().optional(),
  // Drive-wide default OG/share image. "" or null clears it; a non-empty value
  // must be a valid URL.
  publishDefaultOgImageUrl: z.union([z.literal(''), z.string().url()]).nullable().optional(),
}).strict();

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

    // Check MCP token scope before drive access
    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    const userId = auth.userId;

    // A scoped MCP token is its own drive member — gate on and report the
    // TOKEN's membership, not the owning user's.
    if (isScopedMCPAuth(auth)) {
      const drive = await getDriveById(driveId);
      if (!drive) {
        return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
      }
      const level = await getAppDriveAccessLevel(auth.tokenId, driveId);
      if (!level?.canView) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 });
      }
      const membership = await getAppDriveMembership(auth.tokenId, driveId);
      if (membership?.role === null) {
        // Inherit: the key is its owner — present the owner's own relationship.
        const inherited = await getDriveWithAccess(driveId, userId);
        if (inherited) return NextResponse.json(inherited);
      }
      return NextResponse.json({
        ...drive,
        isOwned: false,
        isMember: true,
        role: membership?.role ?? 'MEMBER',
        lastAccessedAt: null,
      });
    }

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

    // Check MCP token scope before drive access
    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    const userId = auth.userId;

    const body = await request.json();

    // publishSubdomain lives on this schema's reject-list, not its allow-list:
    // it has its own dedicated endpoint (tier-gating, conflict checks, and
    // republish/rollback via changePublishSubdomain()) that this generic route
    // must not bypass or duplicate.
    if (typeof body === 'object' && body !== null && 'publishSubdomain' in body) {
      return NextResponse.json(
        { error: 'publishSubdomain cannot be changed via this endpoint. Use PATCH /api/drives/[driveId]/subdomain instead.' },
        { status: 400 }
      );
    }

    const validatedBody = patchSchema.parse(body);

    // Check drive exists
    const drive = await getDriveById(driveId);
    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    // Home drives cannot be renamed; drivePrompt-only updates are allowed.
    if (validatedBody.name !== undefined && isHomeDrive(drive)) {
      return NextResponse.json({ error: homeDriveActionError(drive, 'rename') }, { status: 403 });
    }

    // Reserved-name check for the new name.
    if (validatedBody.name !== undefined && isReservedDriveName(validatedBody.name)) {
      return NextResponse.json({ error: 'Cannot rename a drive to that name.' }, { status: 400 });
    }

    // Check authorization: owner/admin authority. Scoped tokens with an
    // explicit role need OWNER/ADMIN; inherited keys use the owner's authority.
    if (!(await isPrincipalDriveOwnerOrAdmin(auth, driveId))) {
      return NextResponse.json(
        { error: 'Only drive owners and admins can update drive settings' },
        { status: 403 }
      );
    }

    // A home page must be a non-trashed page belonging to this drive
    if (typeof validatedBody.homePageId === 'string') {
      const validHomePage = await isValidDriveHomePage(driveId, validatedBody.homePageId);
      if (!validHomePage) {
        return NextResponse.json(
          { error: 'Home page must be a non-trashed page in this drive' },
          { status: 400 }
        );
      }
    }

    // Update the drive. An empty-string default OG image is normalized to null
    // (clear) so the column never holds a blank string.
    const updatedDrive = await updateDrive(driveId, {
      name: validatedBody.name,
      drivePrompt: validatedBody.drivePrompt,
      homePageId: validatedBody.homePageId,
      publishDefaultOgImageUrl:
        validatedBody.publishDefaultOgImageUrl === undefined
          ? undefined
          : validatedBody.publishDefaultOgImageUrl || null,
    });

    // Broadcast drive update event if name, drivePrompt, or homePageId changed
    if (updatedDrive && (validatedBody.name || validatedBody.drivePrompt !== undefined || validatedBody.homePageId !== undefined)) {
      const recipientUserIds = await getDriveRecipientUserIds(driveId);
      await broadcastDriveEvent(
        createDriveEventPayload(drive.id, 'updated', {
          name: updatedDrive.name,
          slug: updatedDrive.slug,
        }),
        recipientUserIds
      );
    }

    trackDriveOperation(userId, 'update', driveId, {
      name: updatedDrive?.name,
      updatedFields: Object.keys(validatedBody),
    });

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
    if (validatedBody.homePageId !== undefined) {
      previousValues.homePageId = drive.homePageId;
      newValues.homePageId = validatedBody.homePageId;
    }

    const isMCP = isMCPAuthResult(auth);
    logDriveActivity(userId, 'update', {
      id: driveId,
      name: updatedDrive?.name ?? drive.name,
    }, {
      ...actorInfo,
      metadata: {
        updatedFields,
        previousName: drive.name,
        newName: validatedBody.name,
        ...(isMCP && { source: 'mcp' }),
      },
      previousValues: Object.keys(previousValues).length > 0 ? previousValues : undefined,
      newValues: Object.keys(newValues).length > 0 ? newValues : undefined,
    });

    auditRequest(request, { eventType: 'data.write', userId, resourceType: 'drive', resourceId: driveId, details: { operation: 'update' } });

    // When the home page changes, sync the subdomain root immediately so `/`
    // reflects the new home without requiring a manual republish. Best-effort,
    // fire-and-forget — never blocks the response. An unpublished page set as
    // home stays private (syncPublishedHomeRoot checks the published_pages table).
    if (validatedBody.homePageId !== undefined) {
      void syncPublishedHomeRoot(driveId);
    }

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

    // Check MCP token scope before drive access
    const scopeError = checkMCPDriveScope(auth, driveId);
    if (scopeError) return scopeError;

    const userId = auth.userId;

    // Check drive exists
    const drive = await getDriveById(driveId);
    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    // Home drives cannot be trashed.
    if (isHomeDrive(drive)) {
      return NextResponse.json({ error: homeDriveActionError(drive, 'trash') }, { status: 403 });
    }

    // Check authorization: owner/admin authority. Scoped tokens with an
    // explicit role need OWNER/ADMIN; inherited keys use the owner's authority.
    if (!(await isPrincipalDriveOwnerOrAdmin(auth, driveId))) {
      return NextResponse.json(
        { error: 'Only drive owners and admins can delete drives' },
        { status: 403 }
      );
    }

    // Get recipients BEFORE trashing (ensures we have valid member list)
    const recipientUserIds = await getDriveRecipientUserIds(driveId);

    // Move drive to trash
    await trashDrive(driveId);

    // Broadcast drive deletion event
    await broadcastDriveEvent(
      createDriveEventPayload(drive.id, 'deleted', {
        name: drive.name,
        slug: drive.slug,
      }),
      recipientUserIds
    );

    trackDriveOperation(userId, 'delete', driveId, {
      name: drive.name,
      slug: drive.slug,
    });

    // Log activity for audit trail
    const actorInfo = await getActorInfo(userId);
    const isMCP = isMCPAuthResult(auth);
    logDriveActivity(userId, 'trash', {
      id: driveId,
      name: drive.name,
    }, {
      ...actorInfo,
      metadata: isMCP ? { source: 'mcp' } : undefined,
      previousValues: { isTrashed: drive.isTrashed },
      newValues: { isTrashed: true },
    });

    auditRequest(request, { eventType: 'data.delete', userId, resourceType: 'drive', resourceId: driveId, details: { operation: 'trash' } });

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error deleting drive:', error as Error);
    return NextResponse.json({ error: 'Failed to delete drive' }, { status: 500 });
  }
}
