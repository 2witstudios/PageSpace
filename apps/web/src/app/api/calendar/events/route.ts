import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  db,
  calendarEvents,
  eventAttendees,
  eq,
  and,
  or,
  gte,
  lte,
  inArray,
  isNull,
  desc,
} from '@pagespace/db';
import { loggers, getDriveMemberUserIds } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { isUserDriveMember, getDriveIdsForUser } from '@pagespace/lib';
import { broadcastCalendarEvent } from '@/lib/websocket/calendar-events';
import { pushEventToGoogle } from '@/lib/integrations/google-calendar/push-service';

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
});

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
        orderBy: [desc(calendarEvents.startAt)],
      });

      return NextResponse.json({ events });
    }

    // User context: aggregate events from all sources
    const driveIds = await getDriveIdsForUser(userId);

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
      orderBy: [desc(calendarEvents.startAt)],
    });

    return NextResponse.json({ events });
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
    if (data.endAt <= data.startAt) {
      return NextResponse.json(
        { error: 'End date must be after start date' },
        { status: 400 }
      );
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

    // Create the event
    const [event] = await db
      .insert(calendarEvents)
      .values({
        driveId: data.driveId ?? null,
        createdById: userId,
        pageId: data.pageId ?? null,
        title: data.title,
        description: data.description ?? null,
        location: data.location ?? null,
        startAt: data.startAt,
        endAt: data.endAt,
        allDay: data.allDay,
        timezone: data.timezone,
        recurrenceRule: data.recurrenceRule ?? null,
        visibility: data.visibility,
        color: data.color,
        updatedAt: new Date(),
      })
      .returning();

    // Add creator as organizer attendee
    await db.insert(eventAttendees).values({
      eventId: event.id,
      userId: userId,
      status: 'ACCEPTED',
      isOrganizer: true,
      respondedAt: new Date(),
    });

    // Add other attendees if provided
    if (data.attendeeIds && data.attendeeIds.length > 0) {
      const otherAttendees = data.attendeeIds.filter(id => id !== userId);
      if (otherAttendees.length > 0) {
        await db.insert(eventAttendees).values(
          otherAttendees.map(attendeeId => ({
            eventId: event.id,
            userId: attendeeId,
            status: 'PENDING' as const,
            isOrganizer: false,
          }))
        );
      }
    }

    // Fetch the complete event with relations
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

    // Push to Google Calendar (fire-and-forget, don't block response)
    pushEventToGoogle(userId, event.id).catch((err) => {
      loggers.api.error('Background push to Google failed:', err as Error);
    });

    return NextResponse.json(completeEvent, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating calendar event:', error as Error);
    return NextResponse.json(
      { error: 'Failed to create calendar event' },
      { status: 500 }
    );
  }
}
