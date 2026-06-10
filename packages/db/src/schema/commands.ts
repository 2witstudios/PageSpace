/**
 * Universal Commands - Database Schema
 *
 * Slash commands backed by page subtrees (Agent Skills standard): the entry
 * page is the skill body, its direct children are discoverable resources.
 * A command belongs to EITHER a user OR a drive (exactly one), mirroring the
 * integration_connections scope pattern.
 */

import {
  pgTable,
  text,
  timestamp,
  boolean,
  index,
  unique,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { drives, pages } from './core';

export const commands = pgTable(
  'commands',
  {
    id: text('id').primaryKey().$defaultFn(() => createId()),

    // EITHER user OR drive (determines scope)
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    driveId: text('drive_id').references(() => drives.id, { onDelete: 'cascade' }),

    // The slash trigger (Agent Skills 'name' rules; validated in @pagespace/lib)
    trigger: text('trigger').notNull(),

    // What it does + when to use it (required by the Agent Skills spec)
    description: text('description').notNull(),

    // Entry page = the skill body; its direct children are the resources
    entryPageId: text('entry_page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),

    // 'document' in v1; 'prompt_template' and 'builtin' reserved for later
    type: text('type').notNull().default('document'),

    enabled: boolean('enabled').default(true).notNull(),

    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => ({
    userIdx: index('commands_user_id_idx').on(table.userId),
    driveIdx: index('commands_drive_id_idx').on(table.driveId),
    entryPageIdx: index('commands_entry_page_id_idx').on(table.entryPageId),
    userTriggerUnique: unique('commands_user_trigger').on(table.userId, table.trigger),
    driveTriggerUnique: unique('commands_drive_trigger').on(table.driveId, table.trigger),
    userOrDriveScope: check(
      'commands_scope_chk',
      sql`(${table.userId} IS NOT NULL AND ${table.driveId} IS NULL) OR (${table.userId} IS NULL AND ${table.driveId} IS NOT NULL)`
    ),
    typeAllowedValues: check(
      'commands_type_chk',
      sql`${table.type} IN ('document', 'prompt_template', 'builtin')`
    ),
  })
);

export const commandsRelations = relations(commands, ({ one }) => ({
  user: one(users, {
    fields: [commands.userId],
    references: [users.id],
  }),
  drive: one(drives, {
    fields: [commands.driveId],
    references: [drives.id],
  }),
  entryPage: one(pages, {
    fields: [commands.entryPageId],
    references: [pages.id],
  }),
}));

export type SelectCommand = typeof commands.$inferSelect;
export type InsertCommand = typeof commands.$inferInsert;
