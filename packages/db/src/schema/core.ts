import { pgTable, text, timestamp, jsonb, real, boolean, pgEnum, index, uniqueIndex, unique, integer, check, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { driveEnvs } from './drive-envs';
import { createId } from '@paralleldrive/cuid2';
// 'MACHINE' is a DEAD value, kept only because Postgres cannot DROP VALUE from
// an enum type — the Machines/Development surface that used it was torn down
// (phase 8 of the agent-sessions rebuild) with no data migration. Nothing may
// ever write it again: it is removed from the application-level PageType enum
// (packages/lib/src/utils/enums.ts) and every validator/config that governs
// what a page's `type` can be set to.
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
  sandboxEnabled: boolean('sandboxEnabled').default(false).notNull(), // AI_CHAT agents: whether the sandbox tool families (bash/files, git+gh, sessions/shells) are offered to this agent. Provisioning stays lazy and automatic on first use — this is the settings switch, not a provision button. Successor to the old pages.terminalAccess (dropped in 0234, phase 8's teardown of the Machines model — never pages.machineAccess, which never existed in this package).
  defaultEnvId: text('defaultEnvId').references((): AnyPgColumn => driveEnvs.id, { onDelete: 'set null' }), // AI_CHAT agents: the drive Environment (drive_envs) pre-selected when spawning a new session for this agent. A DEFAULT, not a binding — spawn time (useSpawnSession / POST /api/agent-workspaces) still allows overriding to ephemeral or another env. NULL = no default (ephemeral). Not coupled at the DB level to sandboxEnabled — inert data when the switch is off, enforced only in the settings UI. `onDelete: 'set null'` so deleting the env falls the agent back to ephemeral rather than touching the page row.
  userScopedAccess: boolean('userScopedAccess').default(false).notNull(), // AI_CHAT agents only, owner-toggled: when true, actor-permission helpers fall back to the invoking user's own access instead of this agent's drive memberships
  siteMode: boolean('siteMode').default(false).notNull(), // CANVAS pages only, author-toggled: when true the page renders under buildSiteCsp() instead of buildBaselineCsp() — script-src/connect-src open to any https host so the page can load CDN libraries and call APIs like an ordinary website. Defaults false so no page already published silently widens its policy; flipping it is the author's explicit opt-in.
  description: text('description'), // Freeform description surfaced on a page's Settings tab
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

/**
 * The tag VOCABULARY — one row per distinct tag name per drive.
 *
 * Reclaimed rather than replaced. The table has existed since migration 0000
 * and has never had a writer, but its original shape could not be used: `name`
 * was `unique()` GLOBALLY, across every drive and every tenant, so the first
 * drive to mint "roadmap" would have taken the name away from all the others —
 * a multi-tenancy bug rather than a missing feature. `color` was `notNull` with
 * no default besides, which blocked any insert that did not pick one.
 *
 * `normalizedKey` is `text`, NOT `varchar(64)`, and that is a decision rather
 * than laziness. The 64-code-point limit (`MAX_TAG_NAME_LENGTH`) is on the
 * display NAME; the key is derived through NFKC, which expands — the worst
 * single character, U+FDFA, expands to 18 code points — so a legal name keys
 * to as much as 1152 code points / 2112 bytes (`MAX_TAG_KEY_LENGTH`, exported
 * from `@pagespace/lib/tags/tag-core` for exactly this choice). A `varchar(64)`
 * mirroring the name limit would reject a legal tag at INSERT time. 2112 bytes
 * still fits under Postgres's ~2704-byte btree tuple limit, so the unique index
 * below is safe.
 *
 * `color` is nullable: a vocabulary entry is a NAME first, and forcing every
 * writer to invent a colour is what made the original table unusable.
 */
export const tags = pgTable('tags', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  /** Display form: NFC, whitespace-collapsed, stored as the first writer typed it. */
  name: text('name').notNull(),
  /** The casefolded NFKC dedupe key from `tagKey()` — what uniqueness is taken on. */
  normalizedKey: text('normalizedKey').notNull(),
  color: text('color'),
  description: text('description'),
  createdBy: text('createdBy').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => {
    return {
        driveIdx: index('tags_drive_id_idx').on(table.driveId),
        // The dedupe rule, baked in. Two spellings that fold to the same key are
        // ONE tag inside a drive and different tags across drives.
        driveKeyKey: unique('tags_drive_id_normalized_key_key').on(table.driveId, table.normalizedKey),
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
    // contentTags relation handled in schema/content-tags.ts to avoid a circular import
    favorites: many(favorites),
    mentionsFrom: many(mentions, { relationName: 'MentionsFrom' }),
    mentionsTo: many(mentions, { relationName: 'MentionsTo' }),
    userMentionsFrom: many(userMentions, { relationName: 'UserMentionsFrom' }),
    // permissions relation handled separately to avoid circular dependency
}));


export const tagsRelations = relations(tags, ({ one }) => ({
    drive: one(drives, {
        fields: [tags.driveId],
        references: [drives.id],
    }),
    creator: one(users, {
        fields: [tags.createdBy],
        references: [users.id],
    }),
    // The assignment side lives in schema/content-tags.ts, for the same
    // circular-import reason page_permissions' does.
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
