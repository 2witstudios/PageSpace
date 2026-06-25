import { pgTable, text, timestamp, boolean, index, unique } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { drives, pages } from './core';

export const publishedPages = pgTable('published_pages', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  driveId: text('drive_id').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  pageId: text('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  artifactKey: text('artifact_key').notNull(),
  // Author-facing per-page SEO overrides (nullable; absence = derive/inherit).
  publishTitle: text('publish_title'),
  publishDescription: text('publish_description'),
  publishOgImageUrl: text('publish_og_image_url'),
  // When true, the page emits robots=noindex and is excluded from the sitemap.
  noindex: boolean('noindex').default(false).notNull(),
  publishedBy: text('published_by').references(() => users.id, { onDelete: 'set null' }),
  publishedAt: timestamp('published_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  pageKey: unique('published_pages_page_id_key').on(table.pageId),
  drivePathKey: unique('published_pages_drive_id_path_key').on(table.driveId, table.path),
  driveIdx: index('published_pages_drive_id_idx').on(table.driveId),
  pageIdx: index('published_pages_page_id_idx').on(table.pageId),
}));

export const publishedPagesRelations = relations(publishedPages, ({ one }) => ({
  drive: one(drives, { fields: [publishedPages.driveId], references: [drives.id] }),
  page: one(pages, { fields: [publishedPages.pageId], references: [pages.id] }),
  publisher: one(users, { fields: [publishedPages.publishedBy], references: [users.id] }),
}));

export type PublishedPage = typeof publishedPages.$inferSelect;
export type NewPublishedPage = typeof publishedPages.$inferInsert;
