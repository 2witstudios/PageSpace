import { pgTable, text, timestamp, pgEnum, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { pages } from './core';
import { createId } from '@paralleldrive/cuid2';
export const permissionAction = pgEnum('PermissionAction', ['VIEW', 'EDIT', 'SHARE', 'DELETE']);
export const subjectType = pgEnum('SubjectType', ['USER']);
export const permissions = pgTable('permissions', {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    action: permissionAction('action').notNull(),
    subjectType: subjectType('subjectType').notNull(),
    subjectId: text('subjectId').notNull(),
    pageId: text('pageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
    return {
        pageIdx: index('permissions_page_id_idx').on(table.pageId),
        subjectIdx: index('permissions_subject_id_subject_type_idx').on(table.subjectId, table.subjectType),
        pageSubjectIdx: index('permissions_page_id_subject_id_subject_type_idx').on(table.pageId, table.subjectId, table.subjectType),
    };
});
export const permissionsRelations = relations(permissions, ({ one }) => ({
    page: one(pages, {
        fields: [permissions.pageId],
        references: [pages.id],
    }),
}));
// Note: pages.permissions relation would cause circular dependency, so handled through direct queries
//# sourceMappingURL=permissions.js.map