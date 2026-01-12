import { pgTable, text, timestamp, integer, index, uniqueIndex, pgEnum, real } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { chatMessages } from './core';

export const userRole = pgEnum('UserRole', ['user', 'admin']);
export const authProvider = pgEnum('AuthProvider', ['email', 'google', 'both']);
export const platformType = pgEnum('PlatformType', ['web', 'desktop', 'ios', 'android']);

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
  // Storage tracking fields (quota/tier now computed from subscriptionTier)
  storageUsedBytes: real('storageUsedBytes').default(0).notNull(),
  activeUploads: integer('activeUploads').default(0).notNull(),
  lastStorageCalculated: timestamp('lastStorageCalculated', { mode: 'date' }),
  // Subscription fields
  stripeCustomerId: text('stripeCustomerId').unique(),
  subscriptionTier: text('subscriptionTier').default('free').notNull(), // 'free' | 'pro' | 'founder' | 'business'
  tosAcceptedAt: timestamp('tosAcceptedAt', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
});

export const refreshTokens = pgTable('refresh_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').unique().notNull(),
  tokenHash: text('tokenHash'),
  tokenPrefix: text('tokenPrefix'),
  device: text('device'),
  ip: text('ip'),
  userAgent: text('userAgent'),
  expiresAt: timestamp('expiresAt', { mode: 'date' }),
  lastUsedAt: timestamp('lastUsedAt', { mode: 'date' }),
  platform: platformType('platform'),
  deviceTokenId: text('deviceTokenId'),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
  return {
    userIdx: index('refresh_tokens_user_id_idx').on(table.userId),
    tokenHashPartialIdx: uniqueIndex('refresh_tokens_token_hash_partial_idx')
      .on(table.tokenHash)
      .where(sql`${table.tokenHash} IS NOT NULL`),
  };
});

export const deviceTokens = pgTable('device_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Token information - SECURITY: token column stores hash, not plaintext
  token: text('token').unique().notNull(),
  tokenHash: text('tokenHash'),
  tokenPrefix: text('tokenPrefix'),
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
  lastUsedAt: timestamp('lastUsedAt', { mode: 'date' }),

  // Device identification (fingerprinting)
  deviceId: text('deviceId').notNull(),
  platform: platformType('platform').notNull(),
  deviceName: text('deviceName'),

  // Security tracking
  userAgent: text('userAgent'),
  ipAddress: text('ipAddress'),
  lastIpAddress: text('lastIpAddress'),
  location: text('location'),

  // Risk scoring
  trustScore: real('trustScore').default(1.0).notNull(),
  suspiciousActivityCount: integer('suspiciousActivityCount').default(0).notNull(),

  // Metadata
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  revokedAt: timestamp('revokedAt', { mode: 'date' }),
  revokedReason: text('revokedReason'),
}, (table) => {
  return {
    userIdx: index('device_tokens_user_id_idx').on(table.userId),
    tokenIdx: index('device_tokens_token_idx').on(table.token),
    deviceIdx: index('device_tokens_device_id_idx').on(table.deviceId),
    expiresIdx: index('device_tokens_expires_at_idx').on(table.expiresAt),
    tokenHashPartialIdx: uniqueIndex('device_tokens_token_hash_partial_idx')
      .on(table.tokenHash)
      .where(sql`${table.tokenHash} IS NOT NULL`),
    // Partial unique index: only enforce uniqueness for non-revoked tokens
    // Expired tokens are automatically revoked before new token creation to prevent conflicts
    activeDeviceIdx: uniqueIndex('device_tokens_active_device_idx')
      .on(table.userId, table.deviceId, table.platform)
      .where(sql`${table.revokedAt} IS NULL`),
  };
});

export const mcpTokens = pgTable('mcp_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').unique().notNull(),
  tokenHash: text('tokenHash'),
  tokenPrefix: text('tokenPrefix'),
  name: text('name').notNull(),
  lastUsed: timestamp('lastUsed', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  revokedAt: timestamp('revokedAt', { mode: 'date' }),
}, (table) => {
  return {
    userIdx: index('mcp_tokens_user_id_idx').on(table.userId),
    tokenIdx: index('mcp_tokens_token_idx').on(table.token),
    tokenHashPartialIdx: uniqueIndex('mcp_tokens_token_hash_partial_idx')
      .on(table.tokenHash)
      .where(sql`${table.tokenHash} IS NOT NULL`),
  };
});

export const verificationTokens = pgTable('verification_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // SECURITY: token column stores hash, not plaintext
  token: text('token').unique().notNull(),
  tokenHash: text('tokenHash'),
  tokenPrefix: text('tokenPrefix'),
  type: text('type').notNull(), // 'email_verification' | 'password_reset' | 'magic_link'
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  usedAt: timestamp('usedAt', { mode: 'date' }),
}, (table) => {
  return {
    userIdx: index('verification_tokens_user_id_idx').on(table.userId),
    tokenIdx: index('verification_tokens_token_idx').on(table.token),
    typeIdx: index('verification_tokens_type_idx').on(table.type),
    tokenHashPartialIdx: uniqueIndex('verification_tokens_token_hash_partial_idx')
      .on(table.tokenHash)
      .where(sql`${table.tokenHash} IS NOT NULL`),
  };
});

// Socket tokens for cross-origin Socket.IO authentication
// Short-lived tokens (5 min) that bypass sameSite: 'strict' cookie restrictions
export const socketTokens = pgTable('socket_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // SECURITY: Only store hash, never plaintext
  tokenHash: text('tokenHash').unique().notNull(),
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
  return {
    userIdx: index('socket_tokens_user_id_idx').on(table.userId),
    tokenHashIdx: index('socket_tokens_token_hash_idx').on(table.tokenHash),
    expiresAtIdx: index('socket_tokens_expires_at_idx').on(table.expiresAt),
  };
});

import { userAiSettings } from './ai';
import { subscriptions } from './subscriptions';
import { sessions } from './sessions';

export const usersRelations = relations(users, ({ many }) => ({
  refreshTokens: many(refreshTokens),
  deviceTokens: many(deviceTokens),
  chatMessages: many(chatMessages),
  aiSettings: many(userAiSettings),
  mcpTokens: many(mcpTokens),
  verificationTokens: many(verificationTokens),
  socketTokens: many(socketTokens),
  subscriptions: many(subscriptions),
  sessions: many(sessions),
}));

export const refreshTokensRelations = relations(refreshTokens, ({ one }) => ({
  user: one(users, {
    fields: [refreshTokens.userId],
    references: [users.id],
  }),
}));

export const deviceTokensRelations = relations(deviceTokens, ({ one }) => ({
  user: one(users, {
    fields: [deviceTokens.userId],
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

export const socketTokensRelations = relations(socketTokens, ({ one }) => ({
  user: one(users, {
    fields: [socketTokens.userId],
    references: [users.id],
  }),
}));