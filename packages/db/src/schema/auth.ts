import { pgTable, text, timestamp, integer, index, uniqueIndex, pgEnum, real, boolean } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { chatMessages } from './core';

export const userRole = pgEnum('UserRole', ['user', 'admin']);
export const authProvider = pgEnum('AuthProvider', ['email', 'google', 'apple', 'both']);
export const platformType = pgEnum('PlatformType', ['web', 'desktop', 'ios', 'android']);

export const users = pgTable('users', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  name: text('name').notNull(),
  email: text('email').unique().notNull(),
  emailVerified: timestamp('emailVerified', { mode: 'date' }),
  image: text('image'),
  password: text('password'),
  googleId: text('googleId').unique(),
  appleId: text('appleId').unique(),
  provider: authProvider('provider').default('email').notNull(),
  tokenVersion: integer('tokenVersion').default(0).notNull(),
  role: userRole('role').default('user').notNull(),
  adminRoleVersion: integer('adminRoleVersion').default(0).notNull(),
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
  // Account lockout fields
  failedLoginAttempts: integer('failedLoginAttempts').default(0).notNull(),
  lockedUntil: timestamp('lockedUntil', { mode: 'date' }),
  // Account suspension (administrative action)
  suspendedAt: timestamp('suspendedAt', { mode: 'date' }),
  suspendedReason: text('suspendedReason'),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
});

export const deviceTokens = pgTable('device_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Token storage - hash only (matching sessions table pattern)
  tokenHash: text('tokenHash').unique().notNull(),
  tokenPrefix: text('tokenPrefix').notNull(),
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
  lastUsedAt: timestamp('lastUsedAt', { mode: 'date' }),

  // Device identification
  deviceId: text('deviceId').notNull(),
  platform: platformType('platform').notNull(),
  deviceName: text('deviceName'),

  // Token version for invalidation
  tokenVersion: integer('tokenVersion').default(0).notNull(),

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
  replacedByTokenId: text('replacedByTokenId'),
}, (table) => {
  return {
    userIdx: index('device_tokens_user_id_idx').on(table.userId),
    tokenHashIdx: index('device_tokens_token_hash_idx').on(table.tokenHash),
    deviceIdx: index('device_tokens_device_id_idx').on(table.deviceId),
    expiresIdx: index('device_tokens_expires_at_idx').on(table.expiresAt),
    activeDeviceIdx: uniqueIndex('device_tokens_active_device_idx')
      .on(table.userId, table.deviceId, table.platform)
      .where(sql`${table.revokedAt} IS NULL`),
  };
});

export const mcpTokens = pgTable('mcp_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Token storage - hash only (matching sessions table pattern)
  tokenHash: text('tokenHash').unique().notNull(),
  tokenPrefix: text('tokenPrefix').notNull(),

  name: text('name').notNull(),
  // Fail-closed security: if true and driveScopes is empty (all drives deleted), deny all access
  // Default false for backward compatibility with existing tokens
  isScoped: boolean('isScoped').notNull().default(false),
  lastUsed: timestamp('lastUsed', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  revokedAt: timestamp('revokedAt', { mode: 'date' }),
}, (table) => {
  return {
    userIdx: index('mcp_tokens_user_id_idx').on(table.userId),
    tokenHashIdx: index('mcp_tokens_token_hash_idx').on(table.tokenHash),
  };
});

// Junction table for MCP token drive scopes
// If a token has no entries here, it has access to ALL user's drives (backward compatible)
// If a token has entries here, it ONLY has access to those specific drives
import { drives } from './core';

export const mcpTokenDrives = pgTable('mcp_token_drives', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  tokenId: text('tokenId').notNull().references(() => mcpTokens.id, { onDelete: 'cascade' }),
  driveId: text('driveId').notNull().references(() => drives.id, { onDelete: 'cascade' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
  return {
    tokenIdx: index('mcp_token_drives_token_id_idx').on(table.tokenId),
    driveIdx: index('mcp_token_drives_drive_id_idx').on(table.driveId),
    tokenDriveUnique: uniqueIndex('mcp_token_drives_token_drive_unique').on(table.tokenId, table.driveId),
  };
});

export const verificationTokens = pgTable('verification_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Token storage - hash only (matching sessions table pattern)
  tokenHash: text('tokenHash').unique().notNull(),
  tokenPrefix: text('tokenPrefix').notNull(),

  type: text('type').notNull(), // 'email_verification' | 'password_reset' | 'magic_link'
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  usedAt: timestamp('usedAt', { mode: 'date' }),
}, (table) => {
  return {
    userIdx: index('verification_tokens_user_id_idx').on(table.userId),
    tokenHashIdx: index('verification_tokens_token_hash_idx').on(table.tokenHash),
    typeIdx: index('verification_tokens_type_idx').on(table.type),
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
  deviceTokens: many(deviceTokens),
  chatMessages: many(chatMessages),
  aiSettings: many(userAiSettings),
  mcpTokens: many(mcpTokens),
  verificationTokens: many(verificationTokens),
  socketTokens: many(socketTokens),
  subscriptions: many(subscriptions),
  sessions: many(sessions),
  emailUnsubscribeTokens: many(emailUnsubscribeTokens),
}));

export const deviceTokensRelations = relations(deviceTokens, ({ one }) => ({
  user: one(users, {
    fields: [deviceTokens.userId],
    references: [users.id],
  }),
}));

export const mcpTokensRelations = relations(mcpTokens, ({ one, many }) => ({
  user: one(users, {
    fields: [mcpTokens.userId],
    references: [users.id],
  }),
  driveScopes: many(mcpTokenDrives),
}));

export const mcpTokenDrivesRelations = relations(mcpTokenDrives, ({ one }) => ({
  token: one(mcpTokens, {
    fields: [mcpTokenDrives.tokenId],
    references: [mcpTokens.id],
  }),
  drive: one(drives, {
    fields: [mcpTokenDrives.driveId],
    references: [drives.id],
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

// Email unsubscribe tokens for one-click email unsubscribe links
// Replaces JWT-based tokens for Legacy JWT Deprecation (P5-T5)
export const emailUnsubscribeTokens = pgTable('email_unsubscribe_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  // SECURITY: Only store hash, never plaintext token
  tokenHash: text('token_hash').unique().notNull(),
  tokenPrefix: text('token_prefix').notNull(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  notificationType: text('notification_type').notNull(),
  expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
  usedAt: timestamp('used_at', { mode: 'date' }),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => {
  return {
    tokenHashIdx: index('email_unsubscribe_tokens_token_hash_idx').on(table.tokenHash),
    userIdx: index('email_unsubscribe_tokens_user_id_idx').on(table.userId),
    expiresAtIdx: index('email_unsubscribe_tokens_expires_at_idx').on(table.expiresAt),
  };
});

export const emailUnsubscribeTokensRelations = relations(emailUnsubscribeTokens, ({ one }) => ({
  user: one(users, {
    fields: [emailUnsubscribeTokens.userId],
    references: [users.id],
  }),
}));