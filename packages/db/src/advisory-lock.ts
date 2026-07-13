/**
 * Generic Postgres session-level advisory try-lock: acquire on a dedicated
 * connection, run `fn`, always release. A caller that cannot acquire the lock
 * (another process/container already holds it) gets a clean `'lock_busy'`
 * result and `fn` never runs — the standard shape for serializing a
 * background job across every caller (multiple containers, manual/API
 * triggers), not just one process's own scheduled ticks.
 *
 * Extracted from the pattern independently duplicated in
 * apps/processor/src/workers/audit-chainer-worker.ts and
 * apps/processor/src/workers/siem-delivery-worker.ts (both raw-pg, both
 * session-level try-lock/finally-unlock) — those two are left as-is (they
 * predate this helper and run in the processor's separate trust-plane pool;
 * changing them is out of scope here), but any NEW lib/web-level consumer
 * should reach for this instead of re-deriving the pattern a fourth time.
 *
 * Hardened beyond the two existing copies: if the try-lock QUERY ITSELF
 * throws (not just resolves with `acquired: false` — e.g. a connection reset
 * mid-query), the connection is DESTROYED on release instead of returned to
 * the pool as if healthy, since its protocol state is indeterminate. The
 * existing copies only destroy-on-failure for the unlock query, not the
 * try-lock query; this closes that gap without touching them.
 *
 * Advisory lock keys share ONE global 64-bit keyspace per Postgres instance
 * (via `hashtext`, a 32-bit hash) — there is no central registry of lock
 * keys in this codebase, so a colliding key chosen elsewhere would cause
 * spurious cross-feature contention. Not solved here (would mean auditing
 * every existing lock key across the codebase); pick a distinctive,
 * descriptive `lockKey` string to keep collisions unlikely in practice.
 */

/**
 * Minimal subset of pg's Pool/PoolClient API this needs — kept local (not
 * `import type { Pool, PoolClient } from 'pg'`) so a plain mock object
 * satisfies it in tests without a real Postgres connection.
 */
export interface AdvisoryLockClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  /** pg semantics: release(err) DESTROYS the connection instead of pooling it. */
  release(destroyWithError?: Error): void;
}

export interface AdvisoryLockPool {
  connect(): Promise<AdvisoryLockClient>;
}

export type WithAdvisoryLockResult<T> = { outcome: 'lock_busy' } | { outcome: 'acquired'; result: T };

export async function withAdvisoryLock<T>(
  pool: AdvisoryLockPool,
  lockKey: string,
  fn: () => Promise<T>,
): Promise<WithAdvisoryLockResult<T>> {
  const client = await pool.connect();
  let lockAcquired = false;
  // Set only when a query ON THIS CLIENT (try-lock or unlock) itself threw —
  // NOT when `fn()` throws, since `fn` runs against its own I/O and leaves
  // this lock connection's protocol state untouched.
  let clientPoisoned = false;

  try {
    let lockResult: { rows: Record<string, unknown>[] };
    try {
      lockResult = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [lockKey]);
    } catch (tryLockError) {
      clientPoisoned = true;
      throw tryLockError;
    }
    lockAcquired = Boolean(lockResult.rows[0]?.acquired);
    if (!lockAcquired) {
      return { outcome: 'lock_busy' };
    }

    const result = await fn();
    return { outcome: 'acquired', result };
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
        client.release();
      } catch (unlockError) {
        const err = unlockError instanceof Error ? unlockError : new Error(String(unlockError));
        // A session that failed to unlock may still hold the session-level
        // advisory lock; returned to the pool alive it would leak the lock
        // permanently (every future try-lock sees lock_busy forever). Destroy
        // it instead — Postgres releases session advisory locks when the
        // backend dies. Logged plainly (not via @pagespace/lib's logger —
        // packages/db must not depend on packages/lib) so a recurring failure
        // is operator-visible before the dedicated pool is starved.
        console.error(
          `[withAdvisoryLock:${lockKey}] Advisory unlock failed — destroying the connection so the session lock cannot leak into the pool:`,
          err.message,
        );
        client.release(err);
      }
    } else {
      client.release(
        clientPoisoned
          ? new Error(`withAdvisoryLock(${lockKey}): try-lock query failed, connection left in an indeterminate state`)
          : undefined,
      );
    }
  }
}
