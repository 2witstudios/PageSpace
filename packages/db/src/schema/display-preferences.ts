import { pgTable, pgEnum, text, timestamp, boolean, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { createId } from '@paralleldrive/cuid2';

export const displayPreferenceType = pgEnum('display_preference_type', [
  'SHOW_TOKEN_COUNTS',
  'SHOW_CODE_TOGGLE',
]);

export const displayPreferences = pgTable('display_preferences', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  preferenceType: displayPreferenceType('preferenceType').notNull(),
  enabled: boolean('enabled').default(false).notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  userTypeIdx: index('display_preferences_user_type_idx').on(table.userId, table.preferenceType),
}));

export const displayPreferencesRelations = relations(displayPreferences, ({ one }) => ({
  user: one(users, {
    fields: [displayPreferences.userId],
    references: [users.id],
  }),
}));
