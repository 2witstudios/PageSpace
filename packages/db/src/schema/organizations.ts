import { pgTable, text, timestamp, jsonb, pgEnum, index, uniqueIndex, unique, integer, boolean } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';

/**
 * Organizations — a drive owner that is not a person (Spec ORG, DRV).
 *
 * An org owns drives through `drives.orgId`; the human drive lead keeps the
 * Owner role on the drive. Deletes are deliberately conservative:
 *
 * - `organizations.ownerId` RESTRICTS the user delete: an Owner cannot delete
 *   their account while owning an org (ORG-6). Ownership transfers first.
 * - `drives.orgId` RESTRICTS the org delete (declared in core.ts): an org's
 *   drives are transferred to a person or trashed before the org goes, so
 *   nothing is orphaned (ORG-6). SET NULL would silently turn org drives into
 *   personal drives of whoever happened to be the lead.
 * - Membership and invitation rows cascade with the org; they mean nothing
 *   without it.
 */

// Timestamp columns here are `timestamp without time zone` holding UTC wall-clock; a bare
// now() default would resolve through the session TimeZone on a non-UTC database.
const utcNow = sql`(now() at time zone 'utc')`;

export const ORG_ROLES = ['OWNER', 'ADMIN', 'MEMBER'] as const;
export const orgRole = pgEnum('OrgRole', ORG_ROLES);
export type OrgRole = (typeof ORG_ROLES)[number];

export const organizations = pgTable('organizations', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  avatarUrl: text('avatarUrl'),
  ownerId: text('ownerId').notNull().references(() => users.id, { onDelete: 'restrict' }),
  // Org-wide policies (Spec POL). Shape is owned by the policy reader in lib;
  // the column only guarantees an object is always present.
  policies: jsonb('policies').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  stripeCustomerId: text('stripeCustomerId').unique(),
  stripeSubscriptionId: text('stripeSubscriptionId'),
  // SEAT-4: whether inviting past the purchased seat count raises the Stripe extra-seat quantity
  // (true) or is refused (false). A BILLING setting, not an access policy: it is deliberately not
  // in `policies`. Off by default, so nothing is ever bought without the Owner saying so.
  seatAutoAdd: boolean('seatAutoAdd').default(false).notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).default(utcNow).notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).default(utcNow).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  ownerIdx: index('organizations_owner_id_idx').on(table.ownerId),
}));

export const orgMembers = pgTable('org_members', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  orgId: text('orgId').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: orgRole('role').default('MEMBER').notNull(),
  invitedBy: text('invitedBy').references(() => users.id, { onDelete: 'set null' }),
  joinedAt: timestamp('joinedAt', { mode: 'date' }).default(utcNow).notNull(),
}, (table) => ({
  // Also serves orgId lookups (leading column), so no separate orgId index.
  orgUserKey: unique('org_members_org_user_key').on(table.orgId, table.userId),
  // ORG-1: an org has exactly one human Owner. At most one OWNER row per org; ownership
  // transfer demotes the old row and promotes the new one in one transaction, keeping it
  // equal to organizations.ownerId.
  oneOwnerKey: uniqueIndex('org_members_one_owner_key').on(table.orgId).where(sql`${table.role} = 'OWNER'`),
  userIdx: index('org_members_user_id_idx').on(table.userId),
}));

export const orgInvitations = pgTable('org_invitations', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  orgId: text('orgId').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: orgRole('role').default('MEMBER').notNull(),
  // Only the hash of the invite token is stored; the raw token lives in the email link.
  tokenHash: text('tokenHash').unique().notNull(),
  invitedBy: text('invitedBy').references(() => users.id, { onDelete: 'set null' }),
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
  acceptedAt: timestamp('acceptedAt', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).default(utcNow).notNull(),
}, (table) => ({
  // Email is matched case-insensitively everywhere, so lookups query lower(email).
  emailIdx: index('org_invitations_email_idx').on(sql`lower(${table.email})`),
  // One open invite per (org, email), case-insensitive: A@X and a@x are one inbox and one
  // pending seat (SEAT-3). An expression key rather than a CHECK email = lower(email): the
  // database dedupes whatever a caller writes instead of refusing an un-normalized write,
  // and the address keeps the casing the inviter typed. Resend rotates the open row;
  // revoke deletes it.
  openOrgEmailKey: uniqueIndex('org_invitations_open_org_email_key')
    .on(table.orgId, sql`lower(${table.email})`)
    .where(sql`${table.acceptedAt} IS NULL`),
}));

