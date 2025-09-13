"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.permissionsRelations = exports.permissions = exports.subjectType = exports.permissionAction = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const drizzle_orm_1 = require("drizzle-orm");
const core_1 = require("./core");
const cuid2_1 = require("@paralleldrive/cuid2");
exports.permissionAction = (0, pg_core_1.pgEnum)('PermissionAction', ['VIEW', 'EDIT', 'SHARE', 'DELETE']);
exports.subjectType = (0, pg_core_1.pgEnum)('SubjectType', ['USER']);
exports.permissions = (0, pg_core_1.pgTable)('permissions', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    action: (0, exports.permissionAction)('action').notNull(),
    subjectType: (0, exports.subjectType)('subjectType').notNull(),
    subjectId: (0, pg_core_1.text)('subjectId').notNull(),
    pageId: (0, pg_core_1.text)('pageId').notNull().references(() => core_1.pages.id, { onDelete: 'cascade' }),
    createdAt: (0, pg_core_1.timestamp)('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
    return {
        pageIdx: (0, pg_core_1.index)('permissions_page_id_idx').on(table.pageId),
        subjectIdx: (0, pg_core_1.index)('permissions_subject_id_subject_type_idx').on(table.subjectId, table.subjectType),
        pageSubjectIdx: (0, pg_core_1.index)('permissions_page_id_subject_id_subject_type_idx').on(table.pageId, table.subjectId, table.subjectType),
    };
});
exports.permissionsRelations = (0, drizzle_orm_1.relations)(exports.permissions, ({ one }) => ({
    page: one(core_1.pages, {
        fields: [exports.permissions.pageId],
        references: [core_1.pages.id],
    }),
}));
// Note: pages.permissions relation would cause circular dependency, so handled through direct queries
