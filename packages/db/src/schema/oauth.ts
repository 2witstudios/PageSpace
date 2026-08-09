import { pgTable, text, timestamp, integer, jsonb, boolean, index, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';

export const oauthClientType = pgEnum('OAuthClientType', ['public', 'confidential']);

// OAuth 2.1 clients (ADR 0002 Decision 3). First-party clients (e.g. the CLI,
// client_id "pagespace-cli") are authoritatively defined in a static in-code
// registry, not this table — this table exists to accommodate future RFC 7591
// dynamic client registration.
export const oauthClients = pgTable('oauth_clients', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  clientId: text('clientId').unique().notNull(),
  name: text('name').notNull(),
  clientType: oauthClientType('clientType').notNull(),
  redirectUris: jsonb('redirectUris').$type<string[]>().notNull(),
  isFirstParty: boolean('isFirstParty').default(false).notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
  disabledAt: timestamp('disabledAt', { mode: 'date' }),
}, (table) => ({
  clientIdIdx: index('oauth_clients_client_id_idx').on(table.clientId),
}));

// Authorization codes (RFC 6749 §4.1 + PKCE, RFC 7636). Only the SHA3-256
// hash of the code is stored at rest; codePrefix is for indexed debugging
// lookup only, matching the sessions/device-token convention.
export const oauthAuthorizationCodes = pgTable('oauth_authorization_codes', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  codeHash: text('codeHash').unique().notNull(),
  codePrefix: text('codePrefix').notNull(),
  clientId: text('clientId').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  redirectUri: text('redirectUri').notNull(),
  codeChallenge: text('codeChallenge').notNull(),
  codeChallengeMethod: text('codeChallengeMethod').notNull(),
  scopes: jsonb('scopes').$type<string[]>().notNull(),
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
  consumedAt: timestamp('consumedAt', { mode: 'date' }),
  // Set the moment the code is first (and only) successfully exchanged, so a
  // replay of the same code (ADR 0003 §2 "already_consumed") can revoke every
  // refresh/access token that family ever issued, not just the code itself.
  issuedFamilyId: text('issuedFamilyId'),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  clientIdx: index('oauth_authorization_codes_client_id_idx').on(table.clientId),
  userIdx: index('oauth_authorization_codes_user_id_idx').on(table.userId),
  codeHashIdx: index('oauth_authorization_codes_code_hash_idx').on(table.codeHash),
  expiresIdx: index('oauth_authorization_codes_expires_at_idx').on(table.expiresAt),
}));

// Device authorization grant (RFC 8628). userId is nullable until the user
// approves the device on /activate; both the device_code and user_code are
// stored hash-only.
export const oauthDeviceCodes = pgTable('oauth_device_codes', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  deviceCodeHash: text('deviceCodeHash').unique().notNull(),
  deviceCodePrefix: text('deviceCodePrefix').notNull(),
  userCodeHash: text('userCodeHash').unique().notNull(),
  userCodePrefix: text('userCodePrefix').notNull(),
  clientId: text('clientId').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  userId: text('userId').references(() => users.id, { onDelete: 'cascade' }),
  scopes: jsonb('scopes').$type<string[]>().notNull(),
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
  approvedAt: timestamp('approvedAt', { mode: 'date' }),
  deniedAt: timestamp('deniedAt', { mode: 'date' }),
  // RFC 8628 §3.5: the device_code MUST be invalidated once redeemed. Set in
  // the same transaction that issues credentials for it, so a second poll of
  // an approved code sees it already set and is refused (invalid_grant)
  // instead of issuing again. Load-bearing for mint-shaped grants — without
  // it, every extra poll of an approved `keys create --device` code would
  // mint another `mcp_*` key.
  redeemedAt: timestamp('redeemedAt', { mode: 'date' }),
  lastPolledAt: timestamp('lastPolledAt', { mode: 'date' }),
  pollIntervalSeconds: integer('pollIntervalSeconds').default(5).notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  clientIdx: index('oauth_device_codes_client_id_idx').on(table.clientId),
  userIdx: index('oauth_device_codes_user_id_idx').on(table.userId),
  deviceCodeHashIdx: index('oauth_device_codes_device_code_hash_idx').on(table.deviceCodeHash),
  userCodeHashIdx: index('oauth_device_codes_user_code_hash_idx').on(table.userCodeHash),
  expiresIdx: index('oauth_device_codes_expires_at_idx').on(table.expiresAt),
}));

