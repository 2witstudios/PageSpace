import { pgTable, text, timestamp, boolean, primaryKey, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { drives } from './core';

/**
 * A user's stored Imago access choice for one drive (the per-drive toggle).
 *
 * Whether a user's Imago agents belong in a drive is the user's decision, and
 * it outlives the agent pages: an agent page can be trashed, emptied from the
 * trash and recreated, so the memberships alone cannot remember it. Every grant
 * path reads this row. With no row, Imago is on in a STANDARD drive the user
 * owns (the DEC-2 default) and off everywhere else; a row overrides that —
 * `enabled = false` is an opt-out, `enabled = true` turns Imago on in a drive
 * the user administers but does not own.
 *
 * Both FKs cascade: the choice goes with the user and with the drive.
 */
export const imagoDriveAccess = pgTable('imago_drive_access', {
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.driveId] }),
  driveIdx: index('imago_drive_access_drive_idx').on(table.driveId),
}));

export const imagoDriveAccessRelations = relations(imagoDriveAccess, ({ one }) => ({
  user: one(users, {
    fields: [imagoDriveAccess.userId],
    references: [users.id],
  }),
  drive: one(drives, {
    fields: [imagoDriveAccess.driveId],
    references: [drives.id],
  }),
}));

export type ImagoDriveAccess = typeof imagoDriveAccess.$inferSelect;
export type NewImagoDriveAccess = typeof imagoDriveAccess.$inferInsert;
