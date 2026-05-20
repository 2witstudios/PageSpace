import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@pagespace/db/db';
import { eq, and, desc } from '@pagespace/db/operators';
import { calendarEvents, eventAttendees } from '@pagespace/db/schema/calendar';
import { calendarTriggers } from '@pagespace/db/schema/calendar-triggers';
import { workflows } from '@pagespace/db/schema/workflows';
import { workflowRuns } from '@pagespace/db/schema/workflow-runs';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import {
  removeCalendarTrigger,
  upsertCalendarTriggerWorkflow,
} from '@/lib/workflows/calendar-trigger-helpers';
import { broadcastCalendarEvent } from '@/lib/websocket/calendar-events';

const SESSION_READ = { allow: ['session'] as const, requireCSRF: false };
const SESSION_WRITE = { allow: ['session'] as const, requireCSRF: true };

// Same auth shape as PATCH /api/calendar/events/[eventId]: creator OR drive
// owner/admin. Personal events (no driveId) are creator-only by construction.
async function canManageEventTrigger(
  userId: string,
  event: typeof calendarEvents.$inferSelect,
): Promise<boolean> {
  if (event.createdById === userId) return true;
  if (event.driveId) return isDriveOwnerOrAdmin(userId, event.driveId);
  return false;
}

const upsertTriggerSchema = z.object({
  agentPageId: z.string().min(1),
  prompt: z.string().trim().max(10000).optional(),
  instructionPageId: z.string().nullable().optional(),
  contextPageIds: z.array(z.string()).max(10).optional(),
}).strict().refine(
  (d) => Boolean(d.prompt) || Boolean(d.instructionPageId),
  { message: 'Either prompt or instructionPageId is required' },
);

async function loadEvent(eventId: string) {
  return db.query.calendarEvents.findFirst({
    where: and(eq(calendarEvents.id, eventId), eq(calendarEvents.isTrashed, false)),
  });
}

// Fetch the event's attendee list so the broadcast hits each attendee's user
// channel — not just the drive room — since personal-calendar clients only
// join their own user channel.
async function loadAttendeeIds(eventId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: eventAttendees.userId })
    .from(eventAttendees)
    .where(eq(eventAttendees.eventId, eventId));
  return rows.map((r) => r.userId);
}

// GET /api/calendar/events/[eventId]/triggers
//
// Returns the trigger config for the event (or null) plus the most recent
// workflow_runs row so the UI can render a last-run badge in the same shape
// the task-trigger UI uses.
export async function GET(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const auth = await authenticateRequestWithOptions(request, SESSION_READ);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const { eventId } = await context.params;

  const event = await loadEvent(eventId);
  if (!event) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 });
  }

  if (event.driveId) {
    const scopeError = checkMCPDriveScope(auth, event.driveId);
    if (scopeError) return scopeError;
  }

  const canManage = await canManageEventTrigger(userId, event);
  if (!canManage) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const [row] = await db
    .select({
      id: calendarTriggers.id,
      calendarEventId: calendarTriggers.calendarEventId,
      triggerAt: calendarTriggers.triggerAt,
      workflowId: workflows.id,
      agentPageId: workflows.agentPageId,
      prompt: workflows.prompt,
      instructionPageId: workflows.instructionPageId,
      contextPageIds: workflows.contextPageIds,
    })
    .from(calendarTriggers)
    .innerJoin(workflows, eq(calendarTriggers.workflowId, workflows.id))
    .where(eq(calendarTriggers.calendarEventId, eventId));

  if (!row) {
    return NextResponse.json({ trigger: null });
  }

  // Latest run row gives us the equivalent of taskTriggers.lastFiredAt /
  // lastFireError for the UI's "Last run" line.
  const [latestRun] = await db
    .select({
      status: workflowRuns.status,
      startedAt: workflowRuns.startedAt,
      endedAt: workflowRuns.endedAt,
      error: workflowRuns.error,
    })
    .from(workflowRuns)
    .where(and(
      eq(workflowRuns.sourceTable, 'calendarTriggers'),
      eq(workflowRuns.sourceId, row.id),
    ))
    .orderBy(desc(workflowRuns.startedAt))
    .limit(1);

  return NextResponse.json({
    trigger: {
      ...row,
      lastFiredAt: latestRun?.endedAt ?? null,
      lastFireError: latestRun?.error ?? null,
      lastRunStatus: latestRun?.status ?? null,
    },
  });
}

// PUT /api/calendar/events/[eventId]/triggers
//
// Upsert a single agent trigger for the event. Calendar events have one
// trigger type ("at start"), so this endpoint takes no triggerType param.
export async function PUT(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const auth = await authenticateRequestWithOptions(request, SESSION_WRITE);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const { eventId } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = upsertTriggerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const event = await loadEvent(eventId);
  if (!event) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 });
  }

  if (event.driveId) {
    const scopeError = checkMCPDriveScope(auth, event.driveId);
    if (scopeError) return scopeError;
  }

  if (!event.driveId) {
    return NextResponse.json(
      { error: 'Agent triggers require a drive event' },
      { status: 400 }
    );
  }

  const canManage = await canManageEventTrigger(userId, event);
  if (!canManage) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    await upsertCalendarTriggerWorkflow(db, {
      driveId: event.driveId,
      scheduledById: userId,
      calendarEventId: eventId,
      triggerAt: event.startAt,
      timezone: event.timezone ?? 'UTC',
      agentTrigger: parsed.data,
      recurrenceRule: event.recurrenceRule,
      recurrenceExceptions: event.recurrenceExceptions ?? [],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to save trigger';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  auditRequest(request, {
    eventType: 'data.write',
    userId,
    resourceType: 'calendar_triggers',
    resourceId: eventId,
  });

  const attendeeIds = await loadAttendeeIds(eventId);
  void broadcastCalendarEvent({
    eventId,
    driveId: event.driveId,
    operation: 'updated',
    userId,
    attendeeIds,
  });

  return NextResponse.json({ success: true });
}

// DELETE /api/calendar/events/[eventId]/triggers
//
// Remove the agent trigger from the event. Drops the workflows row; FK
// cascade wipes the calendar_triggers row. Idempotent — returns 200 even
// when no trigger exists.
export async function DELETE(request: Request, context: { params: Promise<{ eventId: string }> }) {
  const auth = await authenticateRequestWithOptions(request, SESSION_WRITE);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const { eventId } = await context.params;

  const event = await loadEvent(eventId);
  if (!event) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 });
  }

  if (event.driveId) {
    const scopeError = checkMCPDriveScope(auth, event.driveId);
    if (scopeError) return scopeError;
  }

  const canManage = await canManageEventTrigger(userId, event);
  if (!canManage) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await removeCalendarTrigger(db, eventId);

  auditRequest(request, {
    eventType: 'data.delete',
    userId,
    resourceType: 'calendar_triggers',
    resourceId: eventId,
  });

  const attendeeIds = await loadAttendeeIds(eventId);
  void broadcastCalendarEvent({
    eventId,
    driveId: event.driveId,
    operation: 'updated',
    userId,
    attendeeIds,
  });

  return NextResponse.json({ success: true });
}
