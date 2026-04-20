import { pgTable, text, jsonb, timestamp, index, primaryKey } from 'drizzle-orm/pg-core';

export const authHandoffTokens = pgTable('auth_handoff_tokens', {
  tokenHash: text('token_hash').notNull(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull(),
  expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  pk: primaryKey({ columns: [table.tokenHash, table.kind] }),
  expiresAtIdx: index('auth_handoff_tokens_expires_at_idx').on(table.expiresAt),
  kindExpiresAtIdx: index('auth_handoff_tokens_kind_expires_at_idx').on(table.kind, table.expiresAt),
}));

export type AuthHandoffToken = typeof authHandoffTokens.$inferSelect;
export type NewAuthHandoffToken = typeof authHandoffTokens.$inferInsert;
