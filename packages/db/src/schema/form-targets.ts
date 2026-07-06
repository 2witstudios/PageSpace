import { pgTable, text, timestamp, integer, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { drives, pages } from './core';

export type FormTargetAction = 'sheet:append';

export type FormFieldType = 'text' | 'email' | 'textarea' | 'checkbox';

export interface FormFieldDef {
  name: string;
  label: string;
  type: FormFieldType;
  required: boolean;
}

export type FormTargetStatus = 'active' | 'paused' | 'archived';

/**
 * A narrowly-scoped, revocable public write grant: {driveId, pageId, action}
 * only, never a session or drive membership. `tokenHash` is the sole lookup
 * key at submit time — status is re-read on every request, so pausing takes
 * effect on the very next submission with no propagation delay.
 */
export const formTargets = pgTable('form_targets', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  tokenHash: text('token_hash').unique().notNull(),
  tokenPrefix: text('token_prefix').notNull(),

  driveId: text('drive_id').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  pageId: text('page_id').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  action: text('action', { enum: ['sheet:append'] }).notNull().default('sheet:append'),

  // Ordered — fields[i] always maps to sheet column i, fixed at provisioning
  // time. Never re-derived from the sheet's live header row, so manually
  // editing/reordering the header row after provisioning silently desyncs it
  // from this mapping — no drift detection exists (v1 limitation, see
  // canvas-forms.md).
  fields: jsonb('fields').notNull().$type<FormFieldDef[]>(),

  headerRow: integer('header_row').notNull().default(1),
  nextRow: integer('next_row').notNull(),

  status: text('status', { enum: ['active', 'paused', 'archived'] }).notNull().default('active'),
  statusReason: text('status_reason'),

  createdBy: text('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
  lastSubmittedAt: timestamp('last_submitted_at', { mode: 'date' }),
  submissionCount: integer('submission_count').notNull().default(0),
}, (table) => ({
  // No separate index on tokenHash — .unique() already backs it with an
  // implicit unique btree index; a duplicate index would double write-time
  // maintenance cost for no benefit.
  pageIdx: index('form_targets_page_id_idx').on(table.pageId),
  driveIdx: index('form_targets_drive_id_idx').on(table.driveId),
  statusIdx: index('form_targets_status_idx').on(table.status),
  // At most one ACTIVE form target per Sheet page — enforced in Postgres
  // (not just app logic) so two concurrent provisions can't both succeed and
  // silently share/collide on `nextRow`. Paused/archived rows are unaffected,
  // so archiving one target and provisioning a new one on the same sheet
  // still works. Mirrors workflow_runs_running_claim_idx's partial-unique
  // "one active X per Y" pattern.
  oneActivePerPageIdx: uniqueIndex('form_targets_one_active_per_page_idx')
    .on(table.pageId)
    .where(sql`${table.status} = 'active'`),
}));

export const formTargetsRelations = relations(formTargets, ({ one }) => ({
  page: one(pages, { fields: [formTargets.pageId], references: [pages.id] }),
  drive: one(drives, { fields: [formTargets.driveId], references: [drives.id] }),
  creator: one(users, { fields: [formTargets.createdBy], references: [users.id] }),
}));

export type FormTarget = typeof formTargets.$inferSelect;
export type NewFormTarget = typeof formTargets.$inferInsert;
