import { pgTable, text, timestamp, boolean, pgEnum, index, unique, jsonb, integer } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { drives, pages } from './core';
import { createId } from '@paralleldrive/cuid2';

// Google Calendar connection status
export const googleCalendarConnectionStatus = pgEnum('GoogleCalendarConnectionStatus', [
  'active',
  'expired',
  'error',
  'disconnected',
]);

// Event visibility levels
export const eventVisibility = pgEnum('EventVisibility', ['DRIVE', 'ATTENDEES_ONLY', 'PRIVATE']);

// Attendee response status
export const attendeeStatus = pgEnum('AttendeeStatus', ['PENDING', 'ACCEPTED', 'DECLINED', 'TENTATIVE']);

// Recurrence frequency
export const recurrenceFrequency = pgEnum('RecurrenceFrequency', ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

/**
 * Calendar Events
 * Events belong to a drive (driveId set) OR are personal events (driveId null)
 * Personal events are only visible to the creator
 * Drive events are visible to drive members based on visibility setting
 */
export const calendarEvents = pgTable('calendar_events', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Ownership - null driveId means personal calendar
  driveId: text('driveId').references(() => drives.id, { onDelete: 'cascade' }),
  createdById: text('createdById').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Optional link to a page (project, channel, etc.)
  pageId: text('pageId').references(() => pages.id, { onDelete: 'set null' }),

  // Event details
  title: text('title').notNull(),
  description: text('description'),
  location: text('location'),

  // Temporal fields
  startAt: timestamp('startAt', { mode: 'date', withTimezone: true }).notNull(),
  endAt: timestamp('endAt', { mode: 'date', withTimezone: true }).notNull(),
  allDay: boolean('allDay').default(false).notNull(),
  timezone: text('timezone').default('UTC').notNull(),

  // Recurrence (AI-parseable structure)
  recurrenceRule: jsonb('recurrenceRule').$type<{
    frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
    interval: number; // e.g., every 2 weeks
    byDay?: ('MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU')[]; // for weekly
    byMonthDay?: number[]; // for monthly (1-31)
    byMonth?: number[]; // for yearly (1-12)
    count?: number; // end after N occurrences
    until?: string; // end by date (ISO string)
  } | null>(),
  recurrenceExceptions: jsonb('recurrenceExceptions').$type<string[]>().default([]), // ISO date strings to skip

  // For recurrence instances - references the parent recurring event
  // Note: Self-referential FK handled via relations to avoid circular type inference
  recurringEventId: text('recurringEventId'),
  originalStartAt: timestamp('originalStartAt', { mode: 'date', withTimezone: true }), // Original time if modified instance

  // Visibility and collaboration
  visibility: eventVisibility('visibility').default('DRIVE').notNull(),

  // Color category for visual distinction
  color: text('color').default('default'), // 'default', 'meeting', 'deadline', 'personal', 'travel', 'focus'

  // Metadata for extensibility
  metadata: jsonb('metadata'),

  // Soft delete
  isTrashed: boolean('isTrashed').default(false).notNull(),
  trashedAt: timestamp('trashedAt', { mode: 'date' }),

  // Google Calendar sync tracking
  googleEventId: text('googleEventId'),          // Google's event ID
  googleCalendarId: text('googleCalendarId'),    // Which Google calendar this came from
  syncedFromGoogle: boolean('syncedFromGoogle').default(false).notNull(), // true = imported from Google
  lastGoogleSync: timestamp('lastGoogleSync', { mode: 'date', withTimezone: true }), // Last sync timestamp
  googleSyncReadOnly: boolean('googleSyncReadOnly').default(true), // Prevent editing if synced

  // Audit timestamps
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    driveIdx: index('calendar_events_drive_id_idx').on(table.driveId),
    createdByIdx: index('calendar_events_created_by_id_idx').on(table.createdById),
    pageIdx: index('calendar_events_page_id_idx').on(table.pageId),
    startAtIdx: index('calendar_events_start_at_idx').on(table.startAt),
    endAtIdx: index('calendar_events_end_at_idx').on(table.endAt),
    driveStartAtIdx: index('calendar_events_drive_id_start_at_idx').on(table.driveId, table.startAt),
    recurringEventIdx: index('calendar_events_recurring_event_id_idx').on(table.recurringEventId),
    trashedIdx: index('calendar_events_is_trashed_idx').on(table.isTrashed),
    googleEventIdx: index('calendar_events_google_event_id_idx').on(table.googleEventId),
    syncedFromGoogleIdx: index('calendar_events_synced_from_google_idx').on(table.syncedFromGoogle),
    googleSourcePerUserKey: unique('calendar_events_google_source_per_user_key').on(
      table.createdById,
      table.googleCalendarId,
      table.googleEventId
    ),
  }
});

/**
 * Event Attendees
 * Tracks who is invited to an event and their response status
 */
