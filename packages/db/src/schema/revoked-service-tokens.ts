import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';

export const revokedServiceTokens = pgTable('revoked_service_tokens', {
  jti: text('jti').primaryKey(),
  revokedAt: timestamp('revoked_at', { mode: 'date', withTimezone: true }),
  expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
}, (table) => ({
  expiresAtIdx: index('revoked_service_tokens_expires_at_idx').on(table.expiresAt),
}));

export type RevokedServiceToken = typeof revokedServiceTokens.$inferSelect;
export type NewRevokedServiceToken = typeof revokedServiceTokens.$inferInsert;
