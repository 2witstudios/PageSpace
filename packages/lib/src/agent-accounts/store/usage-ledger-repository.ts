/**
 * The plane's usage ledger for standing policies (Codex review P1 on #2705) —
 * I/O only, in the plane's own metadata store (`agent_account_usage`). What a
 * count MEANS is `decidePolicyUsage`'s; this file counts, and reserves a use
 * only when the caller's `admits` says the counts still allow it — under a
 * per-account advisory lock inside one transaction, so two concurrent requests
 * at the cap cannot both be admitted.
 */
import type { Pool, PoolClient } from 'pg';
import type { UsageCounters } from '../approval';
import type { SecretRef } from './store-adapter';

const HOUR_MS = 3_600_000;
/** A request not finished within this window no longer counts as in flight (the executor's own caps are far shorter). */
const IN_FLIGHT_WINDOW_MS = 5 * 60_000;
const RETENTION_MS = 2 * HOUR_MS;

export type UsageLedger = {
  readonly window: (input: { readonly ref: SecretRef; readonly now: number }) => Promise<UsageCounters>;
  /** Record one use iff `admits(current counts)`; `false` when it does not (or the ledger cannot answer). */
  readonly reserve: (input: { readonly ref: SecretRef; readonly grantId: string; readonly bytes: number; readonly now: number; readonly admits: (usage: UsageCounters) => boolean }) => Promise<boolean>;
  readonly finish: (input: { readonly grantId: string; readonly now: number }) => Promise<void>;
};

async function countWindow(query: Pick<PoolClient, 'query'>, ref: SecretRef, now: number): Promise<UsageCounters> {
  const result = await query.query(
    `SELECT count(*)::int AS uses,
            coalesce(sum(bytes_out), 0)::bigint AS bytes,
            count(*) FILTER (WHERE finished_at IS NULL AND started_at > $4)::int AS concurrent
       FROM agent_account_usage WHERE tenant_id = $1 AND account_id = $2 AND started_at > $3`,
    [ref.tenantId, ref.accountId, new Date(now - HOUR_MS), new Date(now - IN_FLIGHT_WINDOW_MS)],
  );
  const row = result.rows[0] as { uses: number; bytes: string | number; concurrent: number };
  return { usesThisHour: row.uses, bytesOutThisHour: Number(row.bytes), concurrent: row.concurrent };
}

export function createUsageLedgerRepository({ pool }: { readonly pool: Pick<Pool, 'query' | 'connect'> }): UsageLedger {
  return {
    window: ({ ref, now }) => countWindow(pool, ref, now),

    async reserve({ ref, grantId, bytes, now, admits }) {
      let client: PoolClient | null = null;
      try {
        client = await pool.connect();
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`agent-accounts:usage:${ref.tenantId}:${ref.accountId}`]);
        await client.query('DELETE FROM agent_account_usage WHERE tenant_id = $1 AND account_id = $2 AND started_at < $3', [ref.tenantId, ref.accountId, new Date(now - RETENTION_MS)]);
        if (!admits(await countWindow(client, ref, now))) {
          await client.query('ROLLBACK');
          return false;
        }
        await client.query('INSERT INTO agent_account_usage (grant_id, tenant_id, account_id, started_at, bytes_out) VALUES ($1, $2, $3, $4, $5)', [grantId, ref.tenantId, ref.accountId, new Date(now), bytes]);
        await client.query('COMMIT');
        return true;
      } catch {
        await client?.query('ROLLBACK').catch(() => undefined);
        return false;
      } finally {
        client?.release();
      }
    },

    async finish({ grantId, now }) {
      await pool.query('UPDATE agent_account_usage SET finished_at = $2 WHERE grant_id = $1 AND finished_at IS NULL', [grantId, new Date(now)]).catch(() => undefined);
    },
  };
}
