import { pgTable, text, timestamp, jsonb, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { drives } from './core';
import { organizations } from './organizations';

// Timestamp columns here are `timestamp without time zone` holding UTC wall-clock (see organizations.ts).
const utcNow = sql`(now() at time zone 'utc')`;

/**
 * Guests held by the org's guests policy (Spec POL-1, POL-2). One table, two states:
 *
 * - `pending_approval` — the policy is `approve` and an outsider was invited or redeemed a link: nothing is
 *   granted, the request waits here for an Owner or Admin. `request` is what was asked (role, custom role, page
 *   grants, link) so approving replays exactly that.
 * - `suspended` — the policy went `off` and an outsider already held access: their drive_members row and page
 *   grants are PARKED here (`parked`, a full snapshot) and removed from the live tables, so every reader of those
 *   tables sees no access without a single extra condition. Restoring re-inserts the snapshot. Nothing is lost.
 *
 * `userId` is null only for an invitee who has no account yet (`email` is set instead).
 */
// `approved`: an Owner or Admin approved an outsider's EMAILED invitation (drive or page) and it was sent; the
// invitation's acceptance consumes this row instead of asking for approval again (Review 3+4 on #2762, P2-6). Text
// column: no DDL.
export const GUEST_HOLD_STATES = ['pending_approval', 'suspended', 'approved'] as const;
export type GuestHoldState = (typeof GUEST_HOLD_STATES)[number];
// `page_invite`: a page share-invite by email to an address with no verified account; `page_grant`: a direct page
// grant (the page Share dialog, or a share-invite to an existing account) — queued, or parked when that grant was
// the person's only access to the drive.
export const GUEST_HOLD_ORIGINS = ['invite', 'drive_link', 'page_link', 'page_invite', 'page_grant'] as const;
export type GuestHoldOrigin = (typeof GUEST_HOLD_ORIGINS)[number];

export interface GuestHoldRequest {
  role?: 'MEMBER' | 'ADMIN';
  customRoleId?: string | null;
  permissions?: Array<{ pageId: string; canView: boolean; canEdit: boolean; canShare: boolean; canDelete?: boolean }>;
  /** Explicit-role MCP token scopes the outsider's tokens held on the drive, replayed on approval. */
  tokenScopes?: Array<Record<string, unknown>>;
  /**
   * A `page_grant` request made from access the person ALREADY held (a drive moved into the org, pages moved into
   * an org drive, a former member's rows): their drive_members row as it was, replayed with the grants on approval.
   */
  member?: Record<string, unknown> | null;
  expiryDays?: number | null;
  linkId?: string;
  pageId?: string;
  invitedBy?: string;
}

export interface GuestHoldParked {
  member: Record<string, unknown> | null;
  grants: Array<Record<string, unknown>>;
  /** Explicit-role MCP token scopes (mcp_token_drives rows with a role) of tokens the outsider owns. */
  tokenScopes?: Array<Record<string, unknown>>;
}

export const orgGuestHolds = pgTable('org_guest_holds', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  orgId: text('orgId').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  userId: text('userId').references(() => users.id, { onDelete: 'cascade' }),
  email: text('email'),
  state: text('state').$type<GuestHoldState>().notNull(),
  origin: text('origin').$type<GuestHoldOrigin>().notNull(),
  request: jsonb('request').$type<GuestHoldRequest>().default(sql`'{}'::jsonb`).notNull(),
  parked: jsonb('parked').$type<GuestHoldParked>(),
  requestedBy: text('requestedBy').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).default(utcNow).notNull(),
}, (table) => ({
  orgStateIdx: index('org_guest_holds_org_state_idx').on(table.orgId, table.state),
  driveIdx: index('org_guest_holds_drive_id_idx').on(table.driveId),
  userIdx: index('org_guest_holds_user_id_idx').on(table.userId),
  // One open hold per person per drive and state: a repeat request refreshes the row, never queues twice.
  userDriveStateKey: uniqueIndex('org_guest_holds_user_drive_state_key').on(table.driveId, table.userId, table.state).where(sql`${table.userId} IS NOT NULL`),
  emailDriveStateKey: uniqueIndex('org_guest_holds_email_drive_state_key').on(table.driveId, sql`lower(${table.email})`, table.state).where(sql`${table.userId} IS NULL AND ${table.email} IS NOT NULL`),
  shape: check('org_guest_holds_shape', sql`(${table.userId} IS NOT NULL) <> (${table.email} IS NOT NULL) AND (${table.state} <> 'suspended' OR ${table.userId} IS NOT NULL)`),
}));


export type OrgGuestHold = typeof orgGuestHolds.$inferSelect;
export type NewOrgGuestHold = typeof orgGuestHolds.$inferInsert;