// Refresh-token family (ADR 0003 §3.1-3.4): per-token 30d TTL, 90d absolute
// family cap fixed at first issuance, single-use rotation via
// replacedByTokenId, reuse detection revokes the whole family.
export const oauthRefreshTokens = pgTable('oauth_refresh_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  tokenHash: text('tokenHash').unique().notNull(),
  tokenPrefix: text('tokenPrefix').notNull(),
  familyId: text('familyId').notNull(),
  clientId: text('clientId').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  scopes: jsonb('scopes').$type<string[]>().notNull(),
  tokenVersion: integer('tokenVersion').notNull(),
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
  familyExpiresAt: timestamp('familyExpiresAt', { mode: 'date' }).notNull(),
  replacedByTokenId: text('replacedByTokenId'),
  revokedAt: timestamp('revokedAt', { mode: 'date' }),
  revokedReason: text('revokedReason'),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  familyIdx: index('oauth_refresh_tokens_family_id_idx').on(table.familyId),
  userIdx: index('oauth_refresh_tokens_user_id_idx').on(table.userId),
  clientIdx: index('oauth_refresh_tokens_client_id_idx').on(table.clientId),
  tokenHashIdx: index('oauth_refresh_tokens_token_hash_idx').on(table.tokenHash),
  expiresIdx: index('oauth_refresh_tokens_expires_at_idx').on(table.expiresAt),
}));

// Short-lived (15m) access tokens (ADR 0003 §3.1-3.2). Carries the issuing
// refresh family's familyId so a reuse-detection family revocation reaches
// every access token the family ever issued, not just its refresh tokens.
export const oauthAccessTokens = pgTable('oauth_access_tokens', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  tokenHash: text('tokenHash').unique().notNull(),
  tokenPrefix: text('tokenPrefix').notNull(),
  familyId: text('familyId').notNull(),
  clientId: text('clientId').notNull().references(() => oauthClients.id, { onDelete: 'cascade' }),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  scopes: jsonb('scopes').$type<string[]>().notNull(),
  tokenVersion: integer('tokenVersion').notNull(),
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
  revokedAt: timestamp('revokedAt', { mode: 'date' }),
  revokedReason: text('revokedReason'),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  familyIdx: index('oauth_access_tokens_family_id_idx').on(table.familyId),
  userIdx: index('oauth_access_tokens_user_id_idx').on(table.userId),
  clientIdx: index('oauth_access_tokens_client_id_idx').on(table.clientId),
  tokenHashIdx: index('oauth_access_tokens_token_hash_idx').on(table.tokenHash),
  expiresIdx: index('oauth_access_tokens_expires_at_idx').on(table.expiresAt),
}));

export const oauthClientsRelations = relations(oauthClients, ({ many }) => ({
  authorizationCodes: many(oauthAuthorizationCodes),
  deviceCodes: many(oauthDeviceCodes),
  refreshTokens: many(oauthRefreshTokens),
  accessTokens: many(oauthAccessTokens),
}));

export const oauthAuthorizationCodesRelations = relations(oauthAuthorizationCodes, ({ one }) => ({
  client: one(oauthClients, { fields: [oauthAuthorizationCodes.clientId], references: [oauthClients.id] }),
  user: one(users, { fields: [oauthAuthorizationCodes.userId], references: [users.id] }),
}));

export const oauthDeviceCodesRelations = relations(oauthDeviceCodes, ({ one }) => ({
  client: one(oauthClients, { fields: [oauthDeviceCodes.clientId], references: [oauthClients.id] }),
  user: one(users, { fields: [oauthDeviceCodes.userId], references: [users.id] }),
}));

export const oauthRefreshTokensRelations = relations(oauthRefreshTokens, ({ one }) => ({
  client: one(oauthClients, { fields: [oauthRefreshTokens.clientId], references: [oauthClients.id] }),
  user: one(users, { fields: [oauthRefreshTokens.userId], references: [users.id] }),
}));

export const oauthAccessTokensRelations = relations(oauthAccessTokens, ({ one }) => ({
  client: one(oauthClients, { fields: [oauthAccessTokens.clientId], references: [oauthClients.id] }),
  user: one(users, { fields: [oauthAccessTokens.userId], references: [users.id] }),
}));
