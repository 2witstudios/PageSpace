import { pgTable, text, timestamp, boolean, index, unique } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { workflows } from './workflows';
import { zoomConnections } from './zoom';

/**
 * Webhook Triggers
 *
 * The external-event counterpart to task_triggers and calendar_triggers.
 * Pairs an incoming provider event (e.g. Zoom 'recording.transcript_completed')
 * with the workflows row that holds the execution payload (prompt, agent,
 * context). When a verified webhook arrives, fireZoomWebhookTriggers looks up
 * enabled rows matching (connectionId, eventType) and dispatches each through
 * executeWorkflow with sourceTable='webhookTriggers'.
 */
export const webhookTriggers = pgTable('webhook_triggers', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  workflowId: text('workflowId').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  connectionId: text('connectionId').notNull().references(() => zoomConnections.id, { onDelete: 'cascade' }),

  provider: text('provider').notNull(),   // 'zoom' (extensible to 'github' etc.)
  eventType: text('eventType').notNull(), // e.g. 'recording.transcript_completed'

  isEnabled: boolean('isEnabled').default(true).notNull(),
  lastFiredAt: timestamp('lastFiredAt', { mode: 'date' }),
  lastFireError: text('lastFireError'),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    workflowIdx: index('webhook_triggers_workflow_id_idx').on(table.workflowId),
    providerEventIdx: index('webhook_triggers_provider_event_idx').on(table.provider, table.eventType, table.isEnabled),
    connectionIdx: index('webhook_triggers_connection_id_idx').on(table.connectionId),
    // One wiring per (connection, workflow, event) — repeated POSTs are idempotent
    // (the route uses onConflictDoNothing), preventing duplicate fan-out.
    connectionWorkflowEventUnique: unique('webhook_triggers_connection_workflow_event_unique').on(
      table.connectionId,
      table.workflowId,
      table.eventType,
    ),
  };
});

export const webhookTriggersRelations = relations(webhookTriggers, ({ one }) => ({
  workflow: one(workflows, {
    fields: [webhookTriggers.workflowId],
    references: [workflows.id],
  }),
  connection: one(zoomConnections, {
    fields: [webhookTriggers.connectionId],
    references: [zoomConnections.id],
  }),
}));

export type WebhookTrigger = typeof webhookTriggers.$inferSelect;
export type NewWebhookTrigger = typeof webhookTriggers.$inferInsert;
