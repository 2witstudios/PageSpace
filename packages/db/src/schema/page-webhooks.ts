import { pgTable, text, timestamp, boolean, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { pages } from './core';

/**
 * Page Incoming Webhooks
 *
 * Discord-style incoming webhooks on any page: mint a named webhook URL+secret,
 * POST a signed payload to it, and a verified delivery dispatches to the
 * page-type's default action (e.g. CHANNEL → the payload appears as a message
 * verbatim). Modeled on webhook_triggers' row shape (isEnabled/lastFiredAt/
 * lastFireError bookkeeping) but anchored to a page, not an OAuth connection.
 * Deliberately minimal: no source types, filters, or dedupe — the webhook IS
 * the routing decision.
 */
export const pageWebhooks = pgTable('page_webhooks', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  pageId: text('pageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  /** Human label, and the default sender name for posted messages (a payload `username` overrides it). */
  name: text('name').notNull(),
  /** URL path segment identifying this webhook — unguessable, but not a secret on its own; the HMAC secret below is what authenticates a post. */
  webhookToken: text('webhookToken').notNull().unique().$defaultFn(() => createId()),
  /** HMAC signing secret, field-level encrypted (packages/lib/src/encryption/field-crypto.ts). Plaintext is shown exactly once at creation. */
  webhookSecretEncrypted: text('webhookSecretEncrypted').notNull(),
  isEnabled: boolean('isEnabled').default(true).notNull(),
  createdBy: text('createdBy').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  lastFiredAt: timestamp('lastFiredAt', { mode: 'date' }),
  lastFireError: text('lastFireError'),
}, (table) => {
  return {
    pageIdx: index('page_webhooks_page_id_idx').on(table.pageId),
    tokenIdx: index('page_webhooks_token_idx').on(table.webhookToken),
  };
});

export const pageWebhooksRelations = relations(pageWebhooks, ({ one }) => ({
  page: one(pages, {
    fields: [pageWebhooks.pageId],
    references: [pages.id],
  }),
  createdByUser: one(users, {
    fields: [pageWebhooks.createdBy],
    references: [users.id],
  }),
}));

export type PageWebhook = typeof pageWebhooks.$inferSelect;
export type NewPageWebhook = typeof pageWebhooks.$inferInsert;

/** Dedicated system-sender identity for webhook-posted messages (channel_messages.userId is NOT NULL); seeded via migration. */
export const SYSTEM_WEBHOOKS_USER_ID = 'system-webhooks';
