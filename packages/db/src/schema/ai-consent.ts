import { pgTable, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';

/**
 * Per-user record that the user consented to their prompts leaving the platform —
 * sent to external AI providers, potentially outside the EU (GDPR Art 13(1)(e)(f), 44).
 *
 * policyVersion lets us force re-consent when the disclosure materially changes.
 * A unique partial index allows at most one ACTIVE (non-revoked) row per user.
 */
export const aiProcessingConsents = pgTable('ai_processing_consents', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  policyVersion: integer('policyVersion').notNull(),
  consentedAt: timestamp('consentedAt', { mode: 'date' }).defaultNow().notNull(),
  revokedAt: timestamp('revokedAt', { mode: 'date' }),
}, (table) => {
  return {
    userIdx: index('ai_processing_consents_user_id_idx').on(table.userId),
    activeConsentUnique: uniqueIndex('ai_processing_consents_active_user_unique')
      .on(table.userId)
      .where(sql`${table.revokedAt} IS NULL`),
  };
});

export const aiProcessingConsentsRelations = relations(aiProcessingConsents, ({ one }) => ({
  user: one(users, {
    fields: [aiProcessingConsents.userId],
    references: [users.id],
  }),
}));
