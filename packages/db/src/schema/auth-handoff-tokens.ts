import { pgTable, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

export const authHandoffTokens = pgTable('auth_handoff_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull(),
  expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  expiresAtIdx: index('auth_handoff_tokens_expires_at_idx').on(table.expiresAt),
  kindExpiresAtIdx: index('auth_handoff_tokens_kind_expires_at_idx').on(table.kind, table.expiresAt),
}));

export type AuthHandoffToken = typeof authHandoffTokens.$inferSelect;
export type NewAuthHandoffToken = typeof authHandoffTokens.$inferInsert;
