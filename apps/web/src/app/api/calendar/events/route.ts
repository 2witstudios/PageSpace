import { NextResponse, after } from 'next/server';
import { z } from 'zod';
import { db } from '@pagespace/db/db'
import { eq, and, or, gte, lte, inArray, not, isNull, asc } from '@pagespace/db/operators'
import { calendarEvents, eventAttendees } from '@pagespace/db/schema/calendar'
import { calendarTriggers } from '@pagespace/db/schema/calendar-triggers'
import { pages } from '@pagespace/db/schema/core'
import { workflows } from '@pagespace/db/schema/workflows';
import { createCalendarTriggerWorkflow } from '@/lib/workflows/calendar-trigger-helpers';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getDriveMemberUserIds } from '@pagespace/lib/services/drive-member-service';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { authenticateRequestWithOptions, isAuthError, checkMCPDriveScope, checkMCPCreateScope, filterDrivesByMCPScope } from '@/lib/auth';
import { isUserDriveMember, getDriveIdsForUser, canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { broadcastCalendarEvent } from '@/lib/websocket/calendar-events';
import { pushEventToGoogle } from '@/lib/integrations/google-calendar/push-service';
import { isNaiveISODatetime, parseNaiveDatetimeInTimezone } from '@/lib/ai/core/timestamp-utils';
import { CronExpressionParser } from 'cron-parser';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

// Query parameters for listing events
const listQuerySchema = z.object({
  context: z.enum(['user', 'drive']).default('user'),
  driveId: z.string().optional(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  includePersonal: z.coerce.boolean().default(true),
});

// Schema for creating an event
const createEventSchema = z.object({
  driveId: z.string().nullable().optional(),
  pageId: z.string().nullable().optional(),
  title: z.string().min(1).max(500),
  description: z.string().max(10000).nullable().optional(),
  location: z.string().max(1000).nullable().optional(),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  allDay: z.boolean().default(false),
  timezone: z.string().default('UTC'),
  recurrenceRule: z.object({
    frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
    interval: z.number().int().min(1).default(1),
    byDay: z.array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])).optional(),
    byMonthDay: z.array(z.number().int().min(1).max(31)).optional(),
    byMonth: z.array(z.number().int().min(1).max(12)).optional(),
    count: z.number().int().min(1).optional(),
    until: z.string().optional(),
  }).nullable().optional(),
  visibility: z.enum(['DRIVE', 'ATTENDEES_ONLY', 'PRIVATE']).default('DRIVE'),
  color: z.string().default('default'),
  attendeeIds: z.array(z.string()).optional(),
  agentTrigger: z.object({
    agentPageId: z.string(),
    prompt: z.string().trim().min(1).max(10000),
  }).optional(),
});

/**
 * Returns the set of calendarEventIds that have an active (non-cancelled, non-failed) agent trigger.
 */
async function getTriggeredEventIds(eventIds: string[]): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set();
  const rows = await db
    .select({ calendarEventId: calendarTriggers.calendarEventId })
    .from(calendarTriggers)
    .where(
      and(
        inArray(calendarTriggers.calendarEventId, eventIds),
        not(inArray(calendarTriggers.status, ['cancelled', 'failed'])),
      )
    );
  return new Set(rows.map(r => r.calendarEventId).filter((id): id is string => id !== null));
}

/**
 * Expand workflow schedules into virtual calendar events within a date range.
 * - Cron workflows: expand cron expression into future occurrences
 * - Event-triggered workflows: show actual past runs (lastRunAt) within the range
 */
