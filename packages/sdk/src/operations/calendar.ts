/**
 * Calendar operations (Phase 3 task 6): 11 old MCP tools — `list_calendar_events`,
 * `get_calendar_event`, `create_calendar_event`, `update_calendar_event`,
 * `delete_calendar_event`, `check_calendar_availability`, `rsvp_calendar_event`,
 * `invite_calendar_attendees`, `remove_calendar_attendee`, `set_calendar_trigger`,
 * `delete_calendar_trigger` (old handler `calendar.js` + `trigger.js`).
 *
 * Route-verified against `apps/web/src/app/api/calendar/events/route.ts`,
 * `.../events/[eventId]/route.ts`, `.../events/[eventId]/attendees/route.ts`,
 * `.../events/[eventId]/triggers/route.ts` (docs/sdk/operations-inventory.md
 * §2.10, D4/D5/D6).
 *
 * `requiredScope` is intentionally omitted on every operation here. Unlike
 * tasks/pages (always attached to a page, always in a drive), a calendar
 * event may be personal (`driveId: null`) or drive-scoped, and which one
 * applies is runtime data the caller doesn't know until the event is
 * fetched — there is no static drive relationship to pre-flight (ADR 0002's
 * `RequiredScope` models a per-operation constant, not a per-call value).
 * A scoped MCP/OAuth token still can't touch a personal event: `canAccessEvent`/
 * `canEditEvent`/`canManageEventTrigger` (route source) all fail closed via
 * `isScopedMCPAuth` when `event.driveId` is null — that check just can't be
 * expressed as a static registry tag.
 *
 * D4: `list_calendar_events` / `check_calendar_availability` both hit
 * GET /api/calendar/events, which returns `{events, workflowEvents}` — the
 * old handler iterated the response as a bare array and threw on every
 * non-empty result. Resolution here: `listCalendarEvents`'s output schema is
 * `{events, workflowEvents}`, and `check_calendar_availability` is not a
 * registry operation at all — it's the pure `computeFreeSlots(events, range)`
 * below, run over `listCalendarEvents`'s output (testable with plain inputs,
 * no network mock needed).
 *
 * D5: `create_calendar_event`'s input field is `attendeeIds` (route truth),
 * not the old handler's `userIds` — a `userIds` field would be silently
 * stripped by the route's zod schema and invitees would never be added.
 *
 * D6: `remove_calendar_attendee`'s DELETE route reads the target user
 * exclusively from the `?userId=` query string and ignores the JSON body,
 * defaulting to the *caller* when the param is absent — the old handler sent
 * a JSON body and so silently removed the caller instead of the target. This
 * operation's `path` template embeds `:userId` after a literal `?userId=`
 * so `buildRequest`'s generic `:param` interpolation (which matches `:name`
 * tokens anywhere in the path string, not just before `/`) puts it on the
 * URL for a DELETE request — `buildRequest` only ever query-serializes GET
 * input, so this is the one way to land a field in the query string of a
 * non-GET operation without changing the shared transport code.
 *
 * Timezone contract (documented, not assumed — read `apps/web/src/lib/ai/core/
 * timestamp-utils.ts`): `startAt`/`startDate`/`endAt`/`endDate` accept a
 * strict ISO 8601 date or datetime string. A *naive* datetime (no `Z`/offset,
 * e.g. `"2026-02-19T19:00:00"`) is interpreted server-side in the request's
 * own `timezone` field (`isNaiveISODatetime` + `parseNaiveDatetimeInTimezone`)
 * — NOT UTC. A datetime carrying `Z` or an explicit offset is an absolute
 * instant and `timezone` has no effect on it. `startDate`/`endDate` on
 * `calendar.list` go through plain `z.coerce.date()` server-side (no naive
 * reinterpretation) since listing has no single owning timezone.
 */
import { z } from 'zod';
import { defineOperation } from '../registry/define.js';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/**
 * Strict ISO 8601 date/datetime refinement. Accepts date-only
 * (`"2026-02-19"`), naive datetime (`"2026-02-19T19:00:00"`, `"...T19:00"`,
 * `"...T19:00:00.123"`), and datetime with `Z` or a numeric offset
 * (`"2026-02-19T19:00:00Z"`, `"...+05:00"`). Rejects natural language,
 * slash-delimited dates, and any string `Date` cannot parse (e.g. month 13)
 * — client-side fail-fast for garbage the route's `z.coerce.date()` would
 * also reject, never narrower than what the server actually accepts.
 */
const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

