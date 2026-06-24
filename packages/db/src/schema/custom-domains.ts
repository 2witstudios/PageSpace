import { pgTable, text, timestamp, index, uniqueIndex, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { drives } from './core';

export const customDomainStatus = pgEnum('custom_domain_status', ['pending', 'verified', 'failed', 'provisioning', 'active', 'dns_failed', 'cert_failed']);

export const customDomains = pgTable('custom_domains', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  driveId: text('drive_id').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  hostname: text('hostname').notNull(),
  status: customDomainStatus('status').default('pending').notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  hostnameKey: uniqueIndex('custom_domains_hostname_key').on(table.hostname),
  driveIdx: index('custom_domains_drive_id_idx').on(table.driveId),
}));

export const customDomainsRelations = relations(customDomains, ({ one }) => ({
  drive: one(drives, {
    fields: [customDomains.driveId],
    references: [drives.id],
  }),
}));

export type CustomDomain = typeof customDomains.$inferSelect;
export type NewCustomDomain = typeof customDomains.$inferInsert;
