import { pgTable, text, timestamp, boolean, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { createId } from '@paralleldrive/cuid2';

/**
 * Per-user on/off switches for the system AI cron jobs that spend prepaid credits
 * automatically. Currently just Pulse (daily workspace summary); Memory's switch
 * reuses `user_personalization.enabled`, so it isn't duplicated here.
 *
 * Opt-OUT semantics: a missing row means every automation is ON. `pulseEnabled`
 * defaults true so absence ⇒ enabled (the inverse of `display_preferences`, which is
 * default-false opt-in — that mismatch is why this lives in its own table).
 */
export const userAutomationPreferences = pgTable('user_automation_preferences', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Daily Pulse workspace summary (api/pulse/cron). True = generate automatically.
  pulseEnabled: boolean('pulseEnabled').default(true).notNull(),

  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  userIdx: uniqueIndex('user_automation_preferences_user_idx').on(table.userId),
}));

export const userAutomationPreferencesRelations = relations(userAutomationPreferences, ({ one }) => ({
  user: one(users, {
    fields: [userAutomationPreferences.userId],
    references: [users.id],
  }),
}));

export type UserAutomationPreferences = typeof userAutomationPreferences.$inferSelect;
export type NewUserAutomationPreferences = typeof userAutomationPreferences.$inferInsert;