const isoDatetimeSchema = z.string().refine(
  (value) => ISO_8601_PATTERN.test(value) && !Number.isNaN(new Date(value).getTime()),
  {
    message:
      'Must be a strict ISO 8601 date or datetime string (e.g. "2026-02-19", "2026-02-19T19:00:00", or "2026-02-19T19:00:00Z")',
  },
);

const eventVisibilityEnum = z.enum(['DRIVE', 'ATTENDEES_ONLY', 'PRIVATE']);
const attendeeStatusEnum = z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'TENTATIVE']);
const recurrenceFrequencyEnum = z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const weekdayEnum = z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);

/** Input shape for create/update, bounds matched to the route's own clamps. */
const recurrenceRuleInputSchema = z.object({
  frequency: recurrenceFrequencyEnum,
  interval: z.number().int().min(1).optional(),
  byDay: z.array(weekdayEnum).optional(),
  byMonthDay: z.array(z.number().int().min(1).max(31)).optional(),
  byMonth: z.array(z.number().int().min(1).max(12)).optional(),
  count: z.number().int().min(1).optional(),
  until: z.string().optional(),
});

/** Output shape — faithful to stored data, no re-imposed input bounds. */
const recurrenceRuleOutputSchema = z.object({
  frequency: recurrenceFrequencyEnum,
  interval: z.number(),
  byDay: z.array(weekdayEnum).optional(),
  byMonthDay: z.array(z.number()).optional(),
  byMonth: z.array(z.number()).optional(),
  count: z.number().optional(),
  until: z.string().optional(),
});

/** `{id,name,image}` — createdBy on events, and the nested user on event.attendees. */
const userRefSchema = z.object({ id: z.string(), name: z.string().nullable(), image: z.string().nullable() }).nullable();

/** `{id,name,email,image}` — the nested user shape returned only by the attendees endpoints. */
const userWithEmailRefSchema = z
  .object({ id: z.string(), name: z.string().nullable(), email: z.string().nullable(), image: z.string().nullable() })
  .nullable();

const pageRefSchema = z.object({ id: z.string(), title: z.string().nullable(), type: z.string() }).nullable();
const driveRefSchema = z.object({ id: z.string(), name: z.string(), slug: z.string() }).nullable();

/** Raw `eventAttendees` row (`packages/db/src/schema/calendar.ts`). */
const attendeeBaseSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  userId: z.string(),
  status: attendeeStatusEnum,
  responseNote: z.string().nullable(),
  isOrganizer: z.boolean(),
  isOptional: z.boolean(),
  invitedAt: z.string(),
  respondedAt: z.string().nullable(),
});

/** Attendee as nested under `event.attendees` (no email — `attendees.with.user.columns`). */
const eventNestedAttendeeSchema = attendeeBaseSchema.extend({ user: userRefSchema });

/** Attendee as returned bare by the attendees endpoints (`GET`/`POST .../attendees`, includes email). */
const attendeeWithEmailSchema = attendeeBaseSchema.extend({ user: userWithEmailRefSchema });

/**
 * Full `calendarEvents` row + relations, matching the shape returned by
 * GET single event / create / update. `drive` is present only on GET single
 * event and `calendar.list`'s user-context branch (absent on create/update/
 * drive-context list) — modeled as optional so both cases parse.
 */
const calendarEventSchema = z.object({
  id: z.string(),
  driveId: z.string().nullable(),
  createdById: z.string(),
  pageId: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  location: z.string().nullable(),
  startAt: z.string(),
  endAt: z.string(),
  allDay: z.boolean(),
  timezone: z.string(),
  recurrenceRule: recurrenceRuleOutputSchema.nullable(),
  recurrenceExceptions: z.array(z.string()).nullable(),
  recurringEventId: z.string().nullable(),
  originalStartAt: z.string().nullable(),
  visibility: eventVisibilityEnum,
  color: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  isTrashed: z.boolean(),
  trashedAt: z.string().nullable(),
  googleEventId: z.string().nullable(),
  googleCalendarId: z.string().nullable(),
  syncedFromGoogle: z.boolean(),
  googleSyncReadOnly: z.boolean().nullable(),
  lastGoogleSync: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: userRefSchema,
  attendees: z.array(eventNestedAttendeeSchema),
  page: pageRefSchema,
  drive: driveRefSchema.optional(),
});

/**
 * List-only event shape: `hasAgentTrigger` is annotated by the route for
 * every event; `recurringBaseStartAt`/`recurringBaseEndAt` are added only to
 * expanded recurrence occurrences (`expandRecurringEvents`,
 * `apps/web/src/lib/workflows/recurrence-utils.ts`), absent on non-recurring
 * events and on `calendar.get`/create/update responses.
 */
