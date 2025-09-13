"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pagePermissionsRelations = exports.driveInvitationsRelations = exports.driveMembersRelations = exports.userProfilesRelations = exports.pagePermissions = exports.driveInvitations = exports.driveMembers = exports.userProfiles = exports.invitationStatus = exports.memberRole = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const drizzle_orm_1 = require("drizzle-orm");
const auth_1 = require("./auth");
const core_1 = require("./core");
const cuid2_1 = require("@paralleldrive/cuid2");
// Drive member roles
exports.memberRole = (0, pg_core_1.pgEnum)('MemberRole', ['OWNER', 'ADMIN', 'MEMBER']);
// Drive invitation status
exports.invitationStatus = (0, pg_core_1.pgEnum)('InvitationStatus', ['PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED']);
// User profiles for discovery
exports.userProfiles = (0, pg_core_1.pgTable)('user_profiles', {
    userId: (0, pg_core_1.text)('userId').primaryKey().references(() => auth_1.users.id, { onDelete: 'cascade' }),
    username: (0, pg_core_1.text)('username').notNull().unique(),
    displayName: (0, pg_core_1.text)('displayName').notNull(),
    bio: (0, pg_core_1.text)('bio'),
    avatarUrl: (0, pg_core_1.text)('avatarUrl'),
    isPublic: (0, pg_core_1.boolean)('isPublic').default(false).notNull(),
    createdAt: (0, pg_core_1.timestamp)('createdAt', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: (0, pg_core_1.timestamp)('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => {
    return {
        usernameIdx: (0, pg_core_1.index)('user_profiles_username_idx').on(table.username),
        isPublicIdx: (0, pg_core_1.index)('user_profiles_is_public_idx').on(table.isPublic),
    };
});
// Drive members - tracks all users with access to a drive
exports.driveMembers = (0, pg_core_1.pgTable)('drive_members', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    driveId: (0, pg_core_1.text)('driveId').notNull().references(() => core_1.drives.id, { onDelete: 'cascade' }),
    userId: (0, pg_core_1.text)('userId').notNull().references(() => auth_1.users.id, { onDelete: 'cascade' }),
    role: (0, exports.memberRole)('role').default('MEMBER').notNull(),
    invitedBy: (0, pg_core_1.text)('invitedBy').references(() => auth_1.users.id, { onDelete: 'set null' }),
    invitedAt: (0, pg_core_1.timestamp)('invitedAt', { mode: 'date' }).defaultNow().notNull(),
    acceptedAt: (0, pg_core_1.timestamp)('acceptedAt', { mode: 'date' }),
    lastAccessedAt: (0, pg_core_1.timestamp)('lastAccessedAt', { mode: 'date' }),
}, (table) => {
    return {
        driveUserKey: (0, pg_core_1.unique)('drive_members_drive_user_key').on(table.driveId, table.userId),
        driveIdx: (0, pg_core_1.index)('drive_members_drive_id_idx').on(table.driveId),
        userIdx: (0, pg_core_1.index)('drive_members_user_id_idx').on(table.userId),
        roleIdx: (0, pg_core_1.index)('drive_members_role_idx').on(table.role),
    };
});
// Drive invitations - pending invites
exports.driveInvitations = (0, pg_core_1.pgTable)('drive_invitations', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    driveId: (0, pg_core_1.text)('driveId').notNull().references(() => core_1.drives.id, { onDelete: 'cascade' }),
    email: (0, pg_core_1.text)('email').notNull(),
    userId: (0, pg_core_1.text)('userId').references(() => auth_1.users.id, { onDelete: 'cascade' }),
    invitedBy: (0, pg_core_1.text)('invitedBy').notNull().references(() => auth_1.users.id, { onDelete: 'cascade' }),
    status: (0, exports.invitationStatus)('status').default('PENDING').notNull(),
    token: (0, pg_core_1.text)('token').notNull().unique().$defaultFn(() => (0, cuid2_1.createId)()),
    message: (0, pg_core_1.text)('message'),
    expiresAt: (0, pg_core_1.timestamp)('expiresAt', { mode: 'date' }).notNull(),
    createdAt: (0, pg_core_1.timestamp)('createdAt', { mode: 'date' }).defaultNow().notNull(),
    respondedAt: (0, pg_core_1.timestamp)('respondedAt', { mode: 'date' }),
}, (table) => {
    return {
        driveIdx: (0, pg_core_1.index)('drive_invitations_drive_id_idx').on(table.driveId),
        emailIdx: (0, pg_core_1.index)('drive_invitations_email_idx').on(table.email),
        statusIdx: (0, pg_core_1.index)('drive_invitations_status_idx').on(table.status),
        tokenIdx: (0, pg_core_1.index)('drive_invitations_token_idx').on(table.token),
    };
});
// Enhanced permissions with boolean flags
exports.pagePermissions = (0, pg_core_1.pgTable)('page_permissions', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    pageId: (0, pg_core_1.text)('pageId').notNull().references(() => core_1.pages.id, { onDelete: 'cascade' }),
    userId: (0, pg_core_1.text)('userId').notNull().references(() => auth_1.users.id, { onDelete: 'cascade' }),
    canView: (0, pg_core_1.boolean)('canView').default(false).notNull(),
    canEdit: (0, pg_core_1.boolean)('canEdit').default(false).notNull(),
    canShare: (0, pg_core_1.boolean)('canShare').default(false).notNull(),
    canDelete: (0, pg_core_1.boolean)('canDelete').default(false).notNull(),
    grantedBy: (0, pg_core_1.text)('grantedBy').references(() => auth_1.users.id, { onDelete: 'set null' }),
    grantedAt: (0, pg_core_1.timestamp)('grantedAt', { mode: 'date' }).defaultNow().notNull(),
    expiresAt: (0, pg_core_1.timestamp)('expiresAt', { mode: 'date' }),
    note: (0, pg_core_1.text)('note'),
}, (table) => {
    return {
        pageUserKey: (0, pg_core_1.unique)('page_permissions_page_user_key').on(table.pageId, table.userId),
        pageIdx: (0, pg_core_1.index)('page_permissions_page_id_idx').on(table.pageId),
        userIdx: (0, pg_core_1.index)('page_permissions_user_id_idx').on(table.userId),
        expiresIdx: (0, pg_core_1.index)('page_permissions_expires_at_idx').on(table.expiresAt),
    };
});
// Relations
exports.userProfilesRelations = (0, drizzle_orm_1.relations)(exports.userProfiles, ({ one }) => ({
    user: one(auth_1.users, {
        fields: [exports.userProfiles.userId],
        references: [auth_1.users.id],
    }),
}));
exports.driveMembersRelations = (0, drizzle_orm_1.relations)(exports.driveMembers, ({ one }) => ({
    drive: one(core_1.drives, {
        fields: [exports.driveMembers.driveId],
        references: [core_1.drives.id],
    }),
    user: one(auth_1.users, {
        fields: [exports.driveMembers.userId],
        references: [auth_1.users.id],
    }),
    invitedByUser: one(auth_1.users, {
        fields: [exports.driveMembers.invitedBy],
        references: [auth_1.users.id],
    }),
}));
exports.driveInvitationsRelations = (0, drizzle_orm_1.relations)(exports.driveInvitations, ({ one }) => ({
    drive: one(core_1.drives, {
        fields: [exports.driveInvitations.driveId],
        references: [core_1.drives.id],
    }),
    user: one(auth_1.users, {
        fields: [exports.driveInvitations.userId],
        references: [auth_1.users.id],
    }),
    invitedByUser: one(auth_1.users, {
        fields: [exports.driveInvitations.invitedBy],
        references: [auth_1.users.id],
    }),
}));
exports.pagePermissionsRelations = (0, drizzle_orm_1.relations)(exports.pagePermissions, ({ one }) => ({
    page: one(core_1.pages, {
        fields: [exports.pagePermissions.pageId],
        references: [core_1.pages.id],
    }),
    user: one(auth_1.users, {
        fields: [exports.pagePermissions.userId],
        references: [auth_1.users.id],
    }),
    grantedByUser: one(auth_1.users, {
        fields: [exports.pagePermissions.grantedBy],
        references: [auth_1.users.id],
    }),
}));
