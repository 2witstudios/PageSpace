import { db } from '@pagespace/db/db'
import { eq, and, or, gte, lt, inArray, isNull } from '@pagespace/db/operators'
import { calendarEvents, eventAttendees } from '@pagespace/db/schema/calendar';
import { filterDrivesForActor } from '@pagespace/lib/permissions/actor-authentication';
import type { AccessActor } from '@pagespace/lib/permissions/access-actor';
import { scopeReadableByModel } from '@/lib/ai/core/org-model-policy';
import { getDerivedPageOrgIds } from '@pagespace/lib/organizations/policy-reader';
import { orgIdsOfSources } from '@pagespace/lib/permissions/org-derived-content';

export interface PulseCalendarEvent {
  title: string;
  location: string | null;
  startAt: Date;
  endAt: Date;
  allDay: boolean;
}

export async function fetchCalendarContext(params: {
  actor: AccessActor;
  model: Parameters<typeof scopeReadableByModel>[0];
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
  /**
   * The drives of every event read here (drive events, events the person only attends, pending RSVPs), sorted and
   * distinct: sources of the summary, whose orgs it records (D-OW-62). Personal events have none.
   */
  sourceDriveIds: string[];
}> {
  const { actor, model, driveIds, now, endOfToday, endOfTomorrow } = params;
  const { userId } = actor;

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

  const upcomingCandidates = await db
    .select({ id: calendarEvents.id, driveId: calendarEvents.driveId })
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
  const attendeeCandidates = await db
    .select({ id: calendarEvents.id, driveId: calendarEvents.driveId })
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
  const pendingCandidates = await db
    .select({ id: calendarEvents.id, driveId: calendarEvents.driveId })
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

  const candidateDriveIds = [...new Set([...upcomingCandidates, ...attendeeCandidates, ...pendingCandidates]
    .flatMap((event) => event.driveId ? [event.driveId] : []))];
  const actorDriveIds = await filterDrivesForActor(actor, candidateDriveIds);
  const { driveIds: modelDriveIds } = await scopeReadableByModel(model, { driveIds: [...actorDriveIds] });
  const admittedDrives = new Set(modelDriveIds);
  const admitted = (event: { driveId: string | null }) => event.driveId === null
    ? actor.via === 'credential' || actor.scope.kind === 'held-drives'
    : admittedDrives.has(event.driveId);
  const eventIds = [...new Set([...upcomingCandidates, ...attendeeCandidates].filter(admitted).map((event) => event.id))];
  const pendingIds = pendingCandidates.filter(admitted).map((event) => event.id);
  // Read content only after both the asking actor and model admit its governing source.
  const upcomingCalendarEvents = eventIds.length > 0 ? await db.select({
    id: calendarEvents.id, title: calendarEvents.title, location: calendarEvents.location,
    startAt: calendarEvents.startAt, endAt: calendarEvents.endAt, allDay: calendarEvents.allDay,
    driveId: calendarEvents.driveId,
  }).from(calendarEvents).where(inArray(calendarEvents.id, eventIds)) : [];
  const pendingRsvps = pendingIds.length > 0 ? await db.select({
    eventTitle: calendarEvents.title, startAt: calendarEvents.startAt, allDay: calendarEvents.allDay,
    driveId: calendarEvents.driveId,
  }).from(calendarEvents).where(inArray(calendarEvents.id, pendingIds)).orderBy(calendarEvents.startAt) : [];

  // Merge and deduplicate events
  const seenEventIds = new Set<string>();
  const allCalendarEvents: PulseCalendarEvent[] = [];

  for (const event of upcomingCalendarEvents) {
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

  const sourceDriveIds = [...new Set(
    [...upcomingCalendarEvents, ...pendingRsvps].flatMap((event) => (event.driveId ? [event.driveId] : [])),
  )].sort();

  return {
    happeningNow,
    upcomingToday,
    tomorrow,
    pendingInvites: pendingRsvps.map(({ eventTitle, startAt, allDay }) => ({ eventTitle, startAt, allDay })),
    allEvents: allCalendarEvents,
    sourceDriveIds,
  };
}

/**
 * SEC-2/3 (D-OW-62): every org whose content can feed a Pulse summary — the drives and pages it reads, and the drives
 * of the calendar events it read (an event the person only attends included) — sorted. Readers must satisfy all.
 */
export async function pulseSourceOrgIds(sources: {
  driveIds: readonly string[];
  pageIds: readonly string[];
  calendar: { sourceDriveIds: readonly string[] };
}): Promise<string[]> {
  const [direct, derived] = await Promise.all([
    orgIdsOfSources({ driveIds: [...sources.driveIds, ...sources.calendar.sourceDriveIds], pageIds: sources.pageIds }),
    getDerivedPageOrgIds(sources.pageIds),
  ]);
  return [...new Set([...direct, ...[...derived.values()].flat()])].sort();
}
