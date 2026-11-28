/**
 * The refresh worker's attempt ledger (L3·G3) — I/O only, in the plane's own
 * metadata store (`agent_account_refresh_attempts`, one row per account). It
 * stores the `RefreshAttemptFact` that `nextRefreshAttempt` produced and hands
 * it back to `decideRefresh`; what a fact MEANS is decided there. `null`
 * deletes the row (a successful refresh). No material ever reaches it.
 */
import type { Pool } from 'pg';
import type { SecretRef } from '../store/store-adapter';
import type { RefreshAttemptFact } from './decide-refresh';

export type RefreshAttemptLedger = {
  readonly read: (ref: SecretRef) => Promise<RefreshAttemptFact | null>;
  readonly write: (input: { readonly ref: SecretRef; readonly fact: RefreshAttemptFact | null }) => Promise<void>;
};

type AttemptRow = {
  readonly attempt_at: string | number;
  readonly consecutive_failures: number;
  readonly retry_at: string | number | null;
  readonly rotation_replayed: boolean;
};

export function createRefreshAttemptRepository({ pool }: { readonly pool: Pick<Pool, 'query'> }): RefreshAttemptLedger {
  return {
    async read(ref) {
      const result = await pool.query(
        'SELECT attempt_at, consecutive_failures, retry_at, rotation_replayed FROM agent_account_refresh_attempts WHERE tenant_id = $1 AND account_id = $2',
        [ref.tenantId, ref.accountId],
      );
      const row = result.rows[0] as AttemptRow | undefined;
      if (row === undefined) return null;
      return {
        at: Number(row.attempt_at),
        consecutiveFailures: row.consecutive_failures,
        retryAt: row.retry_at === null ? null : Number(row.retry_at),
        rotationReplayed: row.rotation_replayed,
      };
    },

    async write({ ref, fact }) {
      if (fact === null) {
        await pool.query('DELETE FROM agent_account_refresh_attempts WHERE tenant_id = $1 AND account_id = $2', [ref.tenantId, ref.accountId]);
        return;
      }
      await pool.query(
        `INSERT INTO agent_account_refresh_attempts (tenant_id, account_id, attempt_at, consecutive_failures, retry_at, rotation_replayed)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, account_id) DO UPDATE
           SET attempt_at = EXCLUDED.attempt_at, consecutive_failures = EXCLUDED.consecutive_failures,
               retry_at = EXCLUDED.retry_at, rotation_replayed = EXCLUDED.rotation_replayed`,
        [ref.tenantId, ref.accountId, fact.at, fact.consecutiveFailures, fact.retryAt, fact.rotationReplayed],
      );
    },
  };
}
