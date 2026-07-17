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

export type WithAdvisoryLockResult<T> =
  | { outcome: 'lock_busy' }
  | { outcome: 'acquired'; result: T }
  | {
      /**
       * The lock connection itself failed — `pool.connect()` or the try-lock query threw
       * (pool exhaustion, connection reset) — structurally distinct from `fn` throwing.
       * RESOLVED, never rejected, so a caller can branch on `.outcome` instead of relying on
       * "anything I catch here must be lock machinery" (an unenforced, comment-level
       * assumption that broke down the instant a caller's `fn` stopped being throw-free).
       * `fn` never ran on this path. See the D-task evidence (fmfmzw4g4gh6u6q9cjt7ylne) this
       * closes.
       */
      outcome: 'connection_error';
      error: unknown;
    };

/**
 * Release the connection — destroying it when handed an error — swallowing any synchronous
 * release failure (a double-release from a hook, a pool already shut down). Every exit of
 * withAdvisoryLock funnels through this: a throwing release() must never replace the promised
 * resolved outcome (acquired/lock_busy/connection_error) with a rejection. Logged plainly (not
 * via @pagespace/lib's logger — packages/db must not depend on packages/lib). Never throws.
 *
 * The key is logged via JSON.stringify as a %s argument to a CONSTANT format string: lock keys
 * can be derived from request-supplied ids (e.g. a per-conversation lock), so a raw key in the
 * format position could smuggle %-directives, and unescaped newlines could forge log lines
 * (CodeQL js/tainted-format-string, js/log-injection — PR #2097).
 */
function releaseQuietly(client: AdvisoryLockClient, lockKey: string, destroyWithError?: Error): void {
  try {
    client.release(destroyWithError);
  } catch (releaseError) {
    console.error(
      '[withAdvisoryLock:%s] release() itself failed — connection already released or pool gone: %s',
      JSON.stringify(lockKey),
      releaseError instanceof Error ? releaseError.message : String(releaseError),
    );
  }
}

/**
 * Unlock and return the connection to the pool — or, when the unlock query itself fails,
 * destroy the connection instead. A session that failed to unlock may still hold the
 * session-level advisory lock; returned to the pool alive it would leak the lock permanently
 * (every future try-lock sees lock_busy forever). Postgres releases session advisory locks
 * when the backend dies, so destroying is the safe exit. Never throws.
 */
async function unlockAndRelease(client: AdvisoryLockClient, lockKey: string): Promise<void> {
  try {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
    client.release();
  } catch (unlockError) {
    const err = unlockError instanceof Error ? unlockError : new Error(String(unlockError));
    console.error(
      '[withAdvisoryLock:%s] Advisory unlock failed — destroying the connection so the session lock cannot leak into the pool: %s',
      JSON.stringify(lockKey),
      err.message,
    );
    // Also reached when the SUCCESS-path release() above threw — releaseQuietly keeps the
    // second (destroy) release from escaping and breaking the never-throws contract the
    // caller's finally relies on.
    releaseQuietly(client, lockKey, err);
  }
}

export async function withAdvisoryLock<T>(
  pool: AdvisoryLockPool,
  lockKey: string,
  fn: () => Promise<T>,
): Promise<WithAdvisoryLockResult<T>> {
  let client: AdvisoryLockClient;
  try {
    client = await pool.connect();
  } catch (error) {
    return { outcome: 'connection_error', error };
  }

  // The try-lock query gets its own catch, separate from `fn`'s errors below: a query that
  // threw ON THIS CLIENT leaves the connection's protocol state indeterminate, so it is
  // destroyed on release rather than pooled as if healthy — and the failure is lock machinery,
  // reported as a resolved `connection_error` outcome, never a rejection.
  let lockResult: { rows: Record<string, unknown>[] };
  try {
    lockResult = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [lockKey]);
  } catch (error) {
    releaseQuietly(
      client,
      lockKey,
      new Error(`withAdvisoryLock(${JSON.stringify(lockKey)}): try-lock query failed, connection left in an indeterminate state`),
    );
    return { outcome: 'connection_error', error };
  }

  if (!lockResult.rows[0]?.acquired) {
    releaseQuietly(client, lockKey);
    return { outcome: 'lock_busy' };
  }

  // `fn`'s own errors run against its own I/O and leave this lock connection's protocol state
  // untouched — they are NOT lock machinery and keep propagating as a rejection (the caller's
  // own error, unwrapped), after the lock is released either way. unlockAndRelease never
  // throws, so the finally cannot mask fn's rejection.
  try {
    const result = await fn();
    return { outcome: 'acquired', result };
  } finally {
    await unlockAndRelease(client, lockKey);
  }
}
