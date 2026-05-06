import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { drives } from './core';
import { memberRole } from './members';

export const pendingInvites = pgTable('pending_invites', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  tokenHash: text('token_hash').unique().notNull(),
  email: text('email').notNull(),
  driveId: text('drive_id').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  role: memberRole('role').notNull(),
  invitedBy: text('invited_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
  consumedAt: timestamp('consumed_at', { mode: 'date' }),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  // Note: token_hash already has an implicit unique B-tree index from
  // its UNIQUE constraint, so no explicit index is needed for lookup.
  driveIdx: index('pending_invites_drive_id_idx').on(table.driveId),
  expiresAtIdx: index('pending_invites_expires_at_idx').on(table.expiresAt),
  activeDriveEmailIdx: uniqueIndex('pending_invites_active_drive_email_idx')
    .on(table.driveId, table.email)
    .where(sql`${table.consumedAt} IS NULL`),
}));

export const pendingInvitesRelations = relations(pendingInvites, ({ one }) => ({
  drive: one(drives, { fields: [pendingInvites.driveId], references: [drives.id] }),
  inviter: one(users, { fields: [pendingInvites.invitedBy], references: [users.id] }),
}));

export type PendingInvite = typeof pendingInvites.$inferSelect;
export type NewPendingInvite = typeof pendingInvites.$inferInsert;
