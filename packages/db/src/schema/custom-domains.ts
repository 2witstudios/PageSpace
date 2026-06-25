import { pgTable, text, timestamp, boolean, index, uniqueIndex, pgEnum } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { drives } from './core';

export const customDomainStatus = pgEnum('custom_domain_status', ['pending', 'verified', 'failed', 'provisioning', 'active', 'dns_failed', 'cert_failed']);

export const customDomains = pgTable('custom_domains', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  driveId: text('drive_id').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  hostname: text('hostname').notNull(),
  status: customDomainStatus('status').default('pending').notNull(),
  // The user-selected primary host for the drive's published site (canonical
  // SEO host + the link shown on published Canvas pages). At most one per drive
  // (enforced by the partial unique index below). When none is set, the primary
  // is resolved automatically — see resolvePrimaryPublishedHost.
  isPrimary: boolean('is_primary').default(false).notNull(),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  hostnameKey: uniqueIndex('custom_domains_hostname_key').on(table.hostname),
  driveIdx: index('custom_domains_drive_id_idx').on(table.driveId),
  // At most one primary domain per drive.
  primaryPerDrive: uniqueIndex('custom_domains_primary_per_drive')
    .on(table.driveId)
    .where(sql`${table.isPrimary}`),
}));

export const customDomainsRelations = relations(customDomains, ({ one }) => ({
  drive: one(drives, {
    fields: [customDomains.driveId],
    references: [drives.id],
  }),
}));

export type CustomDomain = typeof customDomains.$inferSelect;
export type NewCustomDomain = typeof customDomains.$inferInsert;
