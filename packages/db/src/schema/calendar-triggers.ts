import { pgTable, text, timestamp, integer, index, unique, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { drives } from './core';
import { calendarEvents } from './calendar';
import { workflows } from './workflows';

export const calendarTriggerStatus = pgEnum('CalendarTriggerStatus', [
  'pending',
  'claimed',   // Reserved for future two-phase claim in recurring trigger support
  'running',
  'completed',
  'failed',
  'cancelled',
]);

/**
 * Calendar Triggers
 *
 * The "when" half of a calendar-driven workflow. The execution payload
 * (prompt, agent, instruction page, context pages) lives on the linked
 * workflows row referenced by `workflowId`. The cron calendar-triggers
 * poller claims these rows and delegates to the workflow executor.
 */
export const calendarTriggers = pgTable('calendar_triggers', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  workflowId: text('workflowId').notNull().references(() => workflows.id, { onDelete: 'cascade' }),

  // Link to the calendar event that represents this trigger visually
  calendarEventId: text('calendarEventId').notNull().references(() => calendarEvents.id, { onDelete: 'cascade' }),

  // Drive context for execution and access checks
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),

  // Human responsible for cost (rate-limit / API key resolution)
  scheduledById: text('scheduledById').notNull().references(() => users.id, { onDelete: 'cascade' }),

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
    statusTriggerAtIdx: index('calendar_triggers_status_trigger_at_idx').on(table.status, table.triggerAt),
    scheduledByIdx: index('calendar_triggers_scheduled_by_idx').on(table.scheduledById),
    calendarEventIdx: index('calendar_triggers_calendar_event_idx').on(table.calendarEventId),
    workflowIdx: index('calendar_triggers_workflow_id_idx').on(table.workflowId),
    eventOccurrenceKey: unique('calendar_triggers_event_occurrence_key').on(table.calendarEventId, table.occurrenceDate),
  };
});

// Relations
export const calendarTriggersRelations = relations(calendarTriggers, ({ one }) => ({
  workflow: one(workflows, {
    fields: [calendarTriggers.workflowId],
    references: [workflows.id],
  }),
  calendarEvent: one(calendarEvents, {
    fields: [calendarTriggers.calendarEventId],
    references: [calendarEvents.id],
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
