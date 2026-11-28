/**
 * `UsageLedger.reserve` when its transaction's backend dies — against a REAL Postgres.
 *
 * `reserve` holds one pooled client across BEGIN … COMMIT. pg-pool removes its idle 'error'
 * listener on checkout, and pg.Client emits 'error' on an unexpected socket close even while a
 * query is in flight — so without a listener of its own, a Postgres restart, a failover or a
 * `pg_terminate_backend` mid-transaction is an uncaught exception that kills the process.
 *
 * The backend is killed while `reserve` waits on its per-account `pg_advisory_xact_lock` (held
 * here from another connection), which is before the ledger table is touched — so this suite needs
 * no plane-metadata schema, only a role allowed to terminate its own pool's connections.
 *
 * Run with:
 *     bun run --filter '@pagespace/lib' test:integration -- src/agent-accounts/store/__tests__/usage-ledger-backend-drop.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { requireDb } from '@pagespace/db/test/require-db';
import type { AccountId, TenantId } from '@pagespace/db/schema/agent-accounts';
import { createUsageLedgerRepository } from '../usage-ledger-repository';
import type { SecretRef } from '../store-adapter';

let pool: Pool;
let holder: Client;
/** Probes and kills from outside the holder's transaction: pg_stat_activity is snapshotted once per transaction. */
let admin: Client;
let dbAvailable = false;
/** Tags this file's pool connections, so the probe below can only ever pick (and kill) our own backend. */
const APPLICATION_NAME = `usage-ledger-backend-drop-${process.pid}`;
const uncaught: unknown[] = [];
const onUncaught = (error: unknown) => {
  uncaught.push(error);
};

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, application_name: APPLICATION_NAME });
  holder = new Client({ connectionString: process.env.DATABASE_URL });
  admin = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await holder.connect();
    await admin.connect();
    dbAvailable = true;
  } catch (error) {
    requireDb('usage-ledger-backend-drop.integration.test.ts', error);
  }
  process.on('uncaughtException', onUncaught);
});

afterEach(() => {
  uncaught.length = 0;
});

afterAll(async () => {
  process.off('uncaughtException', onUncaught);
  if (dbAvailable) await Promise.all([holder.end(), admin.end()]);
  await pool.end();
});

async function waitFor<T>(probe: () => Promise<T | null>): Promise<T> {
  for (let i = 0; i < 250; i += 1) {
    const found = await probe();
    if (found !== null) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition not reached within 5s');
}

describe('UsageLedger.reserve when its backend is terminated mid-transaction', () => {
  it('given the backend dies while reserve waits on its advisory lock, should resolve false, not crash, and leave the pool usable', async () => {
    if (!dbAvailable) return;
    const suffix = `${process.pid}-${process.hrtime.bigint()}`;
    const ref: SecretRef = { tenantId: `t-${suffix}` as TenantId, accountId: `a-${suffix}` as AccountId, kind: 'api_key' };
    const lockKey = `agent-accounts:usage:${ref.tenantId}:${ref.accountId}`;
    const ledger = createUsageLedgerRepository({ pool });

    // Hold the per-account lock so reserve blocks inside its transaction.
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey]);

    try {
      const reserving = ledger.reserve({ ref, grantId: `g-${suffix}`, bytes: 0, now: Date.now(), admits: () => true });

      const blockedPid = await waitFor(async () => {
        const rows = await admin.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
            WHERE application_name = $1 AND wait_event_type = 'Lock' AND wait_event = 'advisory' AND query LIKE '%pg_advisory_xact_lock%'`,
          [APPLICATION_NAME],
        );
        return rows.rows[0]?.pid ?? null;
      });
      const killed = await admin.query<{ killed: boolean }>('SELECT pg_terminate_backend($1) AS killed', [blockedPid]);
      expect(killed.rows[0]?.killed).toBe(true);

      await expect(reserving).resolves.toBe(false);
      // Let the dead socket's close reach the client — pg emits 'error' here.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(uncaught).toEqual([]);
    } finally {
      await holder.query('ROLLBACK');
    }

    // The dead connection was destroyed, not pooled: the pool still serves queries.
    const ping = await pool.query<{ one: number }>('SELECT 1 AS one');
    expect(ping.rows[0]?.one).toBe(1);
    expect(uncaught).toEqual([]);
  });
});
