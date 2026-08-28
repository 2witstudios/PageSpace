import { pgTable, text, timestamp, boolean, index, uniqueIndex, pgEnum } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { drives, pages } from './core';
import { publishedApps } from './published-apps';

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
  // True only for platform-owned domains (e.g. pagespace.ai) registered by a
  // platform admin to alias a drive's published content onto the app's own
  // domain. These rows skip DNS verification and Fly cert provisioning
  // entirely (the host already has valid DNS/TLS via the main app) and are
  // inserted directly as `active`. Never set by the normal drive-owner
  // custom-domain flow. Excluded from primary/canonical host selection so the
  // drive's pagespace.site subdomain stays the canonical SEO host.
  platformOwned: boolean('platform_owned').default(false).notNull(),
  // Per-domain overrides of the drive-wide published root (path '') and 404
  // page. Null means "use the drive default" — every domain on a drive is a
  // byte-for-byte identical mirror unless one of these is set (see
  // mirrorDriveToCustomHost). Distinct from drives.homePageId, which is the
  // in-app workspace landing page, not the public published site's.
  publishLandingPageId: text('publish_landing_page_id').references(() => pages.id, { onDelete: 'set null' }),
  publishNotFoundPageId: text('publish_not_found_page_id').references(() => pages.id, { onDelete: 'set null' }),
  // What this domain points at. NULL (the default, and today's only behavior) =
  // the drive's static published site. Set to a `published_apps.id` to route the
  // domain to that app instead. Nullability IS the discriminator — there is no
  // enum, because "static site" is not a third kind of target, it is the absence
  // of an app target. `onDelete: 'set null'` so unpublishing an app falls a
  // domain back to the static site rather than leaving it dangling or deleting
  // the domain: the domain is the user's, the app is not.
  publishedAppId: text('published_app_id').references(() => publishedApps.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  hostnameKey: uniqueIndex('custom_domains_hostname_key').on(table.hostname),
  driveIdx: index('custom_domains_drive_id_idx').on(table.driveId),
  publishedAppIdx: index('custom_domains_published_app_id_idx').on(table.publishedAppId),
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
  publishedApp: one(publishedApps, {
    fields: [customDomains.publishedAppId],
    references: [publishedApps.id],
  }),
}));

export type CustomDomain = typeof customDomains.$inferSelect;
export type NewCustomDomain = typeof customDomains.$inferInsert;
