import { pgTable, text, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  // Token storage - ALWAYS hashed
  tokenHash: text('token_hash').unique().notNull(),
  tokenPrefix: text('token_prefix').notNull(),

  // Identity
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Session metadata
  type: text('type', { enum: ['user', 'service', 'mcp', 'device'] }).notNull(),
  scopes: text('scopes').array().notNull().default(sql`ARRAY[]::text[]`),

  // Resource binding
  resourceType: text('resource_type'),
  resourceId: text('resource_id'),

  // Security context
  tokenVersion: integer('token_version').notNull(),
  createdByService: text('created_by_service'),
  createdByIp: text('created_by_ip'),

  // Lifecycle
  expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
  lastUsedAt: timestamp('last_used_at', { mode: 'date' }),
  lastUsedIp: text('last_used_ip'),
  revokedAt: timestamp('revoked_at', { mode: 'date' }),
  revokedReason: text('revoked_reason'),

  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  tokenHashIdx: index('sessions_token_hash_idx').on(table.tokenHash),
  userIdIdx: index('sessions_user_id_idx').on(table.userId),
  expiresAtIdx: index('sessions_expires_at_idx').on(table.expiresAt),
  userActiveIdx: index('sessions_user_active_idx').on(table.userId, table.revokedAt, table.expiresAt),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));
