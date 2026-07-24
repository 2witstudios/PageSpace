import { pgTable, text, timestamp, jsonb, real, boolean, pgEnum, primaryKey, index, uniqueIndex, integer, check, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { createId } from '@paralleldrive/cuid2';
export const pageType = pgEnum('PageType', ['FOLDER', 'DOCUMENT', 'CHANNEL', 'AI_CHAT', 'CANVAS', 'FILE', 'SHEET', 'TASK_LIST', 'CODE', 'MACHINE']);
export type PageTypeEnum = (typeof pageType.enumValues)[number];
export const driveKind = pgEnum('DriveKind', ['STANDARD', 'HOME']);
export type DriveKindEnum = (typeof driveKind.enumValues)[number];

export const drives = pgTable('drives', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  ownerId: text('ownerId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: driveKind('kind').default('STANDARD').notNull(),
  isTrashed: boolean('isTrashed').default(false).notNull(),
  trashedAt: timestamp('trashedAt', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
  drivePrompt: text('drivePrompt'), // Custom AI instructions for this drive
  publishSubdomain: text('publishSubdomain').unique(), // Globally-unique subdomain for published pages; set on first publish
  homePageId: text('homePageId').references((): AnyPgColumn => pages.id, { onDelete: 'set null' }), // Drive landing page shown at drive root
  publishDefaultOgImageUrl: text('publish_default_og_image_url'), // Drive-wide default social share image for published pages lacking their own
  notFoundPageId: text('not_found_page_id').references((): AnyPgColumn => pages.id, { onDelete: 'set null' }), // Canvas page rendered as the published site's 404.html; falls back to the generic branded 404 when unset
  publishFaviconUrl: text('publish_favicon_url'), // Drive-wide favicon override for published pages lacking their own <link rel="icon">
}, (table) => {
    return {
        ownerIdx: index('drives_owner_id_idx').on(table.ownerId),
        ownerSlugKey: index('drives_owner_id_slug_key').on(table.ownerId, table.slug),
        // At most one Home drive per owner, forever. Race arbiter between lazy
        // provisioning and the backfill script (both insert ON CONFLICT DO NOTHING).
        ownerHomeKey: uniqueIndex('drives_owner_home_unique').on(table.ownerId).where(sql`${table.kind} = 'HOME'`),
    }
});

export const pages = pgTable('pages', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  title: text('title').notNull(),
  type: pageType('type').notNull(),
  content: text('content').default('').notNull(),
  contentMode: text('contentMode', { enum: ['html', 'markdown'] }).default('html').notNull(),
  isPaginated: boolean('isPaginated').default(false).notNull(),
  position: real('position').notNull(),
  isTrashed: boolean('isTrashed').default(false).notNull(),
  aiProvider: text('aiProvider'),
  aiModel: text('aiModel'),
  systemPrompt: text('systemPrompt'),
  enabledTools: jsonb('enabledTools'),
  includeDrivePrompt: boolean('includeDrivePrompt').default(false).notNull(), // Whether to include drive prompt for AI_CHAT pages
  agentDefinition: text('agentDefinition'), // Tool-like description of what this agent does (for AI_CHAT pages)
  visibleToGlobalAssistant: boolean('visibleToGlobalAssistant').default(true).notNull(), // Whether this agent appears in global assistant's system prompt
  includePageTree: boolean('includePageTree').default(false).notNull(), // Whether to include page tree in AI context
  pageTreeScope: text('pageTreeScope', { enum: ['children', 'drive'] }).default('children'), // Scope of page tree to include
  toolExposureMode: text('toolExposureMode', { enum: ['upfront', 'search'] }).default('upfront').notNull(), // How tools are exposed to AI_CHAT agents: all schemas upfront, or core tools + tool_search/execute_tool
  userScopedAccess: boolean('userScopedAccess').default(false).notNull(), // AI_CHAT agents only, owner-toggled: when true, actor-permission helpers fall back to the invoking user's own access instead of this agent's drive memberships
  // Physical column stays "terminalAccess" ON PURPOSE. This table is read AND
  // written by a live, non-flag-gated endpoint (api/pages/[pageId]/agent-config),
  // and deploys run migrations BEFORE the new app image takes traffic
  // (.github/workflows/docker-images.yml: "Run migrations" precedes "Deploy web"),
  // so renaming the column would 500 every agent-config request served by the
  // still-running old image. Drizzle decouples the field name from the column
  // name, so the code reads `machineAccess` everywhere; renaming the column
  // itself needs an expand/contract across two releases.
  machineAccess: boolean('terminalAccess').default(false).notNull(), // AI_CHAT agents only: whether this agent may use Machine tools
  machines: jsonb('machines'), // MachineRef[]; configured machines for this agent, machines[0] is the default active machine
  description: text('description'), // Machine (MACHINE) pages only: freeform description surfaced on the Machine page's Settings tab
  allowPageAgents: boolean('allowPageAgents').default(true).notNull(), // Machine (MACHINE) pages only: whether page-scoped agents may run their terminal tools on this machine
  // File-specific fields.
  // fileSize/mimeType/contentHash are DERIVED DISPLAY METADATA copied from the
  // content-addressed `files` row at upload time (#2155). The authoritative
  // storage-accounting value is files.sizeBytes (reached via file_pages); these
  // per-page copies are never re-synced and must not feed quota/usage math.
  fileSize: real('fileSize'),
  mimeType: text('mimeType'),
  originalFileName: text('originalFileName'),
  filePath: text('filePath'),
  fileMetadata: jsonb('fileMetadata'),
  // Processing status fields
  processingStatus: text('processingStatus').default('pending'),
  processingError: text('processingError'),
  processedAt: timestamp('processedAt', { mode: 'date' }),
  extractionMethod: text('extractionMethod'),
  extractionMetadata: jsonb('extractionMetadata'),
  contentHash: text('contentHash'),
  excludeFromSearch: boolean('excludeFromSearch').default(false).notNull(),
  isPrivate: boolean('isPrivate').default(false).notNull(),
  createdBy: text('createdBy').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
  trashedAt: timestamp('trashedAt', { mode: 'date' }),
  revision: integer('revision').default(0).notNull(),
  stateHash: text('stateHash'),
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  parentId: text('parentId'),
  originalParentId: text('originalParentId'),
}, (table) => {
    return {
        driveIdx: index('pages_drive_id_idx').on(table.driveId),
        parentIdx: index('pages_parent_id_idx').on(table.parentId),
        parentPositionIdx: index('pages_parent_id_position_idx').on(table.parentId, table.position),
        driveTrashedTypeIdx: index('pages_drive_id_is_trashed_type_idx').on(table.driveId, table.isTrashed, table.type),
    }
});

export const chatMessages = pgTable('chat_messages', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  pageId: text('pageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  conversationId: text('conversationId').notNull().$defaultFn(() => createId()), // Group messages into conversation sessions
  role: text('role').notNull(),
  content: text('content').notNull(),
  toolCalls: jsonb('toolCalls'),
  toolResults: jsonb('toolResults'),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  isActive: boolean('isActive').default(true).notNull(),
  editedAt: timestamp('editedAt', { mode: 'date' }),
  userId: text('userId').references(() => users.id, { onDelete: 'cascade' }),
  sourceAgentId: text('sourceAgentId').references(() => pages.id, { onDelete: 'set null' }),
  messageType: text('messageType', { enum: ['standard', 'todo_list'] }).default('standard').notNull(),
  // Lifecycle state of an assistant row from the moment generation starts. 'streaming' rows are
  // placeholders (empty content, mid-flight); 'interrupted' rows are terminal with real partial
  // content; pre-existing rows read as 'complete' via the default. See Server Stream Durability epic PR 2.
  status: text('status', { enum: ['streaming', 'complete', 'interrupted'] }).default('complete').notNull(),
}, (table) => {
    return {
        pageIdx: index('chat_messages_page_id_idx').on(table.pageId),
        userIdx: index('chat_messages_user_id_idx').on(table.userId),
        conversationIdx: index('chat_messages_conversation_id_idx').on(table.conversationId), // Index for conversation filtering
        pageConversationIdx: index('chat_messages_page_id_conversation_id_idx').on(table.pageId, table.conversationId), // Composite index for queries
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

export const storageEvents = pgTable('storage_events', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  pageId: text('pageId').references(() => pages.id, { onDelete: 'set null' }),
  eventType: text('eventType').notNull(), // 'upload', 'delete', 'update', 'reconcile'
  sizeDelta: real('sizeDelta').notNull(),
  totalSizeAfter: real('totalSizeAfter').notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
  return {
    userIdx: index('storage_events_user_id_idx').on(table.userId),
    createdAtIdx: index('storage_events_created_at_idx').on(table.createdAt),
  }
});

export const favoriteItemType = pgEnum('FavoriteItemType', ['page', 'drive']);

export const favorites = pgTable('favorites', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  itemType: favoriteItemType('itemType').notNull().default('page'),
  pageId: text('pageId').references(() => pages.id, { onDelete: 'cascade' }),
  driveId: text('driveId').references(() => drives.id, { onDelete: 'cascade' }),
  position: integer('position').default(0).notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
    return {
        userIdPageIdKey: index('favorites_user_id_page_id_key').on(table.userId, table.pageId),
        userIdDriveIdKey: index('favorites_user_id_drive_id_key').on(table.userId, table.driveId),
        userPositionIdx: index('favorites_user_id_position_idx').on(table.userId, table.position),
        itemTypeConsistency: check('favorites_item_type_consistency_chk', sql`(("itemType" = 'page' AND "pageId" IS NOT NULL AND "driveId" IS NULL) OR ("itemType" = 'drive' AND "driveId" IS NOT NULL AND "pageId" IS NULL))`),
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

// User mentions table - tracks when users are @mentioned in pages
export const userMentions = pgTable('user_mentions', {
    id: text('id').primaryKey().$defaultFn(() => createId()),
    createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
    sourcePageId: text('sourcePageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
    targetUserId: text('targetUserId').notNull().references(() => users.id, { onDelete: 'cascade' }),
    mentionedByUserId: text('mentionedByUserId').references(() => users.id, { onDelete: 'set null' }),
}, (table) => {
    return {
        sourceUserKey: index('user_mentions_source_page_id_target_user_id_key').on(table.sourcePageId, table.targetUserId),
        sourcePageIdx: index('user_mentions_source_page_id_idx').on(table.sourcePageId),
        targetUserIdx: index('user_mentions_target_user_id_idx').on(table.targetUserId),
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
    userMentionsFrom: many(userMentions, { relationName: 'UserMentionsFrom' }),
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
    sourceAgent: one(pages, {
        fields: [chatMessages.sourceAgentId],
        references: [pages.id],
        relationName: 'sourceAgent',
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
    drive: one(drives, {
        fields: [favorites.driveId],
        references: [drives.id],
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

export const userMentionsRelations = relations(userMentions, ({ one }) => ({
    sourcePage: one(pages, {
        fields: [userMentions.sourcePageId],
        references: [pages.id],
        relationName: 'UserMentionsFrom',
    }),
    targetUser: one(users, {
        fields: [userMentions.targetUserId],
        references: [users.id],
        relationName: 'UserMentionsTo',
    }),
    mentionedByUser: one(users, {
        fields: [userMentions.mentionedByUserId],
        references: [users.id],
        relationName: 'UserMentionedBy',
    }),
}));
