import { pgTable, text, timestamp, boolean, jsonb, index, bigint, integer, pgEnum, unique } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { drives } from './core';
import { createId } from '@paralleldrive/cuid2';

export const orgRole = pgEnum('OrgRole', ['OWNER', 'ADMIN', 'MEMBER']);

export const organizations = pgTable('organizations', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull(),
  slug: text('slug').unique().notNull(),
  ownerId: text('ownerId').notNull().references(() => users.id, { onDelete: 'restrict' }),

  // Guardrail settings
  allowedAIProviders: jsonb('allowedAIProviders').$type<string[]>(),
  maxStorageBytes: bigint('maxStorageBytes', { mode: 'number' }),
  maxAITokensPerDay: integer('maxAITokensPerDay'),
  requireMFA: boolean('requireMFA').default(false).notNull(),
  allowExternalSharing: boolean('allowExternalSharing').default(true).notNull(),
  allowedDomains: jsonb('allowedDomains').$type<string[]>(),

  // Billing
  stripeCustomerId: text('stripeCustomerId').unique(),
  billingTier: text('billingTier').default('free').notNull(), // 'free' | 'pro' | 'business' | 'enterprise'
  billingEmail: text('billingEmail'),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => ({
  ownerIdx: index('organizations_owner_id_idx').on(table.ownerId),
  slugIdx: index('organizations_slug_idx').on(table.slug),
}));

export const orgMembers = pgTable('org_members', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  orgId: text('orgId').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: orgRole('role').default('MEMBER').notNull(),
  invitedBy: text('invitedBy').references(() => users.id, { onDelete: 'set null' }),
  invitedAt: timestamp('invitedAt', { mode: 'date' }).defaultNow().notNull(),
  acceptedAt: timestamp('acceptedAt', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  orgUserKey: unique('org_members_org_user_key').on(table.orgId, table.userId),
  orgIdx: index('org_members_org_id_idx').on(table.orgId),
  userIdx: index('org_members_user_id_idx').on(table.userId),
}));

// Link drives to organizations (optional - drives can exist without an org)
export const orgDrives = pgTable('org_drives', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  orgId: text('orgId').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  orgDriveKey: unique('org_drives_org_drive_key').on(table.orgId, table.driveId),
  orgIdx: index('org_drives_org_id_idx').on(table.orgId),
  driveIdx: index('org_drives_drive_id_idx').on(table.driveId),
}));

// Org subscriptions (separate from individual user subscriptions)
export const orgSubscriptions = pgTable('org_subscriptions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  orgId: text('orgId').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  stripeSubscriptionId: text('stripeSubscriptionId').unique().notNull(),
  stripePriceId: text('stripePriceId').notNull(),
  status: text('status').notNull(), // active, trialing, past_due, canceled, unpaid
  quantity: integer('quantity').default(1).notNull(), // seat count
  currentPeriodStart: timestamp('currentPeriodStart', { mode: 'date' }).notNull(),
  currentPeriodEnd: timestamp('currentPeriodEnd', { mode: 'date' }).notNull(),
  cancelAtPeriodEnd: boolean('cancelAtPeriodEnd').default(false).notNull(),
  // Grace period for seat removal
  gracePeriodEnd: timestamp('gracePeriodEnd', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => ({
  orgIdx: index('org_subscriptions_org_id_idx').on(table.orgId),
  stripeSubIdx: index('org_subscriptions_stripe_sub_id_idx').on(table.stripeSubscriptionId),
}));

// Relations
export const organizationsRelations = relations(organizations, ({ one, many }) => ({
  owner: one(users, {
    fields: [organizations.ownerId],
    references: [users.id],
  }),
  members: many(orgMembers),
  drives: many(orgDrives),
  subscriptions: many(orgSubscriptions),
}));

export const orgMembersRelations = relations(orgMembers, ({ one }) => ({
  org: one(organizations, {
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

export const orgDrivesRelations = relations(orgDrives, ({ one }) => ({
  org: one(organizations, {
    fields: [orgDrives.orgId],
    references: [organizations.id],
  }),
  drive: one(drives, {
    fields: [orgDrives.driveId],
    references: [drives.id],
  }),
}));

export const orgSubscriptionsRelations = relations(orgSubscriptions, ({ one }) => ({
  org: one(organizations, {
    fields: [orgSubscriptions.orgId],
    references: [organizations.id],
  }),
}));
