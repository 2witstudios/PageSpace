import { pgTable, text, timestamp, jsonb, real, pgEnum, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { pages, tags } from './core';
import { channelMessages } from './chat';
import { messages } from './conversations';

/**
 * WHAT a tag is attached to — the discriminant of `content_tags`.
 *
 * THIS IS THE CANONICAL DECLARATION of the variant set. `TargetKind` in
 * `@pagespace/lib/tags/tag-core` is DERIVED from `enumValues` below rather than
 * restated, because the dependency runs `lib -> db` and never the reverse, so
 * only this side can be the source. Two parallel unions kept in step by a drift
 * test is strictly worse than a structure in which drift cannot exist.
 *
 * A `pgEnum` rather than `text` + a CHECK constraint for the same reason: an
 * enum has a type to derive from. `ALTER TYPE ... ADD VALUE` is workable here
 * because `packages/db/src/migration-runner.ts` commits each migration
 * individually — but note that ADDING a sixth kind also means REPLACING
 * `content_tags_target_chk` below, which enumerates all five exhaustively.
 *
 *   page            — the whole page
 *   text            — a character range in prose, located by a TextAnchor
 *   sheet_cell      — one cell, located by (sheet name, A1 address)
 *   channel_message — one channel_messages row
 *   ai_message      — one messages row
 */
export const contentTagTargetKind = pgEnum('ContentTagTargetKind', [
  'page',
  'text',
  'sheet_cell',
  'channel_message',
  'ai_message',
]);
export type ContentTagTargetKind = (typeof contentTagTargetKind.enumValues)[number];

/**
 * How well a `text` tag's anchor still locates its quote — the persisted form
 * of `AnchorResolution['status']` from `@pagespace/lib/content/anchoring`.
 *
 * `orphaned` is GitHub's *outdated* state: the quoted text is gone and the tag
 * no longer points anywhere. It is kept rather than deleted so the tag can be
 * shown as stale and repaired, instead of silently vanishing.
 */
export const contentTagAnchorStatus = pgEnum('ContentTagAnchorStatus', [
  'exact',
  'shifted',
  'fuzzy',
  'orphaned',
]);
export type ContentTagAnchorStatus = (typeof contentTagAnchorStatus.enumValues)[number];

/** WHO applied the tag. `confidence` is meaningful only for the non-human sources. */
export const contentTagSource = pgEnum('ContentTagSource', ['user', 'ai', 'system', 'rule']);
export type ContentTagSource = (typeof contentTagSource.enumValues)[number];

/**
 * The ASSIGNMENT — one row per "this tag is on this thing".
 *
 * A surrogate cuid PK following `page_permissions` rather than a composite-PK
 * join like the `page_tags` table this replaces, because one tag can legitimately
 * be applied to one page MANY times at different targets: three separate
 * paragraphs of a document can each carry `#risk`.
 *
 * `pageId` is notNull on EVERY row regardless of target kind — a deliberate
 * denormalization, for two things that both matter:
 *
 *   - permissions in this repo are page-scoped, so `getBatchPagePermissions`
 *     filters every target kind uniformly instead of needing a different join
 *     per kind;
 *   - deleting a page cascades away all of its tags without a join.
 *
 * For a `channel_message` row it is the message's own `pageId`. For an
 * `ai_message` row it is genuinely NOT derivable and must be supplied by the
 * writer: `messages` has no `pageId` at all, and reaches a page only through
 * `conversations.contextId`, which is polymorphic with no foreign key — NULL
 * for a global chat, a driveId for a drive chat, and a pageId only for a page
 * chat (see schema/conversations.ts). So `ai_message` tags are scoped to
 * conversations anchored to a page — which no foreign key can express.
 *
 * SCOPE COHERENCE IS ENFORCED, but by a TRIGGER rather than by the foreign keys
 * above, because the keys below only prove each referenced row EXISTS, never
 * that the referenced rows belong together. `content_tags_target_scope`
 * (migration 0270) refuses, on INSERT and UPDATE:
 *
 *   - a tag whose drive is not the page's drive — otherwise
 *     `UNIQUE (driveId, normalizedKey)` guards a boundary the assignments can
 *     step straight over;
 *   - a `channel_message` whose message sits on a different page than `pageId`;
 *   - an `ai_message` whose conversation is not page-scoped to `pageId`, using
 *     the two disjuncts `repositories/conversation-cleanup.ts` defines (a
 *     `type='page'` thread whose `contextId` IS the page, or a `type='client'`
 *     thread whose `agentPageId` is).
 *
 * The last two are not tidiness. `pageId` is what permissions and the delete
 * cascade key on, so a row whose `pageId` disagrees with its message is
 * PERMISSIONED AGAINST THE WRONG PAGE — readable by whoever can see the page it
 * claims rather than the page its content is on.
 *
 * THE GAP THAT REMAINS, and it is Phase 3's to close: a trigger on this table
 * cannot see a page move BETWEEN DRIVES afterwards
 * (`page-cross-drive-move-service.ts` rewrites `pages."driveId"` for a whole
 * subtree). A tag left behind in the source drive's vocabulary is then stale,
 * exactly as a task's assignee agent is, and the house answer is an
 * application-level scrub inside the move transaction —
 * `scrubDriveScopedTaskAssociations` is the shape to copy. Nothing writes this
 * table yet, so there is no row to scrub today; that scrub must land WITH the
 * first writer, not after it.
 */
export const contentTags = pgTable('content_tags', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  tagId: text('tagId').notNull().references(() => tags.id, { onDelete: 'cascade' }),
  pageId: text('pageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  targetKind: contentTagTargetKind('targetKind').notNull(),
  /** `TextAnchor` for 'text', `SheetCellAnchor` for 'sheet_cell', NULL otherwise. */
  anchor: jsonb('anchor'),
  anchorStatus: contentTagAnchorStatus('anchorStatus'),
  channelMessageId: text('channelMessageId').references(() => channelMessages.id, { onDelete: 'cascade' }),
  aiMessageId: text('aiMessageId').references(() => messages.id, { onDelete: 'cascade' }),
  source: contentTagSource('source').notNull(),
  /** NULL for a human tag; 0..1 for a machine-proposed one. */
  confidence: real('confidence'),
  createdBy: text('createdBy').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).notNull().$onUpdate(() => new Date()),
}, (table) => {
  return {
    pageIdx: index('content_tags_page_id_idx').on(table.pageId),
    tagIdx: index('content_tags_tag_id_idx').on(table.tagId),
    /**
     * One page-level assignment of a tag to a page, ever. PARTIAL, so it
     * constrains only the kind whose identity is `(pageId, tagId)` and leaves
     * the anchored kinds free to repeat.
     *
     * `${table.targetKind}` interpolation rather than a raw column name on
     * purpose — see `__tests__/drizzle-identifier-escaping.test.ts`, which
     * exists for that class of bug.
     */
    pageTargetUnique: uniqueIndex('content_tags_page_target_unique')
      .on(table.pageId, table.tagId)
      .where(sql`${table.targetKind} = 'page'`),
    channelMessageTargetUnique: uniqueIndex('content_tags_channel_message_target_unique')
      .on(table.channelMessageId, table.tagId)
      .where(sql`${table.targetKind} = 'channel_message'`),
    aiMessageTargetUnique: uniqueIndex('content_tags_ai_message_target_unique')
      .on(table.aiMessageId, table.tagId)
      .where(sql`${table.targetKind} = 'ai_message'`),
    /**
     * The discriminant, enforced. `targetKind` is a notNull enum with exactly
     * five values and every one of them has a branch here, each of which fully
     * determines ALL FOUR of the discriminated columns — so this is a
     * BICONDITIONAL, not a set of one-way implications.
     *
     * That distinction is a scar, not a style note: `nodeType <> 'root' OR
     * "parentId" IS NULL` constrains root rows only, and a non-root row with a
     * null parent sails through it. Written as `kind = X AND <every column>`
     * disjuncts, a row that satisfies no branch — including a row whose kind
     * this build has never heard of — is refused rather than unconstrained.
     *
     * `anchorStatus` rides the same rule: it is the resolution state of a TEXT
     * anchor, so it is required for 'text' and forbidden everywhere else,
     * including 'sheet_cell' — a cell address is a natural key that either
     * exists or does not, and has no fuzzy state to record.
     */
    targetChk: check(
      'content_tags_target_chk',
      sql`(
        (${table.targetKind} = 'page' AND ${table.anchor} IS NULL AND ${table.anchorStatus} IS NULL AND ${table.channelMessageId} IS NULL AND ${table.aiMessageId} IS NULL)
        OR (${table.targetKind} = 'text' AND ${table.anchor} IS NOT NULL AND ${table.anchorStatus} IS NOT NULL AND ${table.channelMessageId} IS NULL AND ${table.aiMessageId} IS NULL)
        OR (${table.targetKind} = 'sheet_cell' AND ${table.anchor} IS NOT NULL AND ${table.anchorStatus} IS NULL AND ${table.channelMessageId} IS NULL AND ${table.aiMessageId} IS NULL)
        OR (${table.targetKind} = 'channel_message' AND ${table.anchor} IS NULL AND ${table.anchorStatus} IS NULL AND ${table.channelMessageId} IS NOT NULL AND ${table.aiMessageId} IS NULL)
        OR (${table.targetKind} = 'ai_message' AND ${table.anchor} IS NULL AND ${table.anchorStatus} IS NULL AND ${table.channelMessageId} IS NULL AND ${table.aiMessageId} IS NOT NULL)
      )`,
    ),
    /**
     * A confidence outside 0..1 is not a low score, it is a corrupt one — and
     * it would silently poison any future ranking that multiplies by it.
     */
    confidenceRangeChk: check(
      'content_tags_confidence_range_chk',
      sql`${table.confidence} IS NULL OR (${table.confidence} >= 0 AND ${table.confidence} <= 1)`,
    ),
  };
});

/**
 * Only the `one()` side lives here. The reciprocal `many()` on `pages` and
 * `tags` would have to be declared in schema/core.ts, which would import this
 * file while this file imports it — the same circular import `page_permissions`
 * avoids the same way.
 */
export const contentTagsRelations = relations(contentTags, ({ one }) => ({
  tag: one(tags, {
    fields: [contentTags.tagId],
    references: [tags.id],
  }),
  page: one(pages, {
    fields: [contentTags.pageId],
    references: [pages.id],
  }),
  channelMessage: one(channelMessages, {
    fields: [contentTags.channelMessageId],
    references: [channelMessages.id],
  }),
  aiMessage: one(messages, {
    fields: [contentTags.aiMessageId],
    references: [messages.id],
  }),
  creator: one(users, {
    fields: [contentTags.createdBy],
    references: [users.id],
  }),
}));
