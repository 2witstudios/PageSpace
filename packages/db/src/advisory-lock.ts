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

/**
 * Thrown by {@link throwIfLockLost} when work that must run under the lock is about to start after
 * the lock connection died. Carries the connection's error as `connectionError`.
 */
export class AdvisoryLockLostError extends Error {
  /** The lock connection's own error — the reason its AbortSignal was aborted. */
  readonly connectionError: unknown;

  constructor(work: string, connectionError: unknown) {
    super(`advisory lock lost before ${work} — skipped; the next run under a fresh lock redoes it`);
    this.name = 'AdvisoryLockLostError';
    this.connectionError = connectionError;
  }
}

/**
 * The guard for `fn`s that charge or write non-idempotently under {@link withAdvisoryLock}: call it
 * immediately before each such step. Once the lock connection has died another holder may be
 * running the same work, so the step must not run. `signal` is optional so code that also runs
 * outside the lock (tests, already-serialized callers) can pass nothing.
 */
export function throwIfLockLost(signal: AbortSignal | undefined, work: string): void {
  if (signal?.aborted) throw new AdvisoryLockLostError(work, signal.reason);
}

export type WithAdvisoryLockResult<T> =
  | { outcome: 'lock_busy' }
  | {
      outcome: 'acquired';
      result: T;
      /**
       * True when the lock connection's backend died while `fn` ran. Postgres drops a session
       * lock together with its backend, so from that moment ANOTHER holder could acquire the same
       * key and run concurrently with the rest of `fn`. `fn` was told through its AbortSignal and
       * should have stopped its exclusive work; this flag lets the caller count or report a run
       * that finished without exclusion. Still `acquired` (never a rejection), because `fn`'s work
       * up to that point really happened.
       */
      lockLost: boolean;
    }
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
  /** Aborted (with the connection's error as its reason) the moment the connection errors. */
  readonly signal: AbortSignal;
  /** Remove the listener; call immediately before handing the client to release(). */
  detach(): void;
  /** Detach the listener and release — destroying when handed an error or when the connection errored. Never throws. */
  release(destroyWithError?: Error): void;
};

function hold(client: AdvisoryLockClient, lockKey: string): HeldConnection {
  let connectionError: Error | null = null;
  const lockLost = new AbortController();
  const onError = (error: Error) => {
    connectionError ??= error;
    if (!lockLost.signal.aborted) lockLost.abort(error);
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
    signal: lockLost.signal,
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
  fn: (signal: AbortSignal) => Promise<T>,
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

  // The try-lock can resolve and the socket close in the same I/O turn: the listener has then
  // already recorded the drop, and with it the session lock is gone. Never start `fn` on a lock
  // that no longer exists — report the connection failure instead.
  const droppedDuringTryLock = held.error();
  if (droppedDuringTryLock) {
    held.release(droppedDuringTryLock);
    return { outcome: 'connection_error', error: droppedDuringTryLock };
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
  // If the lock connection dies WHILE fn runs, exclusion is gone from that moment: another holder
  // can acquire the key and run alongside the rest of fn. `fn` receives `held.signal`, which is
  // aborted on that first 'error'; work that must not run twice (a charge, a non-idempotent
  // correction) checks `signal.aborted` before each step and stops, leaving the remainder to the
  // next run under a fresh lock. The outcome stays `acquired` with `lockLost: true` — never a
  // rejection, since what fn already did really happened (start-generation-exclusive relies on a
  // successful run surfacing as `acquired`). A fn that rejects still rejects with its own error.
  try {
    const result = await fn(held.signal);
    return { outcome: 'acquired', result, lockLost: held.signal.aborted };
  } finally {
    await unlockAndRelease(held);
  }
}

/** First and longest pause between try-lock attempts while waiting. */
const WAIT_BACKOFF_START_MS = 10;
const WAIT_BACKOFF_MAX_MS = 200;

/**
 * `withAdvisoryLock`, but WAITING for the lock (up to `timeoutMs`) instead of giving up at once —
 * for work that must happen in turn rather than be skipped when someone else holds the key (a
 * terminal's billing-window claims, review #2760 re-review P2-1). Cross-process: it is the same
 * Postgres session lock, so two realtime instances serialize too.
 *
 * The wait holds NO connection (re-review 5408117045 P3-1): each attempt is one `withAdvisoryLock`
 * try-lock, and between attempts the connection is back in the pool, with a backoff from 10ms
 * doubling to 200ms. A burst of waiters therefore cannot starve the pool, which a server-side
 * `pg_advisory_lock` wait (one parked connection per waiter) would. Not FIFO: whichever waiter
 * tries first after the release wins.
 *
 * `lock_busy` means the deadline passed; `fn` never ran. `connection_error` is returned at once (no
 * retry). `fn`'s own rejection propagates after the lock is released, as in `withAdvisoryLock`.
 */
export async function withBlockingAdvisoryLock<T>(
  pool: AdvisoryLockPool,
  lockKey: string,
  fn: () => Promise<T>,
  { timeoutMs, sleep = defaultSleep }: { timeoutMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<WithAdvisoryLockResult<T>> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let backoff = WAIT_BACKOFF_START_MS;
  for (;;) {
    const attempt = await withAdvisoryLock(pool, lockKey, fn);
    if (attempt.outcome !== 'lock_busy') return attempt;
    const left = deadline - Date.now();
    if (left <= 0) return { outcome: 'lock_busy' };
    await sleep(Math.min(backoff, left));
    backoff = Math.min(backoff * 2, WAIT_BACKOFF_MAX_MS);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
