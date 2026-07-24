import { pgTable, text, timestamp, integer, index, uniqueIndex, pgEnum, real, boolean } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { chatMessages } from './core';

export const userRole = pgEnum('UserRole', ['user', 'admin']);
export const authProvider = pgEnum('AuthProvider', ['email', 'google', 'apple']);
export const platformType = pgEnum('PlatformType', ['web', 'desktop', 'ios', 'android']);

export const users = pgTable('users', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  // `name` and `email` hold AES-256-GCM ciphertext at rest (GDPR #965). Email
  // equality lookups + uniqueness run against `emailBidx` (deterministic HMAC
  // blind index) instead of the raw email value. See
  // docs/security/pii-encryption-design.md.
  name: text('name').notNull(),
  email: text('email').unique().notNull(),
  // Deterministic blind index of the normalized email — unique, queryable.
  // Nullable during backfill; becomes the canonical lookup key once populated.
  emailBidx: text('emailBidx'),
  emailVerified: timestamp('emailVerified', { mode: 'date' }),
  image: text('image'),

  googleId: text('googleId').unique(),
  appleId: text('appleId').unique(),
  provider: authProvider('provider').default('email').notNull(),
  tokenVersion: integer('tokenVersion').default(0).notNull(),
  role: userRole('role').default('user').notNull(),
  adminRoleVersion: integer('adminRoleVersion').default(0).notNull(),
  currentAiProvider: text('currentAiProvider').default('openai').notNull(),
  currentAiModel: text('currentAiModel').default('openai/gpt-5.3-chat').notNull(),
  // Chosen OpenRouter image-generation model (null = none configured → tool uses the
  // system default). Deliberately separate from currentAiModel: image generation is a
  // tool, not the chat model, and is never shown in the model selector.
  imageGenerationModel: text('imageGenerationModel'),
  // Storage tracking fields (quota/tier now computed from subscriptionTier).
  // storageUsedBytes is a CACHE, not a source of truth: the authoritative value
  // is SUM(files.sizeBytes) over files.createdBy = this user (the charge basis).
  // It exists so quota checks don't pay an aggregate per upload, and it is kept
  // honest by the scheduled reconcile (api/cron/reconcile-storage →
  // reconcileAllStorageUsage), which rewrites it from the files rows when it
  // drifts. Never treat a read of this column as exact (#2155).
  storageUsedBytes: real('storageUsedBytes').default(0).notNull(),
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
  // User timezone for correct time-of-day calculations (IANA timezone, e.g., "America/New_York")
  timezone: text('timezone'),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date' }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => ({
  // Unique blind-index lookup for email (preserves the email uniqueness
  // guarantee once the raw-email unique constraint is retired post-backfill).
  emailBidxIdx: uniqueIndex('users_email_bidx_idx').on(table.emailBidx),
}));

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


export const verificationTokens = pgTable('verification_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),

  // Token storage - hash only (matching sessions table pattern)
  tokenHash: text('tokenHash').unique().notNull(),
  tokenPrefix: text('tokenPrefix').notNull(),

  type: text('type').notNull(), // 'email_verification' | 'magic_link' | 'webauthn_signup'
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  usedAt: timestamp('usedAt', { mode: 'date' }),
  // Optional JSON metadata for extended token data (e.g., signup email/name)
  metadata: text('metadata'),
}, (table) => {
  return {
    userIdx: index('verification_tokens_user_id_idx').on(table.userId),
    tokenHashIdx: index('verification_tokens_token_hash_idx').on(table.tokenHash),
    typeIdx: index('verification_tokens_type_idx').on(table.type),
  };
});

// DEPRECATED (#1054): superseded by the unified `sessions` table with
// `type: 'socket'`, minted/validated through opaque-tokens.ts + session-service.ts
// like every other token type. No longer written to. Left in place (rather than
// dropped) so the retention-cleanup job keeps purging any legacy rows and so we
// avoid a table drop in the same PR that changes the write path. Safe to drop in
// a follow-up once confirmed empty in production.
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

import { subscriptions } from './subscriptions';
import { sessions } from './sessions';

export const usersRelations = relations(users, ({ many }) => ({
  deviceTokens: many(deviceTokens),
  chatMessages: many(chatMessages),
  mcpTokens: many(mcpTokens),
  verificationTokens: many(verificationTokens),
  socketTokens: many(socketTokens),
  subscriptions: many(subscriptions),
  sessions: many(sessions),
  emailUnsubscribeTokens: many(emailUnsubscribeTokens),
  passkeys: many(passkeys),
}));

export const deviceTokensRelations = relations(deviceTokens, ({ one }) => ({
  user: one(users, {
    fields: [deviceTokens.userId],
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

// Passkeys for WebAuthn authentication
export const passkeys = pgTable('passkeys', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  credentialId: text('credential_id').notNull().unique(),
  publicKey: text('public_key').notNull(),
  counter: integer('counter').notNull().default(0),
  deviceType: text('device_type'),
  transports: text('transports').array(),
  backedUp: boolean('backed_up').default(false),
  name: text('name'),
  lastUsedAt: timestamp('last_used_at', { mode: 'date' }),
  createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  userIdx: index('passkeys_user_id_idx').on(table.userId),
  credentialIdx: index('passkeys_credential_id_idx').on(table.credentialId),
}));

export const passkeysRelations = relations(passkeys, ({ one }) => ({
  user: one(users, {
    fields: [passkeys.userId],
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