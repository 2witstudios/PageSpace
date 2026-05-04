import { NextResponse, after } from 'next/server';
import { z } from 'zod';
import { db } from '@pagespace/db/db'
import { eq, and, sql } from '@pagespace/db/operators'
import { calendarEvents, eventAttendees } from '@pagespace/db/schema/calendar';
import { calendarTriggers } from '@pagespace/db/schema/calendar-triggers';
import { workflowRuns } from '@pagespace/db/schema/workflow-runs';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope } from '@/lib/auth';
import { isUserDriveMember, isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import { broadcastCalendarEvent } from '@/lib/websocket/calendar-events';
import { pushEventUpdateToGoogle, pushEventDeleteToGoogle } from '@/lib/integrations/google-calendar/push-service';
import { isNaiveISODatetime, parseNaiveDatetimeInTimezone } from '@/lib/ai/core/timestamp-utils';
import {
  removeCalendarTrigger,
  upsertCalendarTriggerWorkflowInTx,
  validateCalendarAgentTrigger,
} from '@/lib/workflows/calendar-trigger-helpers';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

// Schema for updating an event
const updateEventSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).nullable().optional(),
  location: z.string().max(1000).nullable().optional(),
  startAt: z.coerce.date().optional(),
  endAt: z.coerce.date().optional(),
  allDay: z.boolean().optional(),
  timezone: z.string().optional(),
  recurrenceRule: z.object({
    frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
    interval: z.number().int().min(1).default(1),
    byDay: z.array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])).optional(),
    byMonthDay: z.array(z.number().int().min(1).max(31)).optional(),
    byMonth: z.array(z.number().int().min(1).max(12)).optional(),
    count: z.number().int().min(1).optional(),
    until: z.string().optional(),
  }).nullable().optional(),
  visibility: z.enum(['DRIVE', 'ATTENDEES_ONLY', 'PRIVATE']).optional(),
  color: z.string().optional(),
  pageId: z.string().nullable().optional(),
  // agentTrigger has three states:
  //   undefined → leave any existing trigger alone
  //   null      → remove the trigger
  //   object    → upsert with these fields
  agentTrigger: z.object({
    agentPageId: z.string(),
    prompt: z.string().trim().max(10000).optional(),
    instructionPageId: z.string().nullable().optional(),
    contextPageIds: z.array(z.string()).max(10).optional(),
  }).refine(
    (d) => Boolean(d.prompt) || Boolean(d.instructionPageId),
    { message: 'agentTrigger needs either a prompt or an instructionPageId' },
  ).nullable().optional(),
});

/**
 * Check if user can access an event
 */
async function canAccessEvent(userId: string, event: typeof calendarEvents.$inferSelect): Promise<boolean> {
  // Creator always has access
  if (event.createdById === userId) {
    return true;
  }

  // Check if user is an attendee
  const attendee = await db.query.eventAttendees.findFirst({
    where: and(
      eq(eventAttendees.eventId, event.id),
      eq(eventAttendees.userId, userId)
    ),
  });
  if (attendee) {
    return true;
  }

  // Check drive membership for drive events with DRIVE visibility
  if (event.driveId && event.visibility === 'DRIVE') {
    return isUserDriveMember(userId, event.driveId);
  }

  return false;
}

/**
 * Check if user can edit an event (only creator or drive admin)
 */
async function canEditEvent(userId: string, event: typeof calendarEvents.$inferSelect): Promise<boolean> {
  if (event.createdById === userId) return true;
  if (event.driveId) return isDriveOwnerOrAdmin(userId, event.driveId);
  return false;
}

