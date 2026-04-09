import { pgTable, text, timestamp, jsonb, integer, index, unique, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { drives, pages } from './core';
import { calendarEvents } from './calendar';

export const calendarTriggerStatus = pgEnum('CalendarTriggerStatus', [
  'pending',
  'claimed',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

/**
 * Calendar Triggers
 *
 * Tracks scheduled LLM agent executions tied to calendar events.
 * When a calendar event's time arrives the cron poller claims the
 * trigger row and fires the target agent with the stored prompt.
 */
export const calendarTriggers = pgTable('calendar_triggers', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Link to the calendar event that represents this trigger visually
  calendarEventId: text('calendarEventId').notNull().references(() => calendarEvents.id, { onDelete: 'cascade' }),

  // Target agent to execute
  agentPageId: text('agentPageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),

  // Drive context for execution
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),

  // Human responsible for cost (rate-limit / API key resolution)
  scheduledById: text('scheduledById').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Instructions for the agent
  prompt: text('prompt').notNull(),
  instructionPageId: text('instructionPageId').references(() => pages.id, { onDelete: 'set null' }),
  contextPageIds: jsonb('contextPageIds').$type<string[]>().default([]),

  // Execution state
  status: calendarTriggerStatus('status').notNull().default('pending'),
  triggerAt: timestamp('triggerAt', { mode: 'date', withTimezone: true }).notNull(),

  claimedAt: timestamp('claimedAt', { mode: 'date', withTimezone: true }),
  startedAt: timestamp('startedAt', { mode: 'date', withTimezone: true }),
  completedAt: timestamp('completedAt', { mode: 'date', withTimezone: true }),

  error: text('error'),
  durationMs: integer('durationMs'),

  // Links to saved chat messages for inspection
  conversationId: text('conversationId'),

  // For recurring events: one trigger row per occurrence.
  // One-shot events use the epoch sentinel (1970-01-01) so the unique constraint works
  // (PostgreSQL treats NULL != NULL, so a nullable column breaks dedup).
  occurrenceDate: timestamp('occurrenceDate', { mode: 'date', withTimezone: true }).notNull().default(new Date(0)),

  // Audit timestamps
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    // Cron polling: find pending triggers that are due
    statusTriggerAtIdx: index('calendar_triggers_status_trigger_at_idx').on(table.status, table.triggerAt),
    // User's scheduled triggers
    scheduledByIdx: index('calendar_triggers_scheduled_by_idx').on(table.scheduledById),
    // Agent's scheduled work
    agentPageIdx: index('calendar_triggers_agent_page_idx').on(table.agentPageId),
    // FK lookup
    calendarEventIdx: index('calendar_triggers_calendar_event_idx').on(table.calendarEventId),
    // Prevent duplicate triggers for the same event occurrence
    eventOccurrenceKey: unique('calendar_triggers_event_occurrence_key').on(table.calendarEventId, table.occurrenceDate),
  };
});

// Relations
export const calendarTriggersRelations = relations(calendarTriggers, ({ one }) => ({
  calendarEvent: one(calendarEvents, {
    fields: [calendarTriggers.calendarEventId],
    references: [calendarEvents.id],
  }),
  agentPage: one(pages, {
    fields: [calendarTriggers.agentPageId],
    references: [pages.id],
    relationName: 'triggerAgent',
  }),
  instructionPage: one(pages, {
    fields: [calendarTriggers.instructionPageId],
    references: [pages.id],
    relationName: 'triggerInstructions',
  }),
  drive: one(drives, {
    fields: [calendarTriggers.driveId],
    references: [drives.id],
  }),
  scheduledBy: one(users, {
    fields: [calendarTriggers.scheduledById],
    references: [users.id],
  }),
}));

// Type exports
export type CalendarTrigger = typeof calendarTriggers.$inferSelect;
export type NewCalendarTrigger = typeof calendarTriggers.$inferInsert;

// Metadata shape stored on calendarEvents.metadata when the event is a trigger
export interface CalendarTriggerMetadata {
  isTrigger: true;
  triggerType: 'agent_execution';
  triggerId: string;
  scheduledByAgentPageId?: string;
}