/**
 * The org's Business subscription (Spec SEAT-1, SEAT-8, A-8), one row per org. The
 * org's Stripe CUSTOMER stays on `organizations.stripeCustomerId` (the pool refill
 * finds the org by it); this row is the subscription and its two items: the base
 * price and the extra-seat price whose quantity is max(0, seats − 5).
 *
 * `orgId` RESTRICTS the org delete, like `drives.orgId`: deleting the org must end its
 * Stripe subscription first, or the row would vanish while Stripe keeps billing.
 * `extraSeatQuantity` is what Stripe was last set to; `seatRevision` counts applied
 * quantity changes and is part of each change's idempotency key.
 */
export const orgSubscriptions = pgTable('org_subscriptions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  orgId: text('orgId').notNull().unique().references(() => organizations.id, { onDelete: 'restrict' }),
  stripeSubscriptionId: text('stripeSubscriptionId').notNull().unique(),
  stripeBasePriceId: text('stripeBasePriceId').notNull(),
  stripeBaseItemId: text('stripeBaseItemId').notNull(),
  stripeSeatPriceId: text('stripeSeatPriceId').notNull(),
  stripeSeatItemId: text('stripeSeatItemId').notNull(),
  extraSeatQuantity: integer('extraSeatQuantity').default(0).notNull(),
  seatRevision: integer('seatRevision').default(0).notNull(),
  // Stripe's subscription status: trialing, active, past_due, canceled, unpaid, incomplete, …
  status: text('status').notNull(),
  trialEnd: timestamp('trialEnd', { mode: 'date' }),
  currentPeriodStart: timestamp('currentPeriodStart', { mode: 'date' }),
  currentPeriodEnd: timestamp('currentPeriodEnd', { mode: 'date' }),
  cancelAtPeriodEnd: boolean('cancelAtPeriodEnd').default(false).notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).default(utcNow).notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).default(utcNow).notNull().$onUpdate(() => new Date()),
});

export const organizationsRelations = relations(organizations, ({ one, many }) => ({
  owner: one(users, { fields: [organizations.ownerId], references: [users.id] }),
  members: many(orgMembers),
  invitations: many(orgInvitations),
  subscription: one(orgSubscriptions, { fields: [organizations.id], references: [orgSubscriptions.orgId] }),
}));

export const orgSubscriptionsRelations = relations(orgSubscriptions, ({ one }) => ({
  organization: one(organizations, { fields: [orgSubscriptions.orgId], references: [organizations.id] }),
}));

export const orgMembersRelations = relations(orgMembers, ({ one }) => ({
  organization: one(organizations, { fields: [orgMembers.orgId], references: [organizations.id] }),
  user: one(users, { fields: [orgMembers.userId], references: [users.id] }),
  inviter: one(users, { fields: [orgMembers.invitedBy], references: [users.id] }),
}));

export const orgInvitationsRelations = relations(orgInvitations, ({ one }) => ({
  organization: one(organizations, { fields: [orgInvitations.orgId], references: [organizations.id] }),
  inviter: one(users, { fields: [orgInvitations.invitedBy], references: [users.id] }),
}));

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type OrgMember = typeof orgMembers.$inferSelect;
export type NewOrgMember = typeof orgMembers.$inferInsert;
export type OrgInvitation = typeof orgInvitations.$inferSelect;
export type NewOrgInvitation = typeof orgInvitations.$inferInsert;
export type OrgSubscription = typeof orgSubscriptions.$inferSelect;
export type NewOrgSubscription = typeof orgSubscriptions.$inferInsert;