async function getWorkflowVirtualEvents(driveIds: string[], startDate: Date, endDate: Date) {
  if (driveIds.length === 0) return [];

  const enabledWorkflows = await db
    .select({
      id: workflows.id,
      name: workflows.name,
      cronExpression: workflows.cronExpression,
      timezone: workflows.timezone,
      driveId: workflows.driveId,
      triggerType: workflows.triggerType,
      lastRunAt: workflows.lastRunAt,
      lastRunStatus: workflows.lastRunStatus,
    })
    .from(workflows)
    .where(
      and(
        inArray(workflows.driveId, driveIds),
        eq(workflows.isEnabled, true)
      )
    );

  const virtualEvents: Array<{
    id: string;
    title: string;
    startAt: Date;
    endAt: Date;
    allDay: boolean;
    source: 'workflow';
    workflowId: string;
    driveId: string;
    color: string;
    triggerType?: string;
  }> = [];

  for (const wf of enabledWorkflows) {
    if (wf.triggerType === 'event') {
      // Event-triggered workflows: show past runs as point-in-time events
      if (wf.lastRunAt && wf.lastRunAt >= startDate && wf.lastRunAt <= endDate) {
        virtualEvents.push({
          id: `workflow-event-${wf.id}-${wf.lastRunAt.getTime()}`,
          title: `Workflow: ${wf.name}`,
          startAt: wf.lastRunAt,
          endAt: new Date(wf.lastRunAt.getTime() + 5 * 60 * 1000),
          allDay: false,
          source: 'workflow',
          workflowId: wf.id,
          driveId: wf.driveId,
          color: 'amber',
          triggerType: 'event',
        });
      }
    } else {
      // Cron workflows: expand cron schedule into future occurrences
      if (!wf.cronExpression) continue;
      try {
        // cron-parser next() is exclusive of currentDate, so back up 1ms
        // to include occurrences exactly at the range start
        const interval = CronExpressionParser.parse(wf.cronExpression, {
          tz: wf.timezone,
          currentDate: new Date(startDate.getTime() - 1),
          endDate: endDate,
        });

        let count = 0;
        while (interval.hasNext() && count < 100) {
          const next = interval.next().toDate();
          if (next > endDate) break;
          virtualEvents.push({
            id: `workflow-${wf.id}-${next.getTime()}`,
            title: `Workflow: ${wf.name}`,
            startAt: next,
            endAt: new Date(next.getTime() + 5 * 60 * 1000),
            allDay: false,
            source: 'workflow',
            workflowId: wf.id,
            driveId: wf.driveId,
            color: 'purple',
            triggerType: 'cron',
          });
          count++;
        }
      } catch (err) {
        loggers.api.warn(`Failed to parse cron for workflow ${wf.id}:`, { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return virtualEvents;
}

/**
 * GET /api/calendar/events
 *
 * Fetch calendar events based on context:
 * - user: All events the user can see (personal + attending + drive events)
 * - drive: Events in a specific drive
 */
export async function GET(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;
  const { searchParams } = new URL(request.url);

  try {
    const parseResult = listQuerySchema.safeParse({
      context: searchParams.get('context') ?? 'user',
      driveId: searchParams.get('driveId') ?? undefined,
      startDate: searchParams.get('startDate'),
      endDate: searchParams.get('endDate'),
      includePersonal: searchParams.get('includePersonal') ?? 'true',
    });

    if (!parseResult.success) {
      return NextResponse.json(
        { error: parseResult.error.issues.map(i => i.message).join('. ') },
        { status: 400 }
      );
    }

    const params = parseResult.data;

    if (params.context === 'drive') {
      if (!params.driveId) {
        return NextResponse.json(
          { error: 'driveId is required for drive context' },
          { status: 400 }
        );
      }

      // Check MCP drive scope
      const scopeError = checkMCPDriveScope(auth, params.driveId);
      if (scopeError) return scopeError;

      const canView = await isUserDriveMember(userId, params.driveId);
      if (!canView) {
        return NextResponse.json(
          { error: 'Unauthorized - you do not have access to this drive' },
          { status: 403 }
        );
      }

      // Get event IDs where user is an attendee (for ATTENDEES_ONLY events)
      const attendeeEventsInDrive = await db
        .select({ eventId: eventAttendees.eventId })
        .from(eventAttendees)
        .innerJoin(calendarEvents, eq(calendarEvents.id, eventAttendees.eventId))
        .where(
          and(
            eq(eventAttendees.userId, userId),
            eq(calendarEvents.driveId, params.driveId)
          )
        );
      const attendeeEventIdsInDrive = attendeeEventsInDrive.map(e => e.eventId);

      // Fetch drive events within date range, respecting visibility:
      // - DRIVE: visible to all drive members
      // - ATTENDEES_ONLY: only visible to creator or attendees
      // - PRIVATE: only visible to creator
      const events = await db.query.calendarEvents.findMany({
        where: and(
          eq(calendarEvents.driveId, params.driveId),
          eq(calendarEvents.isTrashed, false),
          lte(calendarEvents.startAt, params.endDate),
          gte(calendarEvents.endAt, params.startDate),
          or(
            // DRIVE visibility - visible to all drive members
            eq(calendarEvents.visibility, 'DRIVE'),
            // PRIVATE - only creator can see
            and(
              eq(calendarEvents.visibility, 'PRIVATE'),
              eq(calendarEvents.createdById, userId)
            ),
            // ATTENDEES_ONLY - creator or attendee can see
            and(
              eq(calendarEvents.visibility, 'ATTENDEES_ONLY'),
              or(
                eq(calendarEvents.createdById, userId),
                attendeeEventIdsInDrive.length > 0
                  ? inArray(calendarEvents.id, attendeeEventIdsInDrive)
                  : eq(calendarEvents.id, '__never_match__') // No attendee events
              )
            )
          )
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
        },
        orderBy: [asc(calendarEvents.startAt)],
      });

      // Annotate events with agent trigger presence
      const triggeredIds = await getTriggeredEventIds(events.map(e => e.id));
      const annotatedEvents = events.map(e => ({ ...e, hasAgentTrigger: triggeredIds.has(e.id) }));

      // Append workflow virtual events
      const workflowEvents = await getWorkflowVirtualEvents([params.driveId], params.startDate, params.endDate);

      return NextResponse.json({ events: annotatedEvents, workflowEvents });
    }

    // User context: aggregate events from all sources
    const allDriveIds = await getDriveIdsForUser(userId);
    // Filter drives by MCP token scope
    const driveIds = filterDrivesByMCPScope(auth, allDriveIds);

    // Build conditions for user's visible events:
    // 1. Personal events (driveId is null, created by user)
    // 2. Events in accessible drives (with DRIVE visibility)
    // 3. Events where user is an attendee
    const conditions = [];

    // Personal events
    if (params.includePersonal) {
      conditions.push(
        and(
          isNull(calendarEvents.driveId),
          eq(calendarEvents.createdById, userId)
        )
      );
    }

    // Drive events
    if (driveIds.length > 0) {
      conditions.push(
        and(
          inArray(calendarEvents.driveId, driveIds),
          eq(calendarEvents.visibility, 'DRIVE')
        )
      );
    }

    // Get event IDs where user is an attendee
    const attendeeEvents = await db
      .select({ eventId: eventAttendees.eventId })
      .from(eventAttendees)
      .where(eq(eventAttendees.userId, userId));

    const attendeeEventIds = attendeeEvents.map(e => e.eventId);
    if (attendeeEventIds.length > 0) {
      conditions.push(inArray(calendarEvents.id, attendeeEventIds));
    }

    if (conditions.length === 0) {
      return NextResponse.json({ events: [] });
    }

    const events = await db.query.calendarEvents.findMany({
      where: and(
        or(...conditions),
        eq(calendarEvents.isTrashed, false),
        lte(calendarEvents.startAt, params.endDate),
        gte(calendarEvents.endAt, params.startDate)
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
      orderBy: [asc(calendarEvents.startAt)],
    });

    // Annotate events with agent trigger presence
    const triggeredIds = await getTriggeredEventIds(events.map(e => e.id));
    const annotatedEvents = events.map(e => ({ ...e, hasAgentTrigger: triggeredIds.has(e.id) }));

    // Append workflow virtual events
    const workflowEvents = await getWorkflowVirtualEvents(driveIds, params.startDate, params.endDate);

    return NextResponse.json({ events: annotatedEvents, workflowEvents });
  } catch (error) {
    loggers.api.error('Error fetching calendar events:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch calendar events' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/calendar/events
 *
 * Create a new calendar event
 */
export async function POST(request: Request) {
  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) {
    return auth.error;
  }

  const userId = auth.userId;

  try {
    const body = await request.json();
    const parseResult = createEventSchema.safeParse(body);

    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Invalid request body', details: parseResult.error.issues },
        { status: 400 }
      );
    }

    const data = parseResult.data;

    // Apply timezone-aware parsing for naive ISO datetimes.
    // When a client sends "2026-02-19T19:00:00" with timezone "America/Chicago",
    // the time should be interpreted as 7pm Central, not 7pm UTC.
    const startAt = (typeof body.startAt === 'string' && isNaiveISODatetime(body.startAt))
      ? parseNaiveDatetimeInTimezone(body.startAt, data.timezone)
      : data.startAt;
    const endAt = (typeof body.endAt === 'string' && isNaiveISODatetime(body.endAt))
      ? parseNaiveDatetimeInTimezone(body.endAt, data.timezone)
      : data.endAt;

    // Check MCP create scope (scoped tokens can only create in their allowed drives)
    const createScopeError = checkMCPCreateScope(auth, data.driveId ?? null);
    if (createScopeError) return createScopeError;

    // Validate drive access if driveId is provided
    if (data.driveId) {
      const canAccess = await isUserDriveMember(userId, data.driveId);
      if (!canAccess) {
        return NextResponse.json(
          { error: 'Unauthorized - you do not have access to this drive' },
          { status: 403 }
        );
      }
    }

    // Validate end date is after start date
    if (endAt <= startAt) {
      return NextResponse.json(
        { error: 'End date must be after start date' },
        { status: 400 }
      );
    }

    // Validate agent trigger before any DB writes
    let agentPageId: string | undefined;
    if (data.agentTrigger) {
      if (!data.driveId) {
        return NextResponse.json(
          { error: 'Agent triggers require a drive event' },
          { status: 400 }
        );
      }
      if (data.recurrenceRule) {
        return NextResponse.json(
          { error: 'Agent triggers are not supported for recurring events' },
          { status: 400 }
        );
      }
      const [agentPage] = await db
        .select({ id: pages.id })
        .from(pages)
        .where(
          and(
            eq(pages.id, data.agentTrigger.agentPageId),
            eq(pages.type, 'AI_CHAT'),
            eq(pages.isTrashed, false),
            eq(pages.driveId, data.driveId)
          )
        );
      if (!agentPage) {
        return NextResponse.json(
          { error: 'Agent not found in this drive' },
          { status: 400 }
        );
      }
      const canViewAgent = await canUserViewPage(userId, agentPage.id);
      if (!canViewAgent) {
        return NextResponse.json(
          { error: 'Agent not found in this drive' },
          { status: 400 }
        );
      }
      agentPageId = agentPage.id;
    }

    // Validate attendees constraints
    const otherAttendees = (data.attendeeIds ?? []).filter(id => id !== userId);
    if (otherAttendees.length > 0) {
      // PRIVATE events cannot have additional attendees
      if (data.visibility === 'PRIVATE') {
        return NextResponse.json(
          { error: 'Private events cannot have attendees other than the creator' },
          { status: 400 }
        );
      }

      // For drive events, verify all proposed attendees are drive members
      if (data.driveId) {
        const driveMemberIds = await getDriveMemberUserIds(data.driveId);
        const driveMemberSet = new Set(driveMemberIds);
        const nonMembers = otherAttendees.filter(id => !driveMemberSet.has(id));

        if (nonMembers.length > 0) {
          return NextResponse.json(
            { error: 'All attendees must be members of the drive', nonMemberCount: nonMembers.length },
            { status: 400 }
          );
        }
      }
    }

    // Create event, attendees, and optional agent trigger atomically
    const event = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(calendarEvents)
        .values({
          driveId: data.driveId ?? null,
          createdById: userId,
          pageId: data.pageId ?? null,
          title: data.title,
          description: data.description ?? null,
          location: data.location ?? null,
          startAt,
          endAt,
          allDay: data.allDay,
          timezone: data.timezone,
          recurrenceRule: data.recurrenceRule ?? null,
          visibility: data.visibility,
          color: data.color,
          updatedAt: new Date(),
        })
        .returning();

      await tx.insert(eventAttendees).values({
        eventId: created.id,
        userId: userId,
        status: 'ACCEPTED',
        isOrganizer: true,
        respondedAt: new Date(),
      });

      if (data.attendeeIds && data.attendeeIds.length > 0) {
        const others = data.attendeeIds.filter(id => id !== userId);
        if (others.length > 0) {
          await tx.insert(eventAttendees).values(
            others.map(attendeeId => ({
              eventId: created.id,
              userId: attendeeId,
              status: 'PENDING' as const,
              isOrganizer: false,
            }))
          );
        }
      }

      if (data.agentTrigger && agentPageId && data.driveId) {
        await createCalendarTriggerWorkflow({
          tx,
          driveId: data.driveId,
          scheduledById: userId,
          calendarEventId: created.id,
          triggerAt: startAt,
          timezone: data.timezone,
          agentTrigger: {
            agentPageId,
            prompt: data.agentTrigger.prompt,
            instructionPageId: null,
            contextPageIds: [],
          },
        });
      }

      return created;
    });

    // Fetch the complete event with relations (read after committed transaction)
    const completeEvent = await db.query.calendarEvents.findFirst({
      where: eq(calendarEvents.id, event.id),
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

    // Broadcast event creation
    await broadcastCalendarEvent({
      eventId: event.id,
      driveId: data.driveId ?? null,
      operation: 'created',
      userId,
      attendeeIds: [userId, ...(data.attendeeIds ?? [])],
    });

    // Push to Google Calendar (fire-and-forget)
    after(() => {
      pushEventToGoogle(userId, event.id).catch(err =>
        loggers.api.warn('Push to Google failed', { eventId: event.id, error: err?.message })
      );
    });

    auditRequest(request, { eventType: 'data.write', userId: auth.userId, resourceType: 'event', resourceId: event.id, details: { driveId: data.driveId } });

    return NextResponse.json(completeEvent, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating calendar event:', error as Error);
    return NextResponse.json(
      { error: 'Failed to create calendar event' },
      { status: 500 }
    );
  }
}