export const eventAttendees = pgTable('event_attendees', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  eventId: text('eventId').notNull().references(() => calendarEvents.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Response status
  status: attendeeStatus('status').default('PENDING').notNull(),
  responseNote: text('responseNote'),

  // Whether this attendee is the organizer
  isOrganizer: boolean('isOrganizer').default(false).notNull(),

  // Whether this attendee is optional
  isOptional: boolean('isOptional').default(false).notNull(),

  // Timestamps
  invitedAt: timestamp('invitedAt', { mode: 'date' }).defaultNow().notNull(),
  respondedAt: timestamp('respondedAt', { mode: 'date' }),
}, (table) => {
  return {
    eventUserKey: unique('event_attendees_event_user_key').on(table.eventId, table.userId),
    eventIdx: index('event_attendees_event_id_idx').on(table.eventId),
    userIdx: index('event_attendees_user_id_idx').on(table.userId),
    statusIdx: index('event_attendees_status_idx').on(table.status),
    userStatusIdx: index('event_attendees_user_id_status_idx').on(table.userId, table.status),
  }
});

/**
 * Google Calendar Connections
 * Stores OAuth tokens and sync configuration for Google Calendar integration.
 * One connection per user (unique constraint on userId).
 */
export const googleCalendarConnections = pgTable('google_calendar_connections', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),

  // OAuth tokens (encrypted at rest via application layer)
  accessToken: text('accessToken').notNull(),
  refreshToken: text('refreshToken').notNull(),
  tokenExpiresAt: timestamp('tokenExpiresAt', { mode: 'date', withTimezone: true }).notNull(),

  // Google account info
  googleEmail: text('googleEmail').notNull(),
  googleAccountId: text('googleAccountId').notNull(),

  // Connection status
  status: googleCalendarConnectionStatus('status').default('active').notNull(),
  statusMessage: text('statusMessage'),

  // Sync configuration
  targetDriveId: text('targetDriveId').references(() => drives.id, { onDelete: 'set null' }),
  selectedCalendars: jsonb('selectedCalendars').$type<string[]>().default([]), // Google calendar IDs
  syncFrequencyMinutes: integer('syncFrequencyMinutes').default(15).notNull(),
  markAsReadOnly: boolean('markAsReadOnly').default(true).notNull(),

  // Sync state
  lastSyncAt: timestamp('lastSyncAt', { mode: 'date', withTimezone: true }),
  lastSyncError: text('lastSyncError'),
  syncCursor: text('syncCursor'), // Google's sync token for incremental sync

  // Push notification webhook state (per-calendar channels stored as JSONB)
  // Shape: Record<calendarId, { channelId: string; resourceId: string; expiration: string }>
  webhookChannels: jsonb('webhookChannels').$type<Record<string, {
    channelId: string;
    resourceId: string;
    expiration: string;
  }>>(),

  // Audit timestamps
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    userIdx: index('google_calendar_connections_user_id_idx').on(table.userId),
    statusIdx: index('google_calendar_connections_status_idx').on(table.status),
    targetDriveIdx: index('google_calendar_connections_target_drive_id_idx').on(table.targetDriveId),
  }
});

// Relations
export const calendarEventsRelations = relations(calendarEvents, ({ one, many }) => ({
  drive: one(drives, {
    fields: [calendarEvents.driveId],
    references: [drives.id],
  }),
  createdBy: one(users, {
    fields: [calendarEvents.createdById],
    references: [users.id],
    relationName: 'eventCreator',
  }),
  page: one(pages, {
    fields: [calendarEvents.pageId],
    references: [pages.id],
  }),
  recurringEvent: one(calendarEvents, {
    fields: [calendarEvents.recurringEventId],
    references: [calendarEvents.id],
    relationName: 'recurringInstances',
  }),
  instances: many(calendarEvents, {
    relationName: 'recurringInstances',
  }),
  attendees: many(eventAttendees),
}));

export const eventAttendeesRelations = relations(eventAttendees, ({ one }) => ({
  event: one(calendarEvents, {
    fields: [eventAttendees.eventId],
    references: [calendarEvents.id],
  }),
  user: one(users, {
    fields: [eventAttendees.userId],
    references: [users.id],
  }),
}));

export const googleCalendarConnectionsRelations = relations(googleCalendarConnections, ({ one }) => ({
  user: one(users, {
    fields: [googleCalendarConnections.userId],
    references: [users.id],
  }),
  targetDrive: one(drives, {
    fields: [googleCalendarConnections.targetDriveId],
    references: [drives.id],
  }),
}));

// Type exports
export type CalendarEvent = typeof calendarEvents.$inferSelect;
export type NewCalendarEvent = typeof calendarEvents.$inferInsert;

export type EventAttendee = typeof eventAttendees.$inferSelect;
export type NewEventAttendee = typeof eventAttendees.$inferInsert;

export type GoogleCalendarConnection = typeof googleCalendarConnections.$inferSelect;
export type NewGoogleCalendarConnection = typeof googleCalendarConnections.$inferInsert;
