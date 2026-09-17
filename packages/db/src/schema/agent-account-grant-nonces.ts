import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * agent_account_grant_nonces — the replay ledger for agent-account action
 * grants (ADR 0004 §2.4; ADR 0005 §2.5; threat model A5, B-13).
 *
 * A grant is one-use. The env-bridge keeps its nonces in the daemon's memory
 * because the daemon is one process; the account authority is replicated and
 * restarts, so its ledger is THE DATABASE, as `dev_preview_grants` already
 * is: consumption is one `INSERT … ON CONFLICT DO NOTHING RETURNING` that
 * succeeds exactly once across every replica and is not forgotten by a
 * restart. The verifier itself is pure and never touches this table — the
 * repository (`packages/lib/src/agent-accounts/replay-store-repository.ts`)
 * looks the nonce up, the pure `decideReplay` turns the row into a
 * `NonceState`, and the nonce is recorded ONLY after the whole verdict is
 * `ok` (a grant that failed any earlier check must not be able to burn it).
 *
 * The row is the reference type `AgentAccountGrantNonceRow` in
 * `agent-accounts.ts` (frozen at G1a, ms timestamps there); this is the
 * table. Nothing here is secret: the nonce is random, the grant id names a
 * signed grant, and both are already on the wire. Rows are ephemeral (a
 * grant lives at most 15 minutes) and are swept opportunistically once
 * `expiresAt` is more than two clock-skew allowances behind the sweeping
 * replica's clock — a swept nonce cannot be replayed because the grant that
 * carried it has expired first on EVERY replica within that skew
 * (verifier deny order F10 before F12).
 *
 * `timestamptz` on purpose: the ledger is compared against an injected UTC
 * clock and must not depend on the session time zone.
 */
export const agentAccountGrantNonces = pgTable(
  'agent_account_grant_nonces',
  {
    /** The grant's one-use nonce; the primary key IS the atomicity. */
    nonce: text('nonce').primaryKey(),
    grantId: text('grantId').notNull(),
    /** The grant's `exp`; rows past it are swept. */
    expiresAt: timestamp('expiresAt', { mode: 'date', withTimezone: true }).notNull(),
    /** Stamped by the ONE consumption. Never updated. */
    consumedAt: timestamp('consumedAt', { mode: 'date', withTimezone: true }).notNull(),
  },
  (table) => ({
    expiresAtIdx: index('agent_account_grant_nonces_expires_at_idx').on(table.expiresAt),
  }),
);

export type AgentAccountGrantNonce = typeof agentAccountGrantNonces.$inferSelect;
