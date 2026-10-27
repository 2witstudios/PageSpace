import { pgTable, text, integer, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';

export const rateLimitBuckets = pgTable('rate_limit_buckets', {
  key: text('key').notNull(),
  windowStart: timestamp('window_start', { mode: 'date', withTimezone: true }).notNull(),
  count: integer('count').notNull().default(0),
  expiresAt: timestamp('expires_at', { mode: 'date', withTimezone: true }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.key, table.windowStart] }),
  expiresAtIdx: index('rate_limit_buckets_expires_at_idx').on(table.expiresAt),
}));
