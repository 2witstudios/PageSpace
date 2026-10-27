import { pgTable, text, timestamp, boolean, primaryKey, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { drives } from './core';

/**
 * A user's stored Imago choice for one drive (the per-drive toggle).
 *
 * The row is purely the user's own exclusion: with `enabled = false`, the
 * user's Imago is kept out of that drive even though the user can open it.
 * With no row, or a row that is on, Imago may work there — it defaults to on
 * in every drive the user can access (superseding DEC-2's grant model; no
 * grant paths read this row). Each user sets only their own rows, in any
 * drive they can access.
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
