import { pgTable, text, timestamp, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { drives } from './core';

/**
 * A member's request to join a RESTRICTED org drive (Spec DRV-6, D-OW-22).
 *
 * Deliberately NOT a drive_members row: a pending drive_members row is one upsert away from
 * access (a share-link redemption stamps acceptedAt onto any existing (drive, user) row), so a
 * request lives here and grants nothing. Only the approval service action creates membership
 * from a request, through the org membership sync.
 *
 * - `pending`   awaiting the drive lead or an org Owner/Admin.
 * - `approved`  the approver admitted the requester (the drive_members row is theirs now).
 * - `denied`    refused; the requester may ask again.
 * - `withdrawn` the requester took it back; they may ask again.
 *
 * At most one PENDING request per (drive, user), enforced by a partial unique index (the same
 * shape as org_members_one_owner_key), so a repeated request is idempotent and a decided one can
 * be followed by a new one.
 */

// Timestamp columns hold UTC wall-clock; a bare now() default would follow the session TimeZone.
const utcNow = sql`(now() at time zone 'utc')`;

export const DRIVE_JOIN_REQUEST_STATUSES = ['pending', 'approved', 'denied', 'withdrawn'] as const;
export const driveJoinRequestStatus = pgEnum('DriveJoinRequestStatus', DRIVE_JOIN_REQUEST_STATUSES);
export type DriveJoinRequestStatus = (typeof DRIVE_JOIN_REQUEST_STATUSES)[number];

export const driveJoinRequests = pgTable('drive_join_requests', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: driveJoinRequestStatus('status').default('pending').notNull(),
  /** Optional note from the requester to the approver. */
  message: text('message'),
  requestedAt: timestamp('requestedAt', { mode: 'date' }).default(utcNow).notNull(),
  decidedAt: timestamp('decidedAt', { mode: 'date' }),
  /** Who approved or denied; null while pending, after a withdrawal, or once that user is deleted. */
  decidedBy: text('decidedBy').references(() => users.id, { onDelete: 'set null' }),
}, (table) => ({
  onePendingKey: uniqueIndex('drive_join_requests_one_pending_key')
    .on(table.driveId, table.userId)
    .where(sql`${table.status} = 'pending'`),
  driveStatusIdx: index('drive_join_requests_drive_status_idx').on(table.driveId, table.status),
  userIdx: index('drive_join_requests_user_id_idx').on(table.userId),
}));

export const driveJoinRequestsRelations = relations(driveJoinRequests, ({ one }) => ({
  drive: one(drives, { fields: [driveJoinRequests.driveId], references: [drives.id] }),
  user: one(users, { fields: [driveJoinRequests.userId], references: [users.id] }),
  decider: one(users, { fields: [driveJoinRequests.decidedBy], references: [users.id] }),
}));

export type DriveJoinRequest = typeof driveJoinRequests.$inferSelect;
export type NewDriveJoinRequest = typeof driveJoinRequests.$inferInsert;
