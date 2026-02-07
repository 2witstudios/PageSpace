import {
  db,
  calendarEvents,
  eventAttendees,
  eq,
  and,
  or,
  gte,
  lt,
  inArray,
  isNull,
} from '@pagespace/db';

export interface PulseCalendarEvent {
  title: string;
  location: string | null;
  startAt: Date;
  endAt: Date;
  allDay: boolean;
}

export async function fetchCalendarContext(params: {
  userId: string;
  driveIds: string[];
  now: Date;
  endOfToday: Date;
  endOfTomorrow: Date;
}): Promise<{
  happeningNow: PulseCalendarEvent[];
  upcomingToday: PulseCalendarEvent[];
  tomorrow: PulseCalendarEvent[];
  pendingInvites: Array<{ eventTitle: string; startAt: Date; allDay: boolean }>;
  allEvents: PulseCalendarEvent[];
}> {
  const { userId, driveIds, now, endOfToday, endOfTomorrow } = params;

  // Visibility filter: personal events + drive events respecting visibility setting
  // PRIVATE and ATTENDEES_ONLY events from other users in shared drives are excluded
  // ATTENDEES_ONLY events are surfaced through the attendeeEventRows query instead
  const calendarVisibility = driveIds.length > 0
    ? or(
        and(isNull(calendarEvents.driveId), eq(calendarEvents.createdById, userId)),
        and(
          inArray(calendarEvents.driveId, driveIds),
          or(
            eq(calendarEvents.visibility, 'DRIVE'),
            eq(calendarEvents.createdById, userId)
          )
        )
      )
    : and(isNull(calendarEvents.driveId), eq(calendarEvents.createdById, userId));

  const upcomingCalendarEvents = await db
    .select({
      id: calendarEvents.id,
      title: calendarEvents.title,
      location: calendarEvents.location,
      startAt: calendarEvents.startAt,
      endAt: calendarEvents.endAt,
      allDay: calendarEvents.allDay,
      driveId: calendarEvents.driveId,
    })
    .from(calendarEvents)
    .where(
      and(
        eq(calendarEvents.isTrashed, false),
        gte(calendarEvents.endAt, now),
        lt(calendarEvents.startAt, endOfTomorrow),
        calendarVisibility
      )
    )
    .orderBy(calendarEvents.startAt)
    .limit(15);

  // Get events user is invited to via attendees table
  const attendeeEventRows = await db
    .select({
      id: calendarEvents.id,
      title: calendarEvents.title,
      location: calendarEvents.location,
      startAt: calendarEvents.startAt,
      endAt: calendarEvents.endAt,
      allDay: calendarEvents.allDay,
      driveId: calendarEvents.driveId,
      rsvpStatus: eventAttendees.status,
    })
    .from(eventAttendees)
    .innerJoin(calendarEvents, eq(calendarEvents.id, eventAttendees.eventId))
    .where(
      and(
        eq(eventAttendees.userId, userId),
        eq(calendarEvents.isTrashed, false),
        gte(calendarEvents.endAt, now),
        lt(calendarEvents.startAt, endOfTomorrow),
      )
    )
    .orderBy(calendarEvents.startAt)
    .limit(15);

  // Pending RSVP invites (future events user hasn't responded to)
  const pendingRsvps = await db
    .select({
      eventTitle: calendarEvents.title,
      startAt: calendarEvents.startAt,
      allDay: calendarEvents.allDay,
    })
    .from(eventAttendees)
    .innerJoin(calendarEvents, eq(calendarEvents.id, eventAttendees.eventId))
    .where(
      and(
        eq(eventAttendees.userId, userId),
        eq(eventAttendees.status, 'PENDING'),
        eq(calendarEvents.isTrashed, false),
        gte(calendarEvents.startAt, now),
      )
    )
    .orderBy(calendarEvents.startAt)
    .limit(5);

  // Merge and deduplicate events
  const seenEventIds = new Set<string>();
  const allCalendarEvents: PulseCalendarEvent[] = [];

  for (const event of [...upcomingCalendarEvents, ...attendeeEventRows]) {
    if (seenEventIds.has(event.id)) continue;
    seenEventIds.add(event.id);
    allCalendarEvents.push({
      title: event.title,
      location: event.location,
      startAt: event.startAt,
      endAt: event.endAt,
      allDay: event.allDay,
    });
  }

  allCalendarEvents.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());

  // Categorize events
  const happeningNow = allCalendarEvents.filter(e => e.startAt <= now && e.endAt > now);
  const upcomingToday = allCalendarEvents.filter(e => e.startAt > now && e.startAt < endOfToday);
  const tomorrow = allCalendarEvents.filter(e => e.startAt >= endOfToday && e.startAt < endOfTomorrow);

  return {
    happeningNow,
    upcomingToday,
    tomorrow,
    pendingInvites: pendingRsvps,
    allEvents: allCalendarEvents,
  };
}
