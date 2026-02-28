import { pgTable, text, timestamp, boolean, pgEnum, index, unique } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { createId } from '@paralleldrive/cuid2';

// Organization member roles
export const orgMemberRole = pgEnum('OrgMemberRole', ['OWNER', 'ADMIN', 'MEMBER']);

// Organizations
export const organizations = pgTable('organizations', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  ownerId: text('ownerId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  description: text('description'),
  avatarUrl: text('avatarUrl'),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => ({
  ownerIdx: index('organizations_owner_id_idx').on(table.ownerId),
  slugIdx: index('organizations_slug_idx').on(table.slug),
}));

// Organization members
export const orgMembers = pgTable('org_members', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  orgId: text('orgId').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: orgMemberRole('role').default('MEMBER').notNull(),
  invitedBy: text('invitedBy').references(() => users.id, { onDelete: 'set null' }),
  joinedAt: timestamp('joinedAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  orgUserKey: unique('org_members_org_user_key').on(table.orgId, table.userId),
  orgIdx: index('org_members_org_id_idx').on(table.orgId),
  userIdx: index('org_members_user_id_idx').on(table.userId),
  roleIdx: index('org_members_role_idx').on(table.role),
}));

// Organization invitations
export const orgInvitations = pgTable('org_invitations', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  orgId: text('orgId').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: orgMemberRole('role').default('MEMBER').notNull(),
  token: text('token').unique().notNull().$defaultFn(() => createId()),
  invitedBy: text('invitedBy').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
  acceptedAt: timestamp('acceptedAt', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  orgIdx: index('org_invitations_org_id_idx').on(table.orgId),
  emailIdx: index('org_invitations_email_idx').on(table.email),
  tokenIdx: index('org_invitations_token_idx').on(table.token),
  orgEmailKey: unique('org_invitations_org_email_key').on(table.orgId, table.email),
}));

// Relations
export const organizationsRelations = relations(organizations, ({ one, many }) => ({
  owner: one(users, {
    fields: [organizations.ownerId],
    references: [users.id],
  }),
  members: many(orgMembers),
  invitations: many(orgInvitations),
}));

export const orgMembersRelations = relations(orgMembers, ({ one }) => ({
  organization: one(organizations, {
    fields: [orgMembers.orgId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [orgMembers.userId],
    references: [users.id],
  }),
  invitedByUser: one(users, {
    fields: [orgMembers.invitedBy],
    references: [users.id],
  }),
}));

export const orgInvitationsRelations = relations(orgInvitations, ({ one }) => ({
  organization: one(organizations, {
    fields: [orgInvitations.orgId],
    references: [organizations.id],
  }),
  invitedByUser: one(users, {
    fields: [orgInvitations.invitedBy],
    references: [users.id],
  }),
}));
