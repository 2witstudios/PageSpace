import { pgTable, text, timestamp, bigint, integer, index, primaryKey, unique } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { drives, pages } from './core';
import { users } from './auth';
export const files = pgTable('files', {
    id: text('id').primaryKey(),
    driveId: text('driveId')
        .notNull()
        .references(() => drives.id, { onDelete: 'cascade' }),
    sizeBytes: bigint('sizeBytes', { mode: 'number' }).notNull(),
    mimeType: text('mimeType'),
    storagePath: text('storagePath'),
    checksumVersion: integer('checksumVersion').default(1).notNull(),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
    createdBy: text('createdBy').references(() => users.id, { onDelete: 'set null' }),
    lastAccessedAt: timestamp('lastAccessedAt', { mode: 'date' }),
}, (table) => ({
    driveIdx: index('files_drive_id_idx').on(table.driveId),
}));
export const filePages = pgTable('file_pages', {
    fileId: text('fileId')
        .notNull()
        .references(() => files.id, { onDelete: 'cascade' }),
    pageId: text('pageId')
        .notNull()
        .references(() => pages.id, { onDelete: 'cascade' }),
    linkedBy: text('linkedBy').references(() => users.id, { onDelete: 'set null' }),
    linkedAt: timestamp('linkedAt', { mode: 'date' }).defaultNow().notNull(),
    linkSource: text('linkSource'),
}, (table) => ({
    pk: primaryKey({ columns: [table.fileId, table.pageId] }),
    pageUnique: unique('file_pages_page_id_key').on(table.pageId),
    fileIdx: index('file_pages_file_id_idx').on(table.fileId),
    pageIdx: index('file_pages_page_id_idx').on(table.pageId),
}));
export const filesRelations = relations(files, ({ one, many }) => ({
    drive: one(drives, {
        fields: [files.driveId],
        references: [drives.id],
    }),
    creator: one(users, {
        fields: [files.createdBy],
        references: [users.id],
    }),
    filePages: many(filePages),
}));
export const filePagesRelations = relations(filePages, ({ one }) => ({
    file: one(files, {
        fields: [filePages.fileId],
        references: [files.id],
    }),
    page: one(pages, {
        fields: [filePages.pageId],
        references: [pages.id],
    }),
    linker: one(users, {
        fields: [filePages.linkedBy],
        references: [users.id],
    }),
}));
//# sourceMappingURL=storage.js.map