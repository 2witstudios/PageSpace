import { pgTable, text, timestamp, boolean, index, unique, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { workflows } from './workflows';
import { zoomConnections } from './zoom';
import { pageWebhooks } from './page-webhooks';

/**
 * Webhook Triggers
 *
 * The external-event counterpart to task_triggers and calendar_triggers.
 * Pairs an incoming external event with the workflows row that holds the
 * execution payload (prompt, agent, context). A row is anchored to exactly
 * one event source (XOR CHECK below):
 *  - connectionId  → a provider OAuth connection (e.g. Zoom
 *    'recording.transcript_completed'); fireZoomWebhookTriggers looks up
 *    enabled rows matching (connectionId, eventType) and dispatches each
 *    through executeWorkflow with sourceTable='webhookTriggers'.
 *  - pageWebhookId → a page incoming webhook; event matching is skipped —
 *    every enabled trigger on the webhook fires (eventType='*' by convention).
 */
export const webhookTriggers = pgTable('webhook_triggers', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  workflowId: text('workflowId').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  connectionId: text('connectionId').references(() => zoomConnections.id, { onDelete: 'cascade' }),
  pageWebhookId: text('pageWebhookId').references(() => pageWebhooks.id, { onDelete: 'cascade' }),

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
    pageWebhookIdx: index('webhook_triggers_page_webhook_id_idx').on(table.pageWebhookId),
    // One wiring per (connection, workflow, event) — repeated POSTs are idempotent
    // (the route uses onConflictDoNothing), preventing duplicate fan-out.
    connectionWorkflowEventUnique: unique('webhook_triggers_connection_workflow_event_unique').on(
      table.connectionId,
      table.workflowId,
      table.eventType,
    ),
    // Page-anchored rows skip event matching (all enabled triggers fire), so the
    // idempotency key is just (pageWebhookId, workflowId). Partial: NULLs stay out.
    pageWebhookWorkflowUnique: uniqueIndex('webhook_triggers_page_webhook_workflow_unique')
      .on(table.pageWebhookId, table.workflowId)
      .where(sql`${table.pageWebhookId} IS NOT NULL`),
    // Exactly one anchor per row: an OAuth connection XOR a page webhook.
    anchorXor: check(
      'webhook_triggers_anchor_chk',
      sql`(${table.connectionId} IS NOT NULL AND ${table.pageWebhookId} IS NULL) OR (${table.connectionId} IS NULL AND ${table.pageWebhookId} IS NOT NULL)`
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
  pageWebhook: one(pageWebhooks, {
    fields: [webhookTriggers.pageWebhookId],
    references: [pageWebhooks.id],
  }),
}));

export type WebhookTrigger = typeof webhookTriggers.$inferSelect;
export type NewWebhookTrigger = typeof webhookTriggers.$inferInsert;
