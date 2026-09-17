import { pgTable, text, timestamp, jsonb, pgEnum, index, uniqueIndex, unique } from 'drizzle-orm/pg-core';
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
  emailIdx: index('org_invitations_email_idx').on(table.email),
  // One open invite per (org, email). Resend rotates the open row; revoke deletes it.
  // Callers normalize email before writing, as pending_invites does.
  openOrgEmailKey: uniqueIndex('org_invitations_open_org_email_key')
    .on(table.orgId, table.email)
    .where(sql`${table.acceptedAt} IS NULL`),
}));

export const organizationsRelations = relations(organizations, ({ one, many }) => ({
  owner: one(users, { fields: [organizations.ownerId], references: [users.id] }),
  members: many(orgMembers),
  invitations: many(orgInvitations),
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
