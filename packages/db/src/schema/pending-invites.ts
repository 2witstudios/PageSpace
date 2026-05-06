import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql, relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { drives } from './core';
import { memberRole } from './members';

// Email is stored lowercased by the repository layer so the partial unique
// index below behaves case-insensitively without needing a functional index.
export const pendingInvites = pgTable('pending_invites', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  tokenHash: text('tokenHash').unique().notNull(),
  email: text('email').notNull(),
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  role: memberRole('role').default('MEMBER').notNull(),
  invitedBy: text('invitedBy').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
  consumedAt: timestamp('consumedAt', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
  return {
    driveIdx: index('pending_invites_drive_id_idx').on(table.driveId),
    emailIdx: index('pending_invites_email_idx').on(table.email),
    expiresAtIdx: index('pending_invites_expires_at_idx').on(table.expiresAt),
    activeUniqueIdx: uniqueIndex('pending_invites_drive_email_active_unique')
      .on(table.driveId, table.email)
      .where(sql`${table.consumedAt} IS NULL`),
  };
});

export const pendingInvitesRelations = relations(pendingInvites, ({ one }) => ({
  drive: one(drives, {
    fields: [pendingInvites.driveId],
    references: [drives.id],
  }),
  invitedByUser: one(users, {
    fields: [pendingInvites.invitedBy],
    references: [users.id],
  }),
}));
