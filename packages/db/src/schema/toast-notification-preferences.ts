import { pgTable, pgEnum, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { createId } from '@paralleldrive/cuid2';

export const toastNotificationLevel = pgEnum('toast_notification_level', ['all', 'mentions', 'off']);

/**
 * Global on/off tier for live in-app toast pop-ups (Discord/Slack-style
 * "All messages" / "Mentions only" / "Nothing"). Opt-out semantics: a
 * missing row means the tier is 'all', consistent with `userAutomationPreferences`.
 * Separate from `email_notification_preferences`, which is per-type and
 * governs a different surface (email delivery, not the live toast).
 */
export const userToastNotificationPreferences = pgTable('user_toast_notification_preferences', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  level: toastNotificationLevel('level').default('all').notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  userIdx: uniqueIndex('user_toast_notification_preferences_user_idx').on(table.userId),
}));

export const userToastNotificationPreferencesRelations = relations(userToastNotificationPreferences, ({ one }) => ({
  user: one(users, {
    fields: [userToastNotificationPreferences.userId],
    references: [users.id],
  }),
}));

export type UserToastNotificationPreferences = typeof userToastNotificationPreferences.$inferSelect;
export type NewUserToastNotificationPreferences = typeof userToastNotificationPreferences.$inferInsert;