const calendarListEventSchema = calendarEventSchema.extend({
  hasAgentTrigger: z.boolean(),
  recurringBaseStartAt: z.string().optional(),
  recurringBaseEndAt: z.string().optional(),
});

/** Virtual (non-persisted) workflow-schedule entries appended to the list response. */
const workflowEventSchema = z.object({
  id: z.string(),
  title: z.string(),
  startAt: z.string(),
  endAt: z.string(),
  allDay: z.boolean(),
  source: z.literal('workflow'),
  workflowId: z.string(),
  driveId: z.string(),
  color: z.string(),
  triggerType: z.string().optional(),
});

/** `agentTrigger` shared shape (create/setTrigger): requires prompt or instructionPageId. */
const agentTriggerInputSchema = z
  .object({
    agentPageId: z.string().min(1),
    prompt: z.string().trim().max(10000).optional(),
    instructionPageId: z.string().nullable().optional(),
    contextPageIds: z.array(z.string()).max(10).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.prompt) || Boolean(v.instructionPageId), {
    message: 'agentTrigger needs either a prompt or an instructionPageId',
    path: ['prompt'],
  });

const successSchema = z.object({ success: z.literal(true) });

// ---------------------------------------------------------------------------
// calendar.list — GET /api/calendar/events (list_calendar_events)
// ---------------------------------------------------------------------------

export const listCalendarEvents = defineOperation({
  name: 'calendar.list',
  method: 'GET',
  path: '/api/calendar/events',
  inputSchema: z
    .object({
      context: z.enum(['user', 'drive']).optional(),
      driveId: z.string().optional(),
      startDate: isoDatetimeSchema,
      endDate: isoDatetimeSchema,
      /**
       * Route truth (`calendar/events/route.ts:30`): coerced server-side via
       * `z.coerce.boolean()`, which is `Boolean(str)` — ANY non-empty string,
       * including the literal `"false"`, coerces to `true`. There is
       * currently no way to exclude personal events from a `context: 'user'`
       * list through this endpoint; passing `includePersonal: false` has no
       * effect server-side. Kept faithful to the route's declared input
       * rather than silently dropped, but documented so callers aren't
       * surprised.
       */
      includePersonal: z.boolean().optional(),
    })
    .strict()
    .refine((v) => v.context !== 'drive' || Boolean(v.driveId), {
      message: 'driveId is required for drive context',
      path: ['driveId'],
    }),
  outputSchema: z.object({
    events: z.array(calendarListEventSchema),
    workflowEvents: z.array(workflowEventSchema),
  }),
  description:
    'List calendar events in a date range. Returns {events, workflowEvents} — never a bare array. Use context "drive" with driveId to scope to one drive, or "user" (default) to aggregate personal + attending + accessible-drive events.',
});

// ---------------------------------------------------------------------------
// calendar.get — GET /api/calendar/events/:eventId (get_calendar_event)
// ---------------------------------------------------------------------------

export const getCalendarEvent = defineOperation({
  name: 'calendar.get',
  method: 'GET',
  path: '/api/calendar/events/:eventId',
  inputSchema: z.object({ eventId: z.string() }).strict(),
  outputSchema: calendarEventSchema,
  description: 'Get a single calendar event by id. Fails closed with 404/403 per canAccessEvent visibility rules.',
});

// ---------------------------------------------------------------------------
// calendar.create — POST /api/calendar/events (create_calendar_event)
// ---------------------------------------------------------------------------

export const createCalendarEvent = defineOperation({
  name: 'calendar.create',
  method: 'POST',
  path: '/api/calendar/events',
  inputSchema: z
    .object({
      driveId: z.string().nullable().optional(),
      pageId: z.string().nullable().optional(),
      title: z.string().min(1).max(500),
      description: z.string().max(10000).nullable().optional(),
      location: z.string().max(1000).nullable().optional(),
      startAt: isoDatetimeSchema,
      endAt: isoDatetimeSchema,
      allDay: z.boolean().optional(),
      timezone: z.string().optional(),
      recurrenceRule: recurrenceRuleInputSchema.nullable().optional(),
      visibility: eventVisibilityEnum.optional(),
      color: z.string().optional(),
      /** D5: the route field is `attendeeIds`, not the old handler's `userIds`. */
      attendeeIds: z.array(z.string()).optional(),
      agentTrigger: agentTriggerInputSchema.optional(),
    })
    .strict()
    .refine((v) => !v.agentTrigger || Boolean(v.driveId), {
      message: 'Agent triggers require a drive event',
      path: ['agentTrigger'],
    }),
  outputSchema: calendarEventSchema,
  description:
    'Create a calendar event. Pass driveId for a drive event or omit it for a personal event (agentTrigger requires a driveId). attendeeIds invites drive members; the creator is always added as organizer.',
});

