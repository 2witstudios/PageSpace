"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.userDashboardsRelations = exports.userDashboards = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const drizzle_orm_1 = require("drizzle-orm");
const auth_1 = require("./auth");
const cuid2_1 = require("@paralleldrive/cuid2");
// --- User Dashboard Layout ---
exports.userDashboards = (0, pg_core_1.pgTable)('user_dashboards', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    userId: (0, pg_core_1.text)('userId').notNull().unique().references(() => auth_1.users.id, { onDelete: 'cascade' }),
    content: (0, pg_core_1.text)('content').default('').notNull(),
    createdAt: (0, pg_core_1.timestamp)('createdAt', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: (0, pg_core_1.timestamp)('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
});
exports.userDashboardsRelations = (0, drizzle_orm_1.relations)(exports.userDashboards, ({ one }) => ({
    user: one(auth_1.users, {
        fields: [exports.userDashboards.userId],
        references: [auth_1.users.id],
    }),
}));
