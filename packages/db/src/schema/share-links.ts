import { pgTable, text, timestamp, boolean, integer, jsonb, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { drives, pages } from './core';
import { memberRole } from './members';

export type ShareLinkPermission = 'VIEW' | 'EDIT';

export const driveShareLinks = pgTable('drive_share_links', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  driveId: text('drive_id').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  token: text('token').unique().notNull(),
  role: memberRole('role').notNull().default('MEMBER'),
  createdBy: text('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { mode: 'date' }),
  isActive: boolean('is_active').notNull().default(true),
  useCount: integer('use_count').notNull().default(0),
}, (table) => ({
  driveIdx: index('drive_share_links_drive_id_idx').on(table.driveId),
  expiresAtIdx: index('drive_share_links_expires_at_idx').on(table.expiresAt),
  activeIdx: index('drive_share_links_is_active_idx').on(table.isActive),
}));

export const driveShareLinksRelations = relations(driveShareLinks, ({ one }) => ({
  drive: one(drives, { fields: [driveShareLinks.driveId], references: [drives.id] }),
  creator: one(users, { fields: [driveShareLinks.createdBy], references: [users.id] }),
}));

export type DriveShareLink = typeof driveShareLinks.$inferSelect;
export type NewDriveShareLink = typeof driveShareLinks.$inferInsert;

export const pageShareLinks = pgTable('page_share_links', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  pageId: text('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  token: text('token').unique().notNull(),
  permissions: jsonb('permissions').notNull().$type<ShareLinkPermission[]>(),
  createdBy: text('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { mode: 'date' }),
  isActive: boolean('is_active').notNull().default(true),
  useCount: integer('use_count').notNull().default(0),
}, (table) => ({
  pageIdx: index('page_share_links_page_id_idx').on(table.pageId),
  expiresAtIdx: index('page_share_links_expires_at_idx').on(table.expiresAt),
  activeIdx: index('page_share_links_is_active_idx').on(table.isActive),
}));

export const pageShareLinksRelations = relations(pageShareLinks, ({ one }) => ({
  page: one(pages, { fields: [pageShareLinks.pageId], references: [pages.id] }),
  creator: one(users, { fields: [pageShareLinks.createdBy], references: [users.id] }),
}));

export type PageShareLink = typeof pageShareLinks.$inferSelect;
export type NewPageShareLink = typeof pageShareLinks.$inferInsert;