// ---------------------------------------------------------------------------
// calendar.update — PATCH /api/calendar/events/:eventId (update_calendar_event)
// ---------------------------------------------------------------------------

export const updateCalendarEvent = defineOperation({
  name: 'calendar.update',
  method: 'PATCH',
  path: '/api/calendar/events/:eventId',
  inputSchema: z
    .object({
      eventId: z.string(),
      title: z.string().min(1).max(500).optional(),
      description: z.string().max(10000).nullable().optional(),
      location: z.string().max(1000).nullable().optional(),
      startAt: isoDatetimeSchema.optional(),
      endAt: isoDatetimeSchema.optional(),
      allDay: z.boolean().optional(),
      timezone: z.string().optional(),
      recurrenceRule: recurrenceRuleInputSchema.nullable().optional(),
      visibility: eventVisibilityEnum.optional(),
      color: z.string().optional(),
      pageId: z.string().nullable().optional(),
      /**
       * Three-state field, not a default: `undefined` leaves any existing
       * trigger alone, `null` removes it, an object upserts it. The route
       * requires the event to already have a driveId for the object case, but
       * that isn't visible from this input alone (unlike create), so it's not
       * refined client-side — mirrors `tasks.update`'s precedent of not
       * failing closed on server-only state.
       */
      agentTrigger: agentTriggerInputSchema.nullable().optional(),
    })
    .strict(),
  outputSchema: calendarEventSchema,
  description:
    'Update a calendar event\'s fields. agentTrigger is three-state: omit to leave it alone, null to remove it, or an object to upsert it (requires the event already have a drive).',
});

// ---------------------------------------------------------------------------
// calendar.delete — DELETE /api/calendar/events/:eventId (delete_calendar_event)
// ---------------------------------------------------------------------------

export const deleteCalendarEvent = defineOperation({
  name: 'calendar.delete',
  method: 'DELETE',
  path: '/api/calendar/events/:eventId',
  inputSchema: z.object({ eventId: z.string() }).strict(),
  outputSchema: z.object({ success: z.boolean() }),
  description: 'Soft-delete (trash) a calendar event. Only the creator or a drive owner/admin may delete it.',
});

// ---------------------------------------------------------------------------
// calendar.rsvp — PATCH /api/calendar/events/:eventId/attendees (rsvp_calendar_event)
// ---------------------------------------------------------------------------

export const rsvpCalendarEvent = defineOperation({
  name: 'calendar.rsvp',
  method: 'PATCH',
  path: '/api/calendar/events/:eventId/attendees',
  inputSchema: z
    .object({
      eventId: z.string(),
      /** Full route enum (the old tool only exposed ACCEPTED/DECLINED/TENTATIVE) — PENDING is a legal RSVP too. */
      status: attendeeStatusEnum,
      responseNote: z.string().max(500).nullable().optional(),
    })
    .strict(),
  outputSchema: attendeeBaseSchema,
  description:
    "Update the caller's own RSVP status for an event. Returns the bare updated attendee row (no nested user). The caller must already be an attendee.",
});

// ---------------------------------------------------------------------------
// calendar.inviteAttendees — POST /api/calendar/events/:eventId/attendees (invite_calendar_attendees)
// ---------------------------------------------------------------------------

export const inviteCalendarAttendees = defineOperation({
  name: 'calendar.inviteAttendees',
  method: 'POST',
  path: '/api/calendar/events/:eventId/attendees',
  inputSchema: z
    .object({
      eventId: z.string(),
      userIds: z.array(z.string()).min(1),
      isOptional: z.boolean().optional(),
    })
    .strict(),
  /**
   * The route has two 200 shapes: `{attendees}` normally, or `{message}`
   * when every requested user is already an attendee (route source:
   * `attendees/route.ts:244-249`). Modeled as a union so both parse.
   */
  outputSchema: z.union([z.object({ attendees: z.array(attendeeWithEmailSchema) }), z.object({ message: z.string() })]),
  description:
    'Invite users to a drive event (only the creator may add attendees; all invitees must already be drive members). Personal (driveless) and PRIVATE events reject additional attendees.',
});

