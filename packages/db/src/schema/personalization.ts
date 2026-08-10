import { pgTable, text, timestamp, boolean, uniqueIndex, integer, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { users } from './auth';
import { pages } from './core';
import { createId } from '@paralleldrive/cuid2';

/**
 * User personalization settings for AI interactions.
 *
 * These now live as editable pages in the user's Home drive — this table stores
 * the pointers to those pages. The legacy bio/writingStyle/rules columns are
 * kept for backfill compatibility and will be dropped in a follow-up PR.
 */
export const userPersonalization = pgTable('user_personalization', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Legacy content columns — kept for backfall compatibility
  // LEGACY. Superseded by the page pointers below, and read ONLY while a field's
  // pointer is still null — see `personalization-utils.getUserPersonalization`.
  // `scripts/backfill-memory-pages.ts` copies each into its page and then nulls
  // the column, so a row that has been backfilled holds nothing here.
  //
  // ⚠️ Dropping these three is a CONTRACT migration and carries the same hazard
  // `infrastructure/UPGRADE.md` documents for 0255 → 0256: the backfill is what
  // moves the content, and it can only run while the columns still exist. A
  // deployment that jumps straight to the drop applies it to rows the backfill
  // never reached, and their profiles are gone with nothing to recover from —
  // silently, because the pointer-absent fallback simply reads empty. Ship the
  // drop only behind a release that carries the backfill, and give it an
  // UPGRADE.md entry saying so.
  bio: text('bio'),
  writingStyle: text('writingStyle'),
  rules: text('rules'),

  // Pointers to memory pages in the Home drive
  memoryFolderId: text('memoryFolderId').references(() => pages.id, { onDelete: 'set null' }),
  bioPageId: text('bioPageId').references(() => pages.id, { onDelete: 'set null' }),
  writingStylePageId: text('writingStylePageId').references(() => pages.id, { onDelete: 'set null' }),
  rulesPageId: text('rulesPageId').references(() => pages.id, { onDelete: 'set null' }),

  // Global toggle for AI personalization
  enabled: boolean('enabled').default(true).notNull(),

  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  userIdx: uniqueIndex('user_personalization_user_idx').on(table.userId),
}));

export const userPersonalizationRelations = relations(userPersonalization, ({ one }) => ({
  user: one(users, {
    fields: [userPersonalization.userId],
    references: [users.id],
  }),
  memoryFolder: one(pages, {
    fields: [userPersonalization.memoryFolderId],
    references: [pages.id],
  }),
  bioPage: one(pages, {
    fields: [userPersonalization.bioPageId],
    references: [pages.id],
  }),
  writingStylePage: one(pages, {
    fields: [userPersonalization.writingStylePageId],
    references: [pages.id],
  }),
  rulesPage: one(pages, {
    fields: [userPersonalization.rulesPageId],
    references: [pages.id],
  }),
}));

// Type exports for use in application code
export type UserPersonalization = typeof userPersonalization.$inferSelect;
export type NewUserPersonalization = typeof userPersonalization.$inferInsert;

/**
 * Staging table for memory insights awaiting corroboration.
 *
 * Insights from the discovery service are upserted here daily. A claim must be
 * observed on at least 2 distinct UTC days (3 for bio) before promotion to the
 * actual personalization pages. Claims not re-observed within 30 days are pruned.
 *
 * claimKey is a normalized (lowercased, punctuation-stripped, whitespace-collapsed)
 * version of claim, used for deduplication via unique index.
 */
export const personalizationCandidates = pgTable('personalization_candidates', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),

  field: text('field').notNull(), // 'bio' | 'writingStyle' | 'rules' — see fieldValues check below

  claim: text('claim').notNull(),
  claimKey: text('claimKey').notNull(), // normalized for dedupe
  evidence: text('evidence').notNull(), // verbatim quote from user message

  occurrences: integer('occurrences').default(1).notNull(),

  firstSeenAt: timestamp('firstSeenAt', { mode: 'date' }).defaultNow().notNull(),
  lastSeenAt: timestamp('lastSeenAt', { mode: 'date' }).defaultNow().notNull(),
  promotedAt: timestamp('promotedAt', { mode: 'date' }),
  rejectedAt: timestamp('rejectedAt', { mode: 'date' }),
}, (table) => ({
  userFieldClaimIdx: uniqueIndex('personalization_candidates_user_field_claim_idx')
    .on(table.userId, table.field, table.claimKey),
  fieldValues: check(
    'personalization_candidates_field_chk',
    sql`${table.field} IN ('bio', 'writingStyle', 'rules')`,
  ),
}));

export const personalizationCandidatesRelations = relations(personalizationCandidates, ({ one }) => ({
  user: one(users, {
    fields: [personalizationCandidates.userId],
    references: [users.id],
  }),
}));

export type PersonalizationCandidate = typeof personalizationCandidates.$inferSelect;
export type NewPersonalizationCandidate = typeof personalizationCandidates.$inferInsert;
