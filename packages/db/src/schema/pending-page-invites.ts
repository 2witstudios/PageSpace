import { pgTable, text, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { pages } from './core';

export type PendingPagePermission = 'VIEW' | 'EDIT' | 'SHARE';

// Off-platform invites can never grant DELETE: handing destructive authority
// to an unverified email address would be account-takeover bait. The schema
// stores the requested grant as an array of low-blast-radius actions; the
// route layer is the second line of defense via zod validation.
export const pendingPageInvites = pgTable('pending_page_invites', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  tokenHash: text('token_hash').unique().notNull(),
  email: text('email').notNull(),
  invitedBy: text('invited_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  pageId: text('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  permissions: jsonb('permissions').notNull().$type<PendingPagePermission[]>(),
  expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
  consumedAt: timestamp('consumed_at', { mode: 'date' }),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  pageIdx: index('pending_page_invites_page_id_idx').on(table.pageId),
  expiresAtIdx: index('pending_page_invites_expires_at_idx').on(table.expiresAt),
  activePageEmailIdx: uniqueIndex('pending_page_invites_active_page_email_idx')
    .on(table.pageId, table.email)
    .where(sql`${table.consumedAt} IS NULL`),
}));

export const pendingPageInvitesRelations = relations(pendingPageInvites, ({ one }) => ({
  page: one(pages, { fields: [pendingPageInvites.pageId], references: [pages.id] }),
  inviter: one(users, { fields: [pendingPageInvites.invitedBy], references: [users.id] }),
}));

export type PendingPageInvite = typeof pendingPageInvites.$inferSelect;
export type NewPendingPageInvite = typeof pendingPageInvites.$inferInsert;
