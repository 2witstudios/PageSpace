import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { createId } from '@paralleldrive/cuid2';

export const userHotkeyPreferences = pgTable('user_hotkey_preferences', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  hotkeyId: text('hotkeyId').notNull(), // e.g., 'tabs.cycle-next'
  binding: text('binding').notNull(), // e.g., 'Ctrl+Tab' or empty string to disable
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  userHotkeyIdx: uniqueIndex('user_hotkey_preferences_user_hotkey_idx').on(table.userId, table.hotkeyId),
  userIdx: index('user_hotkey_preferences_user_idx').on(table.userId),
}));

export const userHotkeyPreferencesRelations = relations(userHotkeyPreferences, ({ one }) => ({
  user: one(users, {
    fields: [userHotkeyPreferences.userId],
    references: [users.id],
  }),
}));
