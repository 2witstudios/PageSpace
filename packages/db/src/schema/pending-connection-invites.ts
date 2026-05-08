import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';

export const pendingConnectionInvites = pgTable('pending_connection_invites', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  tokenHash: text('token_hash').unique().notNull(),
  email: text('email').notNull(),
  invitedBy: text('invited_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  requestMessage: text('request_message'),
  expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
  consumedAt: timestamp('consumed_at', { mode: 'date' }),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  invitedByIdx: index('pending_connection_invites_invited_by_idx').on(table.invitedBy),
  emailIdx: index('pending_connection_invites_email_idx').on(table.email),
  expiresAtIdx: index('pending_connection_invites_expires_at_idx').on(table.expiresAt),
  activeInviterEmailIdx: uniqueIndex('pending_connection_invites_active_inviter_email_idx')
    .on(table.invitedBy, table.email)
    .where(sql`${table.consumedAt} IS NULL`),
}));

export const pendingConnectionInvitesRelations = relations(pendingConnectionInvites, ({ one }) => ({
  inviter: one(users, { fields: [pendingConnectionInvites.invitedBy], references: [users.id] }),
}));

export type PendingConnectionInvite = typeof pendingConnectionInvites.$inferSelect;
export type NewPendingConnectionInvite = typeof pendingConnectionInvites.$inferInsert;
