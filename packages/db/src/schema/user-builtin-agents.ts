import { pgTable, text, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { pages } from './core';
import { createId } from '@paralleldrive/cuid2';

/**
 * Per-user pointers to the built-in Imago agents.
 *
 * Each built-in agent (`imago` since IMG-10.10, which retired `imago-planner`
 * and `imago-researcher` — see `@pagespace/lib/agents/builtin-agents`) is an
 * ordinary AI_CHAT page in the
 * user's Home drive; this table records which page is which, the same way
 * `user_personalization` points at the memory pages. `key` is deliberately
 * plain text rather than an enum or CHECK: the registry is code, and adding an
 * agent must not need a migration.
 *
 * Both FKs cascade. Deleting the page removes its pointer, so provisioning sees
 * the key as missing and recreates it; deleting the user removes them all.
 */
export const userBuiltinAgents = pgTable('user_builtin_agents', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  pageId: text('pageId').notNull().references(() => pages.id, { onDelete: 'cascade' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  userKeyIdx: uniqueIndex('user_builtin_agents_user_key_idx').on(table.userId, table.key),
  pageIdx: index('user_builtin_agents_page_idx').on(table.pageId),
}));

export const userBuiltinAgentsRelations = relations(userBuiltinAgents, ({ one }) => ({
  user: one(users, {
    fields: [userBuiltinAgents.userId],
    references: [users.id],
  }),
  page: one(pages, {
    fields: [userBuiltinAgents.pageId],
    references: [pages.id],
  }),
}));

export type UserBuiltinAgent = typeof userBuiltinAgents.$inferSelect;
export type NewUserBuiltinAgent = typeof userBuiltinAgents.$inferInsert;
