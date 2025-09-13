import { pgTable, text, timestamp, integer, index, pgEnum, real } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { chatMessages } from './core';

export const userRole = pgEnum('UserRole', ['user', 'admin']);
export const authProvider = pgEnum('AuthProvider', ['email', 'google', 'both']);

export const users = pgTable('users', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull(),
  email: text('email').unique().notNull(),
  emailVerified: timestamp('emailVerified', { mode: 'date' }),
  image: text('image'),
  password: text('password'),
  googleId: text('googleId').unique(),
  provider: authProvider('provider').default('email').notNull(),
  tokenVersion: integer('tokenVersion').default(0).notNull(),
  role: userRole('role').default('user').notNull(),
  currentAiProvider: text('currentAiProvider').default('pagespace').notNull(),
  currentAiModel: text('currentAiModel').default('qwen/qwen3-coder:free').notNull(),
  // Storage tracking fields
  storageUsedBytes: real('storageUsedBytes').default(0).notNull(),
  storageQuotaBytes: real('storageQuotaBytes').default(524288000).notNull(), // 500MB default
  storageTier: text('storageTier').default('free').notNull(),
  activeUploads: integer('activeUploads').default(0).notNull(),
  lastStorageCalculated: timestamp('lastStorageCalculated', { mode: 'date' }),
});

export const refreshTokens = pgTable('refresh_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').unique().notNull(),
  device: text('device'),
  ip: text('ip'),
  userAgent: text('userAgent'),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
  return {
    userIdx: index('refresh_tokens_user_id_idx').on(table.userId),
  };
});

export const mcpTokens = pgTable('mcp_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').unique().notNull(),
  name: text('name').notNull(),
  lastUsed: timestamp('lastUsed', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  revokedAt: timestamp('revokedAt', { mode: 'date' }),
}, (table) => {
  return {
    userIdx: index('mcp_tokens_user_id_idx').on(table.userId),
    tokenIdx: index('mcp_tokens_token_idx').on(table.token),
  };
});

import { userAiSettings } from './ai';

export const usersRelations = relations(users, ({ many }) => ({
  refreshTokens: many(refreshTokens),
  chatMessages: many(chatMessages),
  aiSettings: many(userAiSettings),
  mcpTokens: many(mcpTokens),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, {
    fields: [refreshTokens.userId],
    references: [users.id],
  }),
}));

export const mcpTokensRelations = relations(mcpTokens, ({ one }) => ({
  user: one(users, {
    fields: [mcpTokens.userId],
    references: [users.id],
  }),
}));