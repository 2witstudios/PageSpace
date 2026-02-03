import { pgTable, text, timestamp, boolean, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './auth';
import { createId } from '@paralleldrive/cuid2';

/**
 * User personalization settings for AI interactions.
 * These fields are injected into the AI system prompt when enabled.
 */
export const userPersonalization = pgTable('user_personalization', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Personalization content fields
  bio: text('bio'), // User's background, role, expertise
  writingStyle: text('writingStyle'), // Preferred communication style
  rules: text('rules'), // Custom rules/instructions for AI

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
}));

// Type exports for use in application code
export type UserPersonalization = typeof userPersonalization.$inferSelect;
export type NewUserPersonalization = typeof userPersonalization.$inferInsert;