// ---------------------------------------------------------------------------
// calendar.removeAttendee — DELETE /api/calendar/events/:eventId/attendees?userId= (remove_calendar_attendee)
// ---------------------------------------------------------------------------

export const removeCalendarAttendee = defineOperation({
  name: 'calendar.removeAttendee',
  method: 'DELETE',
  /**
   * D6: the route reads the target exclusively from the `?userId=` query
   * param (defaulting to the *caller* when absent) and ignores any JSON
   * body. Embedding `:userId` in the path template after a literal
   * `?userId=` makes `buildRequest`'s path interpolation put it on the URL
   * for this DELETE request — the only way to land a field in the query
   * string of a non-GET operation without touching the shared transport.
   */
  path: '/api/calendar/events/:eventId/attendees?userId=:userId',
  inputSchema: z.object({ eventId: z.string(), userId: z.string() }).strict(),
  outputSchema: successSchema,
  description:
    "Remove an attendee from an event. The event creator can remove anyone; any attendee can remove themselves. Cannot remove the organizer. userId travels as a query param, never a body field (D6 fix — the route ignores the body).",
});

// ---------------------------------------------------------------------------
// calendar.setTrigger — PUT /api/calendar/events/:eventId/triggers (set_calendar_trigger)
// ---------------------------------------------------------------------------

export const setCalendarTrigger = defineOperation({
  name: 'calendar.setTrigger',
  method: 'PUT',
  path: '/api/calendar/events/:eventId/triggers',
  inputSchema: z
    .object({
      eventId: z.string(),
      agentPageId: z.string().min(1),
      prompt: z.string().trim().max(10000).optional(),
      instructionPageId: z.string().nullable().optional(),
      contextPageIds: z.array(z.string()).max(10).optional(),
    })
    .strict()
    .refine((v) => Boolean(v.prompt) || Boolean(v.instructionPageId), {
      message: 'Either prompt or instructionPageId is required',
      path: ['prompt'],
    }),
  outputSchema: successSchema,
  description:
    'Set (upsert) the single agent trigger for a calendar event — fires at the event start time. Requires a drive event (personal events reject with 400); only the creator or a drive owner/admin may set it.',
});

// ---------------------------------------------------------------------------
// calendar.deleteTrigger — DELETE /api/calendar/events/:eventId/triggers (delete_calendar_trigger)
// ---------------------------------------------------------------------------

export const deleteCalendarTrigger = defineOperation({
  name: 'calendar.deleteTrigger',
  method: 'DELETE',
  path: '/api/calendar/events/:eventId/triggers',
  inputSchema: z.object({ eventId: z.string() }).strict(),
  outputSchema: successSchema,
  description: "Remove the agent trigger from a calendar event. Idempotent — succeeds even if no trigger exists.",
});

// ---------------------------------------------------------------------------
// computeFreeSlots — pure availability computation (check_calendar_availability, D4)
// ---------------------------------------------------------------------------

export interface FreeSlot {
  readonly startAt: string;
  readonly endAt: string;
}

interface TimedEvent {
  readonly startAt: string;
  readonly endAt: string;
}

/**
 * `check_calendar_availability` hits the same route as `calendar.list` and
 * computed free/busy gaps client-side (old handler `calendar.js:118-139`).
 * Rather than a second network operation, this models that computation as a
 * pure function over `listCalendarEvents`'s `events` array: sort by start,
 * walk a running "busy until" pointer, and record the gaps before, between,
 * and after events within `range`. Overlapping/adjacent events merge into
 * one busy block. No working-hours windowing, no recurrence expansion beyond
 * what `calendar.list` already returned (matches the old handler's
 * documented limitations).
 */
export function computeFreeSlots(events: readonly TimedEvent[], range: { startAt: string; endAt: string }): FreeSlot[] {
  const rangeStart = new Date(range.startAt);
  const rangeEnd = new Date(range.endAt);

  const sorted = [...events].sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());

  const freeSlots: FreeSlot[] = [];
  let current = rangeStart;

  for (const event of sorted) {
    const eventStart = new Date(event.startAt);
    const gapEnd = eventStart < rangeEnd ? eventStart : rangeEnd;
    if (gapEnd > current) {
      freeSlots.push({ startAt: current.toISOString(), endAt: gapEnd.toISOString() });
    }
    const eventEnd = new Date(event.endAt);
    if (eventEnd > current) current = eventEnd;
  }

  if (current < rangeEnd) {
    freeSlots.push({ startAt: current.toISOString(), endAt: rangeEnd.toISOString() });
  }

  return freeSlots;
}
