"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mentionsRelations = exports.favoritesRelations = exports.pageTagsRelations = exports.tagsRelations = exports.chatMessagesRelations = exports.pagesRelations = exports.drivesRelations = exports.mentions = exports.favorites = exports.storageEvents = exports.pageTags = exports.tags = exports.chatMessages = exports.pages = exports.drives = exports.pageType = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
const drizzle_orm_1 = require("drizzle-orm");
const auth_1 = require("./auth");
const cuid2_1 = require("@paralleldrive/cuid2");
exports.pageType = (0, pg_core_1.pgEnum)('PageType', ['FOLDER', 'DOCUMENT', 'CHANNEL', 'AI_CHAT', 'CANVAS', 'FILE']);
exports.drives = (0, pg_core_1.pgTable)('drives', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    name: (0, pg_core_1.text)('name').notNull(),
    slug: (0, pg_core_1.text)('slug').notNull(),
    ownerId: (0, pg_core_1.text)('ownerId').notNull().references(() => auth_1.users.id, { onDelete: 'cascade' }),
    isTrashed: (0, pg_core_1.boolean)('isTrashed').default(false).notNull(),
    trashedAt: (0, pg_core_1.timestamp)('trashedAt', { mode: 'date' }),
    createdAt: (0, pg_core_1.timestamp)('createdAt', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: (0, pg_core_1.timestamp)('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => {
    return {
        ownerIdx: (0, pg_core_1.index)('drives_owner_id_idx').on(table.ownerId),
        ownerSlugKey: (0, pg_core_1.index)('drives_owner_id_slug_key').on(table.ownerId, table.slug),
    };
});
exports.pages = (0, pg_core_1.pgTable)('pages', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    title: (0, pg_core_1.text)('title').notNull(),
    type: (0, exports.pageType)('type').notNull(),
    content: (0, pg_core_1.text)('content').default('').notNull(),
    position: (0, pg_core_1.real)('position').notNull(),
    isTrashed: (0, pg_core_1.boolean)('isTrashed').default(false).notNull(),
    aiProvider: (0, pg_core_1.text)('aiProvider'),
    aiModel: (0, pg_core_1.text)('aiModel'),
    systemPrompt: (0, pg_core_1.text)('systemPrompt'),
    enabledTools: (0, pg_core_1.jsonb)('enabledTools'),
    // File-specific fields
    fileSize: (0, pg_core_1.real)('fileSize'),
    mimeType: (0, pg_core_1.text)('mimeType'),
    originalFileName: (0, pg_core_1.text)('originalFileName'),
    filePath: (0, pg_core_1.text)('filePath'),
    fileMetadata: (0, pg_core_1.jsonb)('fileMetadata'),
    // Processing status fields
    processingStatus: (0, pg_core_1.text)('processingStatus').default('pending'),
    processingError: (0, pg_core_1.text)('processingError'),
    processedAt: (0, pg_core_1.timestamp)('processedAt', { mode: 'date' }),
    extractionMethod: (0, pg_core_1.text)('extractionMethod'),
    extractionMetadata: (0, pg_core_1.jsonb)('extractionMetadata'),
    contentHash: (0, pg_core_1.text)('contentHash'),
    createdAt: (0, pg_core_1.timestamp)('createdAt', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: (0, pg_core_1.timestamp)('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
    trashedAt: (0, pg_core_1.timestamp)('trashedAt', { mode: 'date' }),
    driveId: (0, pg_core_1.text)('driveId').notNull().references(() => exports.drives.id, { onDelete: 'cascade' }),
    parentId: (0, pg_core_1.text)('parentId'),
    originalParentId: (0, pg_core_1.text)('originalParentId'),
}, (table) => {
    return {
        driveIdx: (0, pg_core_1.index)('pages_drive_id_idx').on(table.driveId),
        parentIdx: (0, pg_core_1.index)('pages_parent_id_idx').on(table.parentId),
        parentPositionIdx: (0, pg_core_1.index)('pages_parent_id_position_idx').on(table.parentId, table.position),
    };
});
exports.chatMessages = (0, pg_core_1.pgTable)('chat_messages', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    pageId: (0, pg_core_1.text)('pageId').notNull().references(() => exports.pages.id, { onDelete: 'cascade' }),
    role: (0, pg_core_1.text)('role').notNull(),
    content: (0, pg_core_1.text)('content').notNull(),
    toolCalls: (0, pg_core_1.jsonb)('toolCalls'),
    toolResults: (0, pg_core_1.jsonb)('toolResults'),
    createdAt: (0, pg_core_1.timestamp)('createdAt', { mode: 'date' }).defaultNow().notNull(),
    isActive: (0, pg_core_1.boolean)('isActive').default(true).notNull(),
    editedAt: (0, pg_core_1.timestamp)('editedAt', { mode: 'date' }),
    userId: (0, pg_core_1.text)('userId').references(() => auth_1.users.id, { onDelete: 'cascade' }),
    agentRole: (0, pg_core_1.text)('agentRole').default('PARTNER').notNull(),
    messageType: (0, pg_core_1.text)('messageType', { enum: ['standard', 'todo_list'] }).default('standard').notNull(),
}, (table) => {
    return {
        pageIdx: (0, pg_core_1.index)('chat_messages_page_id_idx').on(table.pageId),
        userIdx: (0, pg_core_1.index)('chat_messages_user_id_idx').on(table.userId),
        pageIsActiveCreatedAtIndex: (0, pg_core_1.index)('chat_messages_page_id_is_active_created_at_idx').on(table.pageId, table.isActive, table.createdAt),
    };
});
exports.tags = (0, pg_core_1.pgTable)('tags', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    name: (0, pg_core_1.text)('name').unique().notNull(),
    color: (0, pg_core_1.text)('color').notNull(),
});
exports.pageTags = (0, pg_core_1.pgTable)('page_tags', {
    pageId: (0, pg_core_1.text)('pageId').notNull().references(() => exports.pages.id, { onDelete: 'cascade' }),
    tagId: (0, pg_core_1.text)('tagId').notNull().references(() => exports.tags.id, { onDelete: 'cascade' }),
}, (table) => {
    return {
        pk: (0, pg_core_1.primaryKey)({ columns: [table.pageId, table.tagId] }),
    };
});
exports.storageEvents = (0, pg_core_1.pgTable)('storage_events', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    userId: (0, pg_core_1.text)('userId').notNull().references(() => auth_1.users.id, { onDelete: 'cascade' }),
    pageId: (0, pg_core_1.text)('pageId').references(() => exports.pages.id, { onDelete: 'set null' }),
    eventType: (0, pg_core_1.text)('eventType').notNull(), // 'upload', 'delete', 'update', 'reconcile'
    sizeDelta: (0, pg_core_1.real)('sizeDelta').notNull(),
    totalSizeAfter: (0, pg_core_1.real)('totalSizeAfter').notNull(),
    metadata: (0, pg_core_1.jsonb)('metadata'),
    createdAt: (0, pg_core_1.timestamp)('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
    return {
        userIdx: (0, pg_core_1.index)('storage_events_user_id_idx').on(table.userId),
        createdAtIdx: (0, pg_core_1.index)('storage_events_created_at_idx').on(table.createdAt),
    };
});
exports.favorites = (0, pg_core_1.pgTable)('favorites', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    userId: (0, pg_core_1.text)('userId').notNull().references(() => auth_1.users.id, { onDelete: 'cascade' }),
    pageId: (0, pg_core_1.text)('pageId').notNull().references(() => exports.pages.id, { onDelete: 'cascade' }),
}, (table) => {
    return {
        userIdPageIdKey: (0, pg_core_1.index)('favorites_user_id_page_id_key').on(table.userId, table.pageId),
    };
});
exports.mentions = (0, pg_core_1.pgTable)('mentions', {
    id: (0, pg_core_1.text)('id').primaryKey().$defaultFn(() => (0, cuid2_1.createId)()),
    createdAt: (0, pg_core_1.timestamp)('createdAt', { mode: 'date' }).defaultNow().notNull(),
    sourcePageId: (0, pg_core_1.text)('sourcePageId').notNull().references(() => exports.pages.id, { onDelete: 'cascade' }),
    targetPageId: (0, pg_core_1.text)('targetPageId').notNull().references(() => exports.pages.id, { onDelete: 'cascade' }),
}, (table) => {
    return {
        sourceTargetKey: (0, pg_core_1.index)('mentions_source_page_id_target_page_id_key').on(table.sourcePageId, table.targetPageId),
        sourcePageIdx: (0, pg_core_1.index)('mentions_source_page_id_idx').on(table.sourcePageId),
        targetPageIdx: (0, pg_core_1.index)('mentions_target_page_id_idx').on(table.targetPageId),
    };
});
exports.drivesRelations = (0, drizzle_orm_1.relations)(exports.drives, ({ one, many }) => ({
    owner: one(auth_1.users, {
        fields: [exports.drives.ownerId],
        references: [auth_1.users.id],
    }),
    pages: many(exports.pages),
}));
exports.pagesRelations = (0, drizzle_orm_1.relations)(exports.pages, ({ one, many }) => ({
    drive: one(exports.drives, {
        fields: [exports.pages.driveId],
        references: [exports.drives.id],
    }),
    parent: one(exports.pages, {
        fields: [exports.pages.parentId],
        references: [exports.pages.id],
        relationName: 'NestedPages',
    }),
    children: many(exports.pages, {
        relationName: 'NestedPages',
    }),
    originalParent: one(exports.pages, {
        fields: [exports.pages.originalParentId],
        references: [exports.pages.id],
        relationName: 'OriginalParent',
    }),
    restoredChildren: many(exports.pages, {
        relationName: 'OriginalParent',
    }),
    tags: many(exports.pageTags),
    favorites: many(exports.favorites),
    mentionsFrom: many(exports.mentions, { relationName: 'MentionsFrom' }),
    mentionsTo: many(exports.mentions, { relationName: 'MentionsTo' }),
    messages: many(exports.chatMessages),
    // permissions relation handled separately to avoid circular dependency
}));
exports.chatMessagesRelations = (0, drizzle_orm_1.relations)(exports.chatMessages, ({ one }) => ({
    page: one(exports.pages, {
        fields: [exports.chatMessages.pageId],
        references: [exports.pages.id],
    }),
    user: one(auth_1.users, {
        fields: [exports.chatMessages.userId],
        references: [auth_1.users.id],
    }),
}));
exports.tagsRelations = (0, drizzle_orm_1.relations)(exports.tags, ({ many }) => ({
    pages: many(exports.pageTags),
}));
exports.pageTagsRelations = (0, drizzle_orm_1.relations)(exports.pageTags, ({ one }) => ({
    page: one(exports.pages, {
        fields: [exports.pageTags.pageId],
        references: [exports.pages.id],
    }),
    tag: one(exports.tags, {
        fields: [exports.pageTags.tagId],
        references: [exports.tags.id],
    }),
}));
exports.favoritesRelations = (0, drizzle_orm_1.relations)(exports.favorites, ({ one }) => ({
    user: one(auth_1.users, {
        fields: [exports.favorites.userId],
        references: [auth_1.users.id],
    }),
    page: one(exports.pages, {
        fields: [exports.favorites.pageId],
        references: [exports.pages.id],
    }),
}));
exports.mentionsRelations = (0, drizzle_orm_1.relations)(exports.mentions, ({ one }) => ({
    sourcePage: one(exports.pages, {
        fields: [exports.mentions.sourcePageId],
        references: [exports.pages.id],
        relationName: 'MentionsFrom',
    }),
    targetPage: one(exports.pages, {
        fields: [exports.mentions.targetPageId],
        references: [exports.pages.id],
        relationName: 'MentionsTo',
    }),
}));
