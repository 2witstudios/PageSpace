import { pgTable, text, timestamp, jsonb, real, boolean, pgEnum, primaryKey, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { createId } from '@paralleldrive/cuid2';
export const pageType = pgEnum('PageType', ['FOLDER', 'DOCUMENT', 'CHANNEL', 'AI_CHAT', 'CANVAS']);

export const drives = pgTable('drives', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  ownerId: text('ownerId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  isTrashed: boolean('isTrashed').default(false).notNull(),
  trashedAt: timestamp('trashedAt', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => {
    return {
        ownerIdx: index('drives_owner_id_idx').on(table.ownerId),
        ownerSlugKey: index('drives_owner_id_slug_key').on(table.ownerId, table.slug),
    }
});

export const pages = pgTable('pages', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  title: text('title').notNull(),
  type: pageType('type').notNull(),
  content: text('content').default('').notNull(),
  position: real('position').notNull(),
  isTrashed: boolean('isTrashed').default(false).notNull(),
  aiProvider: text('aiProvider'),
  aiModel: text('aiModel'),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
  trashedAt: timestamp('trashedAt', { mode: 'date' }),
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  parentId: text('parentId'),
  originalParentId: text('originalParentId'),
}, (table) => {
    return {
        driveIdx: index('pages_drive_id_idx').on(table.driveId),
        parentIdx: index('pages_parent_id_idx').on(table.parentId),
        parentPositionIdx: index('pages_parent_id_position_idx').on(table.parentId, table.position),
    }
});

export const chatMessages = pgTable('chat_messages', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  pageId: text('pageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  content: text('content').notNull(),
  toolCalls: jsonb('toolCalls'),
  toolResults: jsonb('toolResults'),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  isActive: boolean('isActive').default(true).notNull(),
  editedAt: timestamp('editedAt', { mode: 'date' }),
  userId: text('userId').references(() => users.id, { onDelete: 'cascade' }),
  agentRole: text('agentRole').default('PARTNER').notNull(),
  messageType: text('messageType', { enum: ['standard', 'todo_list'] }).default('standard').notNull(),
}, (table) => {
    return {
        pageIdx: index('chat_messages_page_id_idx').on(table.pageId),
        userIdx: index('chat_messages_user_id_idx').on(table.userId),
        pageIsActiveCreatedAtIndex: index('chat_messages_page_id_is_active_created_at_idx').on(table.pageId, table.isActive, table.createdAt),
    }
});


export const tags = pgTable('tags', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').unique().notNull(),
  color: text('color').notNull(),
});

export const pageTags = pgTable('page_tags', {
  pageId: text('pageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  tagId: text('tagId').notNull().references(() => tags.id, { onDelete: 'cascade' }),
}, (table) => {
    return {
        pk: primaryKey({ columns: [table.pageId, table.tagId] }),
    }
});

export const favorites = pgTable('favorites', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  pageId: text('pageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
}, (table) => {
    return {
        userIdPageIdKey: index('favorites_user_id_page_id_key').on(table.userId, table.pageId),
    }
});

export const mentions = pgTable('mentions', {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
    sourcePageId: text('sourcePageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
    targetPageId: text('targetPageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
}, (table) => {
    return {
        sourceTargetKey: index('mentions_source_page_id_target_page_id_key').on(table.sourcePageId, table.targetPageId),
        sourcePageIdx: index('mentions_source_page_id_idx').on(table.sourcePageId),
        targetPageIdx: index('mentions_target_page_id_idx').on(table.targetPageId),
    }
});

export const drivesRelations = relations(drives, ({ one, many }) => ({
    owner: one(users, {
        fields: [drives.ownerId],
        references: [users.id],
    }),
    pages: many(pages),
}));

export const pagesRelations = relations(pages, ({ one, many }) => ({
    drive: one(drives, {
        fields: [pages.driveId],
        references: [drives.id],
    }),
    parent: one(pages, {
        fields: [pages.parentId],
        references: [pages.id],
        relationName: 'NestedPages',
    }),
    children: many(pages, {
        relationName: 'NestedPages',
    }),
    originalParent: one(pages, {
        fields: [pages.originalParentId],
        references: [pages.id],
        relationName: 'OriginalParent',
    }),
    restoredChildren: many(pages, {
        relationName: 'OriginalParent',
    }),
    tags: many(pageTags),
    favorites: many(favorites),
    mentionsFrom: many(mentions, { relationName: 'MentionsFrom' }),
    mentionsTo: many(mentions, { relationName: 'MentionsTo' }),
    messages: many(chatMessages),
    // permissions relation handled separately to avoid circular dependency
}));


export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
    page: one(pages, {
        fields: [chatMessages.pageId],
        references: [pages.id],
    }),
    user: one(users, {
        fields: [chatMessages.userId],
        references: [users.id],
    }),
}));


export const tagsRelations = relations(tags, ({ many }) => ({
    pages: many(pageTags),
}));

export const pageTagsRelations = relations(pageTags, ({ one }) => ({
    page: one(pages, {
        fields: [pageTags.pageId],
        references: [pages.id],
    }),
    tag: one(tags, {
        fields: [pageTags.tagId],
        references: [tags.id],
    }),
}));

export const favoritesRelations = relations(favorites, ({ one }) => ({
    user: one(users, {
        fields: [favorites.userId],
        references: [users.id],
    }),
    page: one(pages, {
        fields: [favorites.pageId],
        references: [pages.id],
    }),
}));

export const mentionsRelations = relations(mentions, ({ one }) => ({
    sourcePage: one(pages, {
        fields: [mentions.sourcePageId],
        references: [pages.id],
        relationName: 'MentionsFrom',
    }),
    targetPage: one(pages, {
        fields: [mentions.targetPageId],
        references: [pages.id],
        relationName: 'MentionsTo',
    }),
}));