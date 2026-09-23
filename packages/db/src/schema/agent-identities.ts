import { pgTable, text, timestamp, integer, index, varchar } from 'drizzle-orm/pg-core';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';

/**
 * AGENT IDENTITIES — an AI agent's own PageSpace login (ADR 0007).
 *
 * Not to be confused with `agent_accounts` (ADR 0004/0005, the credential
 * broker): those are credentials a PageSpace agent holds for OTHER sites.
 * An agent identity IS a `users` row (`accountType = 'agent'`); this table
 * holds what only an agent has — its opaque `ps_agent_*` secret (hash only),
 * its claim token (hash only) and its human owner once claimed.
 *
 * Every secret-shaped value is SHA3-256 at rest (`hashToken`) with a short
 * prefix for support identification; the plaintext exists only in the
 * signup/rotate response (threat model §3).
 */
export const agentIdentities = pgTable('agent_identities', {
  userId: text('userId').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  secretHash: text('secretHash').unique().notNull(),
  secretPrefix: text('secretPrefix').notNull(),
  // Bumped by every rotation; the jwt-bearer exchange and sign-in look up by
  // hash, so the version is audit/support metadata, not a lookup key.
  secretVersion: integer('secretVersion').default(1).notNull(),
  // Nulled when a claim settles (ADR 0007 §5 assertion 22), so a claim token
  // can start at most one successful claim.
  claimTokenHash: text('claimTokenHash').unique(),
  claimTokenPrefix: text('claimTokenPrefix'),
  // Self-reported client label ("claude-code", "codex", …). Display only —
  // no vendor-verifiable agent identity exists (ADR 0007 §1).
  source: varchar('source', { length: 120 }),
  ownerUserId: text('ownerUserId').references(() => users.id, { onDelete: 'set null' }),
  claimedAt: timestamp('claimedAt', { mode: 'date' }),
  createdByIp: text('createdByIp'),
  lastAuthAt: timestamp('lastAuthAt', { mode: 'date' }),
  revokedAt: timestamp('revokedAt', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  ownerUserIdx: index('agent_identities_owner_user_id_idx').on(table.ownerUserId),
  // The deployment-wide signup budget counts identities created in a rolling window.
  createdAtIdx: index('agent_identities_created_at_idx').on(table.createdAt),
}));

/**
 * A human claiming an agent (ADR 0007 Decision 3). Mirrors the
 * `oauth_device_codes` lifecycle columns but is deliberately a separate table:
 * a device row mints for the APPROVING human, a claim mints for the AGENT.
 * `ownerUserId` is null until a human approves.
 */
export const agentClaims = pgTable('agent_claims', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  agentUserId: text('agentUserId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  ownerUserId: text('ownerUserId').references(() => users.id, { onDelete: 'cascade' }),
  userCodeHash: text('userCodeHash').unique().notNull(),
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
  approvedAt: timestamp('approvedAt', { mode: 'date' }),
  deniedAt: timestamp('deniedAt', { mode: 'date' }),
  redeemedAt: timestamp('redeemedAt', { mode: 'date' }),
  lastPolledAt: timestamp('lastPolledAt', { mode: 'date' }),
  pollIntervalSeconds: integer('pollIntervalSeconds').default(5).notNull(),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  agentUserIdx: index('agent_claims_agent_user_id_idx').on(table.agentUserId),
  ownerUserIdx: index('agent_claims_owner_user_id_idx').on(table.ownerUserId),
  expiresIdx: index('agent_claims_expires_at_idx').on(table.expiresAt),
}));

/**
 * Server-issued proof-of-work challenges for the agent signup doors (ADR 0007
 * Decision 10, threat model T2). Single use: consumed by
 * `UPDATE … SET consumedAt WHERE consumedAt IS NULL RETURNING` in the same
 * transaction that creates the agent, so a replayed challenge creates nothing.
 */
export const agentSignupChallenges = pgTable('agent_signup_challenges', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  challengeHash: text('challengeHash').unique().notNull(),
  difficultyBits: integer('difficultyBits').notNull(),
  // No caller IP (Phase 2b): redemption is not bound to the issuing address,
  // so storing it served no purpose. The per-IP limits act on the request.
  expiresAt: timestamp('expiresAt', { mode: 'date' }).notNull(),
  consumedAt: timestamp('consumedAt', { mode: 'date' }),
  createdAt: timestamp('createdAt', { mode: 'date' }).defaultNow().notNull(),
}, (table) => ({
  expiresIdx: index('agent_signup_challenges_expires_at_idx').on(table.expiresAt),
}));

export type AgentIdentity = typeof agentIdentities.$inferSelect;
export type AgentClaim = typeof agentClaims.$inferSelect;
export type AgentSignupChallenge = typeof agentSignupChallenges.$inferSelect;
