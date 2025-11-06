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
  currentAiModel: text('currentAiModel').default('glm-4.5-air').notNull(),
  // Global assistant agent selection
  selectedGlobalAgentId: text('selectedGlobalAgentId'), // References pages.id of AI_CHAT type
  // Storage tracking fields (quota/tier now computed from subscriptionTier)
  storageUsedBytes: real('storageUsedBytes').default(0).notNull(),
  activeUploads: integer('activeUploads').default(0).notNull(),
  lastStorageCalculated: timestamp('lastStorageCalculated', { mode: 'date' }),
  // Subscription fields
  stripeCustomerId: text('stripeCustomerId').unique(),
  subscriptionTier: text('subscriptionTier').default('free').notNull(), // 'free' or 'pro' or 'business'
  tosAcceptedAt: timestamp('tosAcceptedAt', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
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

export const verificationTokens = pgTable('verification_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').unique().notNull(),
  type: text('type').notNull(), // 'email_verification' | 'password_reset' | 'magic_link'
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  usedAt: timestamp('usedAt', { mode: 'date' }),
}, (table) => {
  return {
    userIdx: index('verification_tokens_user_id_idx').on(table.userId),
    tokenIdx: index('verification_tokens_token_idx').on(table.token),
    typeIdx: index('verification_tokens_type_idx').on(table.type),
  };
});

import { userAiSettings } from './ai';
import { subscriptions } from './subscriptions';

export const usersRelations = relations(users, ({ many }) => ({
  refreshTokens: many(refreshTokens),
  chatMessages: many(chatMessages),
  aiSettings: many(userAiSettings),
  mcpTokens: many(mcpTokens),
  verificationTokens: many(verificationTokens),
  subscriptions: many(subscriptions),
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

export const verificationTokensRelations = relations(verificationTokens, ({ one }) => ({
  user: one(users, {
    fields: [verificationTokens.userId],
    references: [users.id],
  }),
}));