/**
 * GET /api/calendar/events/[eventId]
 *
 * Get a single calendar event by ID
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ eventId: string }> }
) {
  const { eventId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;

  try {
    const event = await db.query.calendarEvents.findFirst({
      where: and(
        eq(calendarEvents.id, eventId),
        eq(calendarEvents.isTrashed, false)
      ),
      with: {
        createdBy: {
          columns: { id: true, name: true, image: true },
        },
        attendees: {
          with: {
            user: {
              columns: { id: true, name: true, image: true },
            },
          },
        },
        page: {
          columns: { id: true, title: true, type: true },
        },
        drive: {
          columns: { id: true, name: true, slug: true },
        },
      },
    });

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Check MCP drive scope if event is drive-associated
    if (event.driveId) {
      const scopeError = checkMCPDriveScope(auth, event.driveId);
      if (scopeError) return scopeError;
    }

    // Check access
    const hasAccess = await canAccessEvent(userId, event);
    if (!hasAccess) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    return NextResponse.json(event);
  } catch (error) {
    loggers.api.error('Error fetching calendar event:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch calendar event' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/calendar/events/[eventId]
 *
 * Update a calendar event
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ eventId: string }> }
) {
  const { eventId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;

  try {
    // Get existing event
    const event = await db.query.calendarEvents.findFirst({
      where: and(
        eq(calendarEvents.id, eventId),
        eq(calendarEvents.isTrashed, false)
      ),
    });

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Check MCP drive scope if event is drive-associated
    if (event.driveId) {
      const scopeError = checkMCPDriveScope(auth, event.driveId);
      if (scopeError) return scopeError;
    }

    // Check edit permission
    const canEdit = await canEditEvent(userId, event);
    if (!canEdit) {
      return NextResponse.json(
        { error: 'You do not have permission to edit this event' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const parseResult = updateEventSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parseResult.error.issues },
        { status: 400 }
      );
    }

    const data = parseResult.data;

    // Apply timezone-aware parsing for naive ISO datetimes.
    // Use the provided timezone, or fall back to the existing event's timezone.
    const effectiveTimezone = data.timezone ?? event.timezone ?? 'UTC';
    const adjustedStartAt = (data.startAt && typeof body.startAt === 'string' && isNaiveISODatetime(body.startAt))
      ? parseNaiveDatetimeInTimezone(body.startAt, effectiveTimezone)
      : data.startAt;
    const adjustedEndAt = (data.endAt && typeof body.endAt === 'string' && isNaiveISODatetime(body.endAt))
      ? parseNaiveDatetimeInTimezone(body.endAt, effectiveTimezone)
      : data.endAt;

    // Validate dates if both are provided
    const newStartAt = adjustedStartAt ?? event.startAt;
    const newEndAt = adjustedEndAt ?? event.endAt;
    if (newEndAt <= newStartAt) {
      return NextResponse.json(
        { error: 'End date must be after start date' },
        { status: 400 }
      );
    }

    // Reject agent-trigger upserts on personal events; triggers require a
    // drive context so the executor can resolve agent / instruction / context
    // pages against a known drive.
    if (data.agentTrigger && !event.driveId) {
      return NextResponse.json(
        { error: 'Agent triggers require a drive event' },
        { status: 400 }
      );
    }

    // Reject agent-trigger upserts on recurring events. The cron poller
    // fires one-shot occurrences, so attaching one trigger to a recurring
    // event would silently misfire on every occurrence past the first.
    // Mirrors the POST /events and PUT /triggers guards.
    const willBeRecurring = data.recurrenceRule !== undefined ? data.recurrenceRule !== null : event.recurrenceRule !== null;
    if (data.agentTrigger && willBeRecurring) {
      return NextResponse.json(
        { error: 'Agent triggers are not supported for recurring events' },
        { status: 400 }
      );
    }

    // Pre-validate agent trigger before opening the event update tx so a bad
    // payload (off-drive agent / context page, missing prompt-or-instruction)
    // returns 400 without dirtying event state.
    if (data.agentTrigger && event.driveId) {
      try {
        await validateCalendarAgentTrigger(db, {
          driveId: event.driveId,
          agentTrigger: data.agentTrigger,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid agent trigger';
        return NextResponse.json({ error: message }, { status: 400 });
      }
    }

    // Update the event, sync pending trigger time, AND apply agentTrigger
    // changes atomically. The trigger ops live inside the same tx so a
    // failure halfway through (e.g. workflow row blocked by another writer,
    // FK constraint surprise) rolls back the event update too — a partial
    // write where the title moved but the trigger didn't would be confusing
    // for the user and hard to retry safely.
    const [updatedEvent] = await db.transaction(async (tx) => {
      const result = await tx
        .update(calendarEvents)
        .set({
          title: data.title,
          description: data.description,
          location: data.location,
          startAt: adjustedStartAt,
          endAt: adjustedEndAt,
          allDay: data.allDay,
          timezone: data.timezone,
          recurrenceRule: data.recurrenceRule,
          visibility: data.visibility,
          color: data.color,
          pageId: data.pageId,
          updatedAt: new Date(),
        })
        .where(eq(calendarEvents.id, eventId))
        .returning();

      if (adjustedStartAt && data.agentTrigger === undefined) {
        // Caller didn't touch the trigger payload — keep the existing
        // re-aim semantics: only triggers that haven't been processed yet
        // get their triggerAt bumped. If the caller IS upserting the
        // trigger this tick, the upsert below will set triggerAt itself
        // and there's no point doing the re-aim sweep.
        await tx
          .update(calendarTriggers)
          .set({ triggerAt: adjustedStartAt })
          .where(and(
            eq(calendarTriggers.calendarEventId, eventId),
            sql`NOT EXISTS (
              SELECT 1 FROM ${workflowRuns}
              WHERE ${workflowRuns.sourceTable} = 'calendarTriggers'
                AND ${workflowRuns.sourceId} = ${calendarTriggers.id}
            )`,
          ));
      }

      // Apply agentTrigger changes inside the same tx so partial writes
      // can't leave the event mutated but the trigger out of sync.
      if (data.agentTrigger === null) {
        await removeCalendarTrigger(tx, eventId);
      } else if (data.agentTrigger && event.driveId) {
        await upsertCalendarTriggerWorkflowInTx(tx, {
          driveId: event.driveId,
          scheduledById: userId,
          calendarEventId: eventId,
          triggerAt: newStartAt,
          timezone: data.timezone ?? event.timezone ?? 'UTC',
          agentTrigger: data.agentTrigger,
        });
      }

      return result;
    });

    // Fetch complete event with relations
    const completeEvent = await db.query.calendarEvents.findFirst({
      where: eq(calendarEvents.id, eventId),
      with: {
        createdBy: {
          columns: { id: true, name: true, image: true },
        },
        attendees: {
          with: {
            user: {
              columns: { id: true, name: true, image: true },
            },
          },
        },
        page: {
          columns: { id: true, title: true, type: true },
        },
      },
    });

    // Get all attendee IDs for broadcasting
    const attendees = await db
      .select({ userId: eventAttendees.userId })
      .from(eventAttendees)
      .where(eq(eventAttendees.eventId, eventId));

    // Broadcast event update
    await broadcastCalendarEvent({
      eventId,
      driveId: updatedEvent.driveId,
      operation: 'updated',
      userId,
      attendeeIds: attendees.map(a => a.userId),
    });

    // Push update to Google Calendar (fire-and-forget)
    after(() => {
      pushEventUpdateToGoogle(userId, eventId).catch(err =>
        loggers.api.warn('Push update to Google failed', { eventId, error: err?.message })
      );
    });

    return NextResponse.json(completeEvent);
  } catch (error) {
    loggers.api.error('Error updating calendar event:', error as Error);
    return NextResponse.json(
      { error: 'Failed to update calendar event' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/calendar/events/[eventId]
 *
 * Soft delete a calendar event (move to trash)
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ eventId: string }> }
) {
  const { eventId } = await context.params;
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;

  try {
    // Get existing event
    const event = await db.query.calendarEvents.findFirst({
      where: and(
        eq(calendarEvents.id, eventId),
        eq(calendarEvents.isTrashed, false)
      ),
    });

    if (!event) {
      return NextResponse.json({ error: 'Event not found' }, { status: 404 });
    }

    // Check MCP drive scope if event is drive-associated
    if (event.driveId) {
      const scopeError = checkMCPDriveScope(auth, event.driveId);
      if (scopeError) return scopeError;
    }

    // Check edit permission
    const canEdit = await canEditEvent(userId, event);
    if (!canEdit) {
      return NextResponse.json(
        { error: 'You do not have permission to delete this event' },
        { status: 403 }
      );
    }

    // Get all attendee IDs before deletion for broadcasting
    const attendees = await db
      .select({ userId: eventAttendees.userId })
      .from(eventAttendees)
      .where(eq(eventAttendees.eventId, eventId));

    // Delete from Google Calendar before soft-deleting locally (fire-and-forget)
    after(() => {
      pushEventDeleteToGoogle(userId, eventId).catch(err =>
        loggers.api.warn('Push delete to Google failed', { eventId, error: err?.message })
      );
    });

    // Soft delete the event
    await db
      .update(calendarEvents)
      .set({
        isTrashed: true,
        trashedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(calendarEvents.id, eventId));

    // Broadcast event deletion
    await broadcastCalendarEvent({
      eventId,
      driveId: event.driveId,
      operation: 'deleted',
      userId,
      attendeeIds: attendees.map(a => a.userId),
    });

    auditRequest(request, { eventType: 'data.delete', userId: auth.userId, resourceType: 'event', resourceId: eventId });

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error deleting calendar event:', error as Error);
    return NextResponse.json(
      { error: 'Failed to delete calendar event' },
      { status: 500 }
    );
  }
}
