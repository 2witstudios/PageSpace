/**
 * The replay ledger adapter (ADR 0004 §2.4) — I/O only, no decision logic.
 *
 * `agent_account_grant_nonces` is the single-use ledger across every broker
 * replica and every restart. `consume` is ONE conditional insert
 * (`ON CONFLICT DO NOTHING RETURNING`): the row comes back exactly once, to
 * exactly one caller, and a later presentation finds the primary key taken.
 * Nothing here interprets a row — `decideReplay` does — and nothing here
 * decides WHEN to consume: the grant gate calls `consume` only after the
 * pure verifier said `ok`, so a grant that failed any earlier check leaves
 * the ledger untouched (§8.11).
 *
 * Failures are reported, never thrown: an unreachable store is
 * `{ ok: false }` / `'unavailable'`, which the verifier maps to
 * `replay_store_unavailable` — the executor does not act (F12).
 *
 * Integration-tested against the real `:5433` Postgres
 * (`__tests__/replay-store-repository.integration.test.ts`).
 */
import type { db as defaultDb } from '@pagespace/db/db';
import { eq, lt } from '@pagespace/db/operators';
import { agentAccountGrantNonces } from '@pagespace/db/schema/agent-account-grant-nonces';
import { GRANT_LIMITS } from './grant-constants';
import type { GrantId, Nonce } from './grant';
import type { NonceLookup } from './decide-replay';

/** The subset of the Drizzle client the ledger needs; a test can hand it a client over a dead pool. */
export type ReplayStoreDatabase = Pick<typeof defaultDb, 'insert' | 'select' | 'delete'>;

export type ConsumeOutcome = 'consumed' | 'replayed' | 'unavailable';

export type ReplayStoreRepository = {
  /** What the ledger holds for this nonce, or that the lookup did not complete. */
  readonly lookup: (input: { readonly nonce: Nonce }) => Promise<NonceLookup>;
  /** Record the nonce as spent. Exactly one caller across all replicas ever gets `consumed`. */
  readonly consume: (input: { readonly nonce: Nonce; readonly grantId: GrantId; readonly expiresAt: number; readonly now: number }) => Promise<ConsumeOutcome>;
  /** Housekeeping: drop rows past `expiresAt` by more than two clock-skew allowances. Returns the number removed; 0 on failure. */
  readonly sweepExpired: (input: { readonly now: number }) => Promise<number>;
};

export function createReplayStoreRepository({ db }: { readonly db: ReplayStoreDatabase }): ReplayStoreRepository {
  return {
    async lookup({ nonce }) {
      try {
        const rows = await db
          .select({ grantId: agentAccountGrantNonces.grantId, expiresAt: agentAccountGrantNonces.expiresAt, consumedAt: agentAccountGrantNonces.consumedAt })
          .from(agentAccountGrantNonces)
          .where(eq(agentAccountGrantNonces.nonce, nonce))
          .limit(1);
        const row = rows[0];
        if (row === undefined) return { ok: true, recorded: null };
        return { ok: true, recorded: { grantId: row.grantId, expiresAt: row.expiresAt.getTime(), consumedAt: row.consumedAt.getTime() } };
      } catch {
        return { ok: false };
      }
    },

    async consume({ nonce, grantId, expiresAt, now }) {
      try {
        const inserted = await db
          .insert(agentAccountGrantNonces)
          .values({ nonce, grantId, expiresAt: new Date(expiresAt), consumedAt: new Date(now) })
          .onConflictDoNothing({ target: agentAccountGrantNonces.nonce })
          .returning({ nonce: agentAccountGrantNonces.nonce });
        return inserted.length === 1 ? 'consumed' : 'replayed';
      } catch {
        return 'unavailable';
      }
    },

    async sweepExpired({ now }) {
      try {
        // Keep a row for TWO clock-skew allowances past `exp`: a sweeper whose
        // clock runs ahead and a verifier whose clock runs behind are up to 2S
        // apart, and a swept nonce would read as fresh to the verifier.
        const result = await db
          .delete(agentAccountGrantNonces)
          .where(lt(agentAccountGrantNonces.expiresAt, new Date(now - 2 * GRANT_LIMITS.maxClockSkewMs)));
        return result.rowCount ?? 0;
      } catch {
        return 0;
      }
    },
  };
}
