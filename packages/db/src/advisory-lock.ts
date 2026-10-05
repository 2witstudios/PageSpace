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
  /**
   * pg.Client is an EventEmitter that emits 'error' when its backend dies (a restart/failover,
   * `pg_terminate_backend`, a proxy dropping the socket). Optional only so a plain mock satisfies
   * the type; a real pg PoolClient always has both.
   */
  on?(event: 'error', listener: (error: Error) => void): unknown;
  removeListener?(event: 'error', listener: (error: Error) => void): unknown;
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
 * A checked-out lock connection plus the 'error' listener guarding it while it is held.
 *
 * pg-pool removes its own idle 'error' listener on checkout, so while withAdvisoryLock holds the
 * connection nothing else listens: a backend that dies (restart/failover, `pg_terminate_backend`,
 * a proxy dropping the socket) makes pg.Client emit 'error' — with no query in flight, and again on
 * the unexpected socket close even when one is — and an unhandled 'error' crashes the whole
 * process. `hold` attaches a listener that records the error instead; `release` detaches it
 * immediately before handing the client back (pg-pool re-attaches its idle listener synchronously
 * inside release()), destroying the connection when it has errored so a dead client is never pooled.
 */
type HeldConnection = {
  readonly client: AdvisoryLockClient;
  readonly lockKey: string;
  /** The first 'error' the connection emitted while held, or null while it is healthy. */
  error(): Error | null;
  /** Remove the listener; call immediately before handing the client to release(). */
  detach(): void;
  /** Detach the listener and release — destroying when handed an error or when the connection errored. Never throws. */
  release(destroyWithError?: Error): void;
};

function hold(client: AdvisoryLockClient, lockKey: string): HeldConnection {
  let connectionError: Error | null = null;
  const onError = (error: Error) => {
    connectionError ??= error;
    console.error(
      '[withAdvisoryLock:%s] Lock connection errored while held — the session lock is gone with its backend; destroying the connection on release: %s',
      JSON.stringify(lockKey),
      error.message,
    );
  };
  client.on?.('error', onError);
  const detach = () => {
    client.removeListener?.('error', onError);
  };
  return {
    client,
    lockKey,
    error: () => connectionError,
    detach,
    release: (destroyWithError) => {
      detach();
      releaseQuietly(client, lockKey, destroyWithError ?? connectionError ?? undefined);
    },
  };
}

/**
 * Unlock and return the connection to the pool — or, when the unlock query itself fails,
 * destroy the connection instead. A session that failed to unlock may still hold the
 * session-level advisory lock; returned to the pool alive it would leak the lock permanently
 * (every future try-lock sees lock_busy forever). Postgres releases session advisory locks
 * when the backend dies, so destroying is the safe exit. Never throws.
 */
async function unlockAndRelease(held: HeldConnection): Promise<void> {
  const { client, lockKey } = held;
  const lost = held.error();
  if (lost) {
    // The backend died while fn ran, taking the session lock with it — an unlock query could only
    // fail. Destroy the dead connection so the pool never hands it out again.
    held.release(lost);
    return;
  }
  try {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
    // The unlock can succeed and the socket still drop before this line runs; the recorded
    // error then destroys rather than pools the connection.
    held.detach();
    client.release(held.error() ?? undefined);
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
    held.release(err);
  }
}

export async function withAdvisoryLock<T>(
  pool: AdvisoryLockPool,
  lockKey: string,
  fn: () => Promise<T>,
): Promise<WithAdvisoryLockResult<T>> {
  let held: HeldConnection;
  try {
    held = hold(await pool.connect(), lockKey);
  } catch (error) {
    return { outcome: 'connection_error', error };
  }

  // The try-lock query gets its own catch, separate from `fn`'s errors below: a query that
  // threw ON THIS CLIENT leaves the connection's protocol state indeterminate, so it is
  // destroyed on release rather than pooled as if healthy — and the failure is lock machinery,
  // reported as a resolved `connection_error` outcome, never a rejection.
  let lockResult: { rows: Record<string, unknown>[] };
  try {
    lockResult = await held.client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS acquired', [lockKey]);
  } catch (error) {
    held.release(
      new Error(`withAdvisoryLock(${JSON.stringify(lockKey)}): try-lock query failed, connection left in an indeterminate state`),
    );
    return { outcome: 'connection_error', error };
  }

  if (!lockResult.rows[0]?.acquired) {
    held.release();
    return { outcome: 'lock_busy' };
  }

  // `fn`'s own errors run against its own I/O and leave this lock connection's protocol state
  // untouched — they are NOT lock machinery and keep propagating as a rejection (the caller's
  // own error, unwrapped), after the lock is released either way. unlockAndRelease never
  // throws, so the finally cannot mask fn's rejection.
  //
  // If the lock connection dies WHILE fn runs, fn's work has already happened: its result (or its
  // own rejection) is still what the caller gets, and the lost lock is logged by `hold`. Turning
  // finished work into a rejection would make callers retry or report failure for side effects
  // that already landed (start-generation-exclusive relies on a successful run surfacing as
  // `acquired`).
  try {
    const result = await fn();
    return { outcome: 'acquired', result };
  } finally {
    await unlockAndRelease(held);
  }
}
