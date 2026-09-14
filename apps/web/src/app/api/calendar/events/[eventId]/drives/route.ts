import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { calendarEvents } from '@pagespace/db/schema/calendar';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope, isPrincipalDriveMember, isPrincipalDriveOwnerOrAdmin } from '@/lib/auth';
import { eventOutOfScopeResponse, isPersonalEventOutOfScope } from '../../personal-event-scope';
import {
  isUserMemberOfAnyEventDrive,
  shareEventWithDrive,
  unshareEventFromDrive,
  listEventDrives,
} from '@pagespace/lib/services/calendar-event-drive-service';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp', 'oauth'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp', 'oauth'] as const, requireCSRF: true };

const shareSchema = z.object({
  driveId: z.string().min(1),
});

/**
 * GET /api/calendar/events/[eventId]/drives
 *
 * List all drives an event is shared with.
 * Home drive (isHome: true) is always first.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;

  try {
    const [event] = await db
      .select({
        id: calendarEvents.id,
        driveId: calendarEvents.driveId,
        createdById: calendarEvents.createdById,
      })
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.isTrashed, false)))
      .limit(1);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    if (isPersonalEventOutOfScope(auth, event)) return eventOutOfScopeResponse();

    if (event.driveId) {
      const scopeError = checkMCPDriveScope(auth, event.driveId);
      if (scopeError) return scopeError;
    }

    const canAccess = event.createdById === auth.userId || await isUserMemberOfAnyEventDrive(auth.userId, event);
    if (!canAccess) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const drives = await listEventDrives(eventId);
    return NextResponse.json({ drives });
  } catch (error) {
    loggers.api.error('Error listing event drives:', error as Error);
    return NextResponse.json({ error: 'Failed to list event drives' }, { status: 500 });
  }
}

/**
 * POST /api/calendar/events/[eventId]/drives
 *
 * Share an event with an additional drive.
 * Body: { driveId: string }
 *
 * Caller must be the event creator OR an admin of the home drive,
 * AND a member of the target drive.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  try {
    const body = await request.json();
    const parseResult = shareSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parseResult.error.issues },
        { status: 400 },
      );
    }

    const { driveId } = parseResult.data;

    const [event] = await db
      .select({ driveId: calendarEvents.driveId, createdById: calendarEvents.createdById })
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.isTrashed, false)))
      .limit(1);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    if (isPersonalEventOutOfScope(auth, event)) return eventOutOfScopeResponse();

    // MCP scope is gated on the home drive
    if (event.driveId) {
      const scopeError = checkMCPDriveScope(auth, event.driveId);
      if (scopeError) return scopeError;
    }

    // …and on the TARGET drive: sharing writes that drive's calendar, and the
    // service below only checks the owning USER's membership of it.
    const targetScopeError = checkMCPDriveScope(auth, driveId);
    if (targetScopeError) return targetScopeError;

    // The credential's OWN authority as well — the service below decides for
    // the user only. Another user's event needs the credential to be owner/admin
    // of the home drive, and the target needs the credential as a member.
    if (event.driveId && event.createdById !== auth.userId && !(await isPrincipalDriveOwnerOrAdmin(auth, event.driveId))) {
      return NextResponse.json({ error: 'You do not have permission to share this event' }, { status: 403 });
    }
    if (!(await isPrincipalDriveMember(auth, driveId))) {
      return NextResponse.json({ error: 'You are not a member of the target drive' }, { status: 400 });
    }

    // user-identity: the service re-checks the USER's creator/home-admin/target-member standing after the credential checks above.
    const result = await shareEventWithDrive({ actingUserId: auth.userId, eventId, driveId });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    auditRequest(request, {
      eventType: 'data.write',
      userId: auth.userId,
      resourceType: 'calendar_event_drive',
      resourceId: eventId,
      details: { driveId },
    });

    return NextResponse.json({ row: result.row }, { status: 201 });
  } catch (error) {
    loggers.api.error('Error sharing event with drive:', error as Error);
    return NextResponse.json({ error: 'Failed to share event with drive' }, { status: 500 });
  }
}

/**
 * DELETE /api/calendar/events/[eventId]/drives?driveId=
 *
 * Remove a drive from an event's shared-drive list.
 * The home drive (calendarEvents.driveId) cannot be removed.
 *
 * Caller must be the event creator, OR an admin of the home drive,
 * OR an admin of the target drive.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;

  const { searchParams } = new URL(request.url);
  const driveId = searchParams.get('driveId');
  if (!driveId) {
    return NextResponse.json({ error: 'driveId query parameter is required' }, { status: 400 });
  }

  try {
    const [event] = await db
      .select({ driveId: calendarEvents.driveId, createdById: calendarEvents.createdById })
      .from(calendarEvents)
      .where(and(eq(calendarEvents.id, eventId), eq(calendarEvents.isTrashed, false)))
      .limit(1);

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    if (isPersonalEventOutOfScope(auth, event)) return eventOutOfScopeResponse();

    if (event.driveId) {
      const scopeError = checkMCPDriveScope(auth, event.driveId);
      if (scopeError) return scopeError;
    }

    // …and on the TARGET drive: unsharing removes the event from that drive's
    // calendar, and the service below only checks the owning USER's authority.
    const targetScopeError = checkMCPDriveScope(auth, driveId);
    if (targetScopeError) return targetScopeError;

    // The credential's OWN authority as well — the service below decides for the
    // user only: creator, or owner/admin of the home or the target drive.
    const credentialCanManage =
      event.createdById === auth.userId ||
      (event.driveId !== null && (await isPrincipalDriveOwnerOrAdmin(auth, event.driveId))) ||
      (await isPrincipalDriveOwnerOrAdmin(auth, driveId));
    if (!credentialCanManage) {
      return NextResponse.json({ error: 'You do not have permission to remove this drive share' }, { status: 403 });
    }

    // user-identity: the service re-checks the USER's creator/home-admin/target-admin standing after the credential check above.
    const result = await unshareEventFromDrive({ actingUserId: auth.userId, eventId, driveId });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    auditRequest(request, {
      eventType: 'data.delete',
      userId: auth.userId,
      resourceType: 'calendar_event_drive',
      resourceId: eventId,
      details: { driveId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error unsharing event from drive:', error as Error);
    return NextResponse.json({ error: 'Failed to unshare event from drive' }, { status: 500 });
  }
}
