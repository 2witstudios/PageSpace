import { pgTable, text, timestamp, boolean, pgEnum, index, unique, integer, jsonb } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { drives, pages } from './core';
import { createId } from '@paralleldrive/cuid2';

// Drive member roles
export const memberRole = pgEnum('MemberRole', ['OWNER', 'ADMIN', 'MEMBER']);

// Drive invitation status
export const invitationStatus = pgEnum('InvitationStatus', ['PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED']);

// Custom roles for permission templates
export const driveRoles = pgTable('drive_roles', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  color: text('color'), // For badge display (e.g., "blue", "green", "#ff0000")
  isDefault: boolean('isDefault').default(false).notNull(),
  permissions: jsonb('permissions').notNull().$type<
    Record<string, { canView: boolean; canEdit: boolean; canShare: boolean }>
  >(),
  position: integer('position').default(0).notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    driveNameKey: unique('drive_roles_drive_name_key').on(table.driveId, table.name),
    driveIdx: index('drive_roles_drive_id_idx').on(table.driveId),
    positionIdx: index('drive_roles_position_idx').on(table.position),
  }
});

// User profiles for discovery
export const userProfiles = pgTable('user_profiles', {
  userId: text('userId').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  username: text('username'), // Made optional, no longer unique
  displayName: text('displayName').notNull(),
  bio: text('bio'),
  avatarUrl: text('avatarUrl'),
  isPublic: boolean('isPublic').default(false).notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    isPublicIdx: index('user_profiles_is_public_idx').on(table.isPublic),
  }
});

// Drive members - tracks all users with access to a drive
export const driveMembers = pgTable('drive_members', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: memberRole('role').default('MEMBER').notNull(),
  customRoleId: text('customRoleId').references(() => driveRoles.id, { onDelete: 'set null' }),
  invitedBy: text('invitedBy').references(() => users.id, { onDelete: 'set null' }),
  invitedAt: timestamp('invitedAt', { mode: 'date' }).defaultNow().notNull(),
  acceptedAt: timestamp('acceptedAt', { mode: 'date' }),
  lastAccessedAt: timestamp('lastAccessedAt', { mode: 'date' }),
}, (table) => {
  return {
    driveUserKey: unique('drive_members_drive_user_key').on(table.driveId, table.userId),
    driveIdx: index('drive_members_drive_id_idx').on(table.driveId),
    userIdx: index('drive_members_user_id_idx').on(table.userId),
    roleIdx: index('drive_members_role_idx').on(table.role),
    customRoleIdx: index('drive_members_custom_role_id_idx').on(table.customRoleId),
  }
});

// Drive invitations - pending invites
export const driveInvitations = pgTable('drive_invitations', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  userId: text('userId').references(() => users.id, { onDelete: 'cascade' }),
  invitedBy: text('invitedBy').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: invitationStatus('status').default('PENDING').notNull(),
  token: text('token').notNull().unique().$defaultFn(() => createId()),
  message: text('message'),
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  respondedAt: timestamp('respondedAt', { mode: 'date' }),
}, (table) => {
  return {
    driveIdx: index('drive_invitations_drive_id_idx').on(table.driveId),
    emailIdx: index('drive_invitations_email_idx').on(table.email),
    statusIdx: index('drive_invitations_status_idx').on(table.status),
    tokenIdx: index('drive_invitations_token_idx').on(table.token),
  }
});

// Enhanced permissions with boolean flags
export const pagePermissions = pgTable('page_permissions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  pageId: text('pageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  canView: boolean('canView').default(false).notNull(),
  canEdit: boolean('canEdit').default(false).notNull(),
  canShare: boolean('canShare').default(false).notNull(),
  canDelete: boolean('canDelete').default(false).notNull(),
  grantedBy: text('grantedBy').references(() => users.id, { onDelete: 'set null' }),
  grantedAt: timestamp('grantedAt', { mode: 'date' }).defaultNow().notNull(),
  expiresAt: timestamp('expiresAt', { mode: 'date' }),
  note: text('note'),
}, (table) => {
  return {
    pageUserKey: unique('page_permissions_page_user_key').on(table.pageId, table.userId),
    pageIdx: index('page_permissions_page_id_idx').on(table.pageId),
    userIdx: index('page_permissions_user_id_idx').on(table.userId),
    expiresIdx: index('page_permissions_expires_at_idx').on(table.expiresAt),
  }
});

// Relations
export const driveRolesRelations = relations(driveRoles, ({ one, many }) => ({
  drive: one(drives, {
    fields: [driveRoles.driveId],
    references: [drives.id],
  }),
  members: many(driveMembers),
}));

export const userProfilesRelations = relations(userProfiles, ({ one }) => ({
  user: one(users, {
    fields: [userProfiles.userId],
    references: [users.id],
  }),
}));

export const driveMembersRelations = relations(driveMembers, ({ one }) => ({
  drive: one(drives, {
    fields: [driveMembers.driveId],
    references: [drives.id],
  }),
  user: one(users, {
    fields: [driveMembers.userId],
    references: [users.id],
  }),
  customRole: one(driveRoles, {
    fields: [driveMembers.customRoleId],
    references: [driveRoles.id],
  }),
  invitedByUser: one(users, {
    fields: [driveMembers.invitedBy],
    references: [users.id],
  }),
}));

export const driveInvitationsRelations = relations(driveInvitations, ({ one }) => ({
  drive: one(drives, {
    fields: [driveInvitations.driveId],
    references: [drives.id],
  }),
  user: one(users, {
    fields: [driveInvitations.userId],
    references: [users.id],
  }),
  invitedByUser: one(users, {
    fields: [driveInvitations.invitedBy],
    references: [users.id],
  }),
}));

export const pagePermissionsRelations = relations(pagePermissions, ({ one }) => ({
  page: one(pages, {
    fields: [pagePermissions.pageId],
    references: [pages.id],
  }),
  user: one(users, {
    fields: [pagePermissions.userId],
    references: [users.id],
  }),
  grantedByUser: one(users, {
    fields: [pagePermissions.grantedBy],
    references: [users.id],
  }),
}));