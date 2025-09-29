import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { createId } from '@paralleldrive/cuid2';
// --- User Dashboard Layout ---
export const userDashboards = pgTable('user_dashboards', {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    userId: text('userId').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
    content: text('content').default('').notNull(),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
});
export const userDashboardsRelations = relations(userDashboards, ({ one }) => ({
    user: one(users, {
        fields: [userDashboards.userId],
        references: [users.id],
    }),
}));
//# sourceMappingURL=dashboard.js.map