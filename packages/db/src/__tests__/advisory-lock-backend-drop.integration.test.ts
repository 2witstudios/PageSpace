/**
 * `withAdvisoryLock` when the lock connection's backend dies mid-lock — against a REAL Postgres.
 *
 * pg-pool removes its idle 'error' listener when a client is checked out, so for as long as
 * `withAdvisoryLock` holds the lock connection, nothing listens for that client's 'error'. A
 * Postgres restart/failover, a `pg_terminate_backend`, or a proxy dropping an idle connection
 * while `fn` runs makes pg.Client emit 'error' (the backend's FATAL 57P01 arrives with no query in
 * flight), and an unhandled 'error' on an EventEmitter is an uncaught exception: the whole Node
 * process dies. A mock client cannot show this — the crash lives in pg's socket handling — so
 * this suite kills a real backend while the lock is held.
 *
 * Excluded from the default `vitest run` (no database there) — see `vitest.config.ts`. Run with:
 *     bun run --filter '@pagespace/db' test:integration -- src/__tests__/advisory-lock-backend-drop.integration.test.ts
 * Needs a role allowed to `pg_terminate_backend` the pool's own connections (the same role is
 * enough; CI's postgres superuser is). Fails loudly when DATABASE_URL is absent.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Client, Pool, type PoolClient } from 'pg';
import { withAdvisoryLock, type AdvisoryLockPool } from '../advisory-lock';
import { requireDbUrl } from '../test/require-db';

const url = process.env.DATABASE_URL;
requireDbUrl(url, 'DATABASE_URL', 'advisory-lock-backend-drop.integration.test.ts');

/** A unique key per test, so a run against a shared database cannot contend with anything else. */
function uniqueLockKey(label: string): string {
  return `advisory-lock-backend-drop:${label}:${process.pid}:${process.hrtime.bigint()}`;
}

describe.skipIf(!url)('withAdvisoryLock when the lock backend is terminated mid-lock', () => {
  let pool: Pool;
  let admin: Client;
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => {
    uncaught.push(error);
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 });
    admin = new Client({ connectionString: url });
    await admin.connect();
    // Recorded so the assertion below names the crash, rather than leaving it to vitest's own
    // "unhandled error" report (which also fails the run, but after the test has passed).
    process.on('uncaughtException', onUncaught);
  });

  afterEach(() => {
    uncaught.length = 0;
  });

  afterAll(async () => {
    process.off('uncaughtException', onUncaught);
    await admin?.end();
    await pool?.end();
  });

  /** The real pool, recording the backend pid of every connection it hands to `withAdvisoryLock`. */
  function trackingPool(pids: number[]): AdvisoryLockPool {
    return {
      connect: async () => {
        const client: PoolClient = await pool.connect();
        pids.push((client as PoolClient & { processID: number }).processID);
        return client;
      },
    };
  }

  /** Kill `pid` from another connection and wait until the server no longer lists it. */
  async function terminateBackend(pid: number): Promise<void> {
    const killed = await admin.query<{ killed: boolean }>('SELECT pg_terminate_backend($1) AS killed', [pid]);
    expect(killed.rows[0]?.killed).toBe(true);
    for (let i = 0; i < 100; i += 1) {
      const alive = await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid]);
      if (alive.rowCount === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // The server-side backend is gone; give the client socket a few event-loop turns to read the
    // FATAL and the close — this is where pg.Client emits 'error' on the checked-out client.
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  it('given the backend is terminated while fn runs, should not crash the process, should settle, and should leave the pool usable', async () => {
    const lockKey = uniqueLockKey('mid-fn');
    const pids: number[] = [];
    const lockPool = trackingPool(pids);

    const result = await withAdvisoryLock(lockPool, lockKey, async () => {
      const [lockPid] = pids;
      if (lockPid === undefined) throw new Error('lock connection pid was not recorded');
      await terminateBackend(lockPid);
      return 'fn-finished';
    });

    // No unhandled 'error' from the dead lock connection reached the process.
    expect(uncaught).toEqual([]);
    // fn ran to completion before the drop was noticed, so its result is still reported; the lost
    // lock is logged (see advisory-lock.ts) rather than turned into a rejection of finished work.
    expect(result).toEqual({ outcome: 'acquired', result: 'fn-finished' });

    // The pool destroyed the dead connection rather than pooling it: plain queries still work…
    const ping = await pool.query<{ one: number }>('SELECT 1 AS one');
    expect(ping.rows[0]?.one).toBe(1);
    // …and the same key is free again (Postgres dropped the session lock with the backend), taken
    // on a DIFFERENT, live backend.
    const again = await withAdvisoryLock(lockPool, lockKey, async () => 'second-run');
    expect(again).toEqual({ outcome: 'acquired', result: 'second-run' });
    expect(pids).toHaveLength(2);
    expect(pids[1]).not.toBe(pids[0]);
    expect(uncaught).toEqual([]);
  });

  it('given the backend is terminated while fn runs and fn then rejects, should reject with fn’s own error and not crash', async () => {
    const lockKey = uniqueLockKey('mid-fn-reject');
    const pids: number[] = [];
    const lockPool = trackingPool(pids);

    await expect(
      withAdvisoryLock(lockPool, lockKey, async () => {
        const [lockPid] = pids;
        if (lockPid === undefined) throw new Error('lock connection pid was not recorded');
        await terminateBackend(lockPid);
        throw new Error('fn failed after the drop');
      }),
    ).rejects.toThrow('fn failed after the drop');

    expect(uncaught).toEqual([]);
    const again = await withAdvisoryLock(lockPool, lockKey, async () => 'recovered');
    expect(again).toEqual({ outcome: 'acquired', result: 'recovered' });
    expect(uncaught).toEqual([]);
  });
});
