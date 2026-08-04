/**
 * Plans - Database Schema
 *
 * Structured plan status keyed 1:1 to a page (published_pages pattern): the
 * plan's written content stays a normal DOCUMENT page; this table gives it a
 * durable, tool-queryable identity (status + goal) that survives context
 * compaction, so a later turn or skill can look up "what plan am I executing
 * against" instead of trusting the model's memory of the conversation.
 */

import { pgTable, text, timestamp, index, unique } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { drives, pages } from './core';

export const plans = pgTable(
  'plans',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),

    // The DOCUMENT page holding the plan's written content. Unique: one plan
    // row per page — revisions edit the page, replacements supersede the row.
    pageId: text('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),

    // Denormalized for indexing (same reasoning as published_pages.driveId).
    driveId: text('drive_id')
      .notNull()
      .references(() => drives.id, { onDelete: 'cascade' }),

    // 'draft' | 'approved' | 'superseded'
    status: text('status').notNull().default('draft'),

    // One-line summary so list/lookup tools don't have to open the page.
    goal: text('goal').notNull(),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    approvedBy: text('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { mode: 'date' }),

    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    pageKey: unique('plans_page_id_key').on(table.pageId),
    driveIdx: index('plans_drive_id_idx').on(table.driveId),
    statusIdx: index('plans_status_idx').on(table.status),
    pageIdx: index('plans_page_id_idx').on(table.pageId),
  })
);

export const plansRelations = relations(plans, ({ one }) => ({
  page: one(pages, { fields: [plans.pageId], references: [pages.id] }),
  drive: one(drives, { fields: [plans.driveId], references: [drives.id] }),
  creator: one(users, { fields: [plans.createdBy], references: [users.id] }),
  approver: one(users, { fields: [plans.approvedBy], references: [users.id] }),
}));

export type Plan = typeof plans.$inferSelect;
export type NewPlan = typeof plans.$inferInsert;
