"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notificationsRelations = exports.notifications = exports.notificationType = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const drizzle_orm_1 = require("drizzle-orm");
const auth_1 = require("./auth");
const core_1 = require("./core");
const core_2 = require("./core");
const cuid2_1 = require("@paralleldrive/cuid2");
exports.notificationType = (0, pg_core_1.pgEnum)('NotificationType', [
    'PERMISSION_GRANTED',
    'PERMISSION_REVOKED',
    'PERMISSION_UPDATED',
    'PAGE_SHARED',
    'DRIVE_INVITED',
    'DRIVE_JOINED',
    'DRIVE_ROLE_CHANGED'
]);
exports.notifications = (0, pg_core_1.pgTable)('notifications', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    userId: (0, pg_core_1.text)('userId').notNull().references(() => auth_1.users.id, { onDelete: 'cascade' }),
    type: (0, exports.notificationType)('type').notNull(),
    title: (0, pg_core_1.text)('title').notNull(),
    message: (0, pg_core_1.text)('message').notNull(),
    metadata: (0, pg_core_1.jsonb)('metadata'),
    isRead: (0, pg_core_1.boolean)('isRead').default(false).notNull(),
    createdAt: (0, pg_core_1.timestamp)('createdAt', { mode: 'date' }).defaultNow().notNull(),
    readAt: (0, pg_core_1.timestamp)('readAt', { mode: 'date' }),
    // Optional references to related entities
    pageId: (0, pg_core_1.text)('pageId').references(() => core_1.pages.id, { onDelete: 'cascade' }),
    driveId: (0, pg_core_1.text)('driveId').references(() => core_2.drives.id, { onDelete: 'cascade' }),
    triggeredByUserId: (0, pg_core_1.text)('triggeredByUserId').references(() => auth_1.users.id, { onDelete: 'set null' }),
}, (table) => {
    return {
        userIdx: (0, pg_core_1.index)('notifications_user_id_idx').on(table.userId),
        userIsReadIdx: (0, pg_core_1.index)('notifications_user_id_is_read_idx').on(table.userId, table.isRead),
        createdAtIdx: (0, pg_core_1.index)('notifications_created_at_idx').on(table.createdAt),
        typeIdx: (0, pg_core_1.index)('notifications_type_idx').on(table.type),
    };
});
exports.notificationsRelations = (0, drizzle_orm_1.relations)(exports.notifications, ({ one }) => ({
    user: one(auth_1.users, {
        fields: [exports.notifications.userId],
        references: [auth_1.users.id],
    }),
    page: one(core_1.pages, {
        fields: [exports.notifications.pageId],
        references: [core_1.pages.id],
    }),
    drive: one(core_2.drives, {
        fields: [exports.notifications.driveId],
        references: [core_2.drives.id],
    }),
    triggeredByUser: one(auth_1.users, {
        fields: [exports.notifications.triggeredByUserId],
        references: [auth_1.users.id],
    }),
}));
