/**
 * Per-holder serialization for dev-preview relay work — the one thing that
 * makes the two tiers safe against each other.
 *
 * WHY A LOCK AT ALL. A plan is made from a row read moments earlier, and two
 * writers act on the same holder: the WEB tier (a user's stop/resume) and the
 * REALTIME tier (the `ports/watch` detector). The detector's frame chain
 * orders one process's own frames and nothing else. Row-first ordering plus
 * the store's compare-and-set already guarantee that a refused write costs no
 * sprite mutation — so nothing is ever orphaned — but they cannot stop two
 * writers from interleaving read/plan/apply and each doing half a job. This
 * lock closes that: read → plan → apply becomes atomic per holder.
 *
 * Both tiers share ONE Postgres, so a Postgres advisory lock genuinely
 * serializes across processes and containers; this is the same primitive
 * `wakePublishedAppSerialized` uses to make one request win a wake.
 *
 * A TRY-LOCK WITH BOUNDED RETRIES, never a waiting one. `withWorkspaceLock`'s
 * waiting `pg_advisory_xact_lock` is the wrong tool here twice over: waiting
 * would stall the detector's frame chain behind a slow web request, and it
 * holds a database TRANSACTION open across `attach` + `services.*` calls to
 * the Sprites control plane — a transaction pinned to network latency.
 *
 * FAILING TO LOCK IS NEVER AN ERROR. `connection_error` (pool exhausted, a
 * reset mid-query) is reported as `busy`, not thrown: a degraded lock pool
 * must not break a user's Stop click or kill a detection frame. Callers have
 * safe busy paths, and the store's compare-and-set remains the second line of
 * defence in every case.
 */

import { getAdvisoryLockPool } from '@pagespace/db/db';
import { withAdvisoryLock, type AdvisoryLockPool } from '@pagespace/db/advisory-lock';
import type { DevPreviewHolderRef } from './dev-preview-core';

/**
 * Advisory-lock keys share one global keyspace with no registry
 * (`advisory-lock.ts`'s own warning), so the key is deliberately verbose:
 * feature, holder kind, holder id.
 */
export function devPreviewLockKeyFor(holder: DevPreviewHolderRef): string {
  return `dev-preview:${holder.kind}:${holder.id}`;
}

export type DevPreviewLockOutcome<T> =
  | { outcome: 'acquired'; result: T }
  /** Someone else holds this holder's lock. `fn` never ran, and nothing was touched. */
  | { outcome: 'busy' };

/**
 * Run `fn` while holding the holder's lock. Injected as a dependency
 * everywhere it is used, so tests can script contention deterministically
 * instead of hoping for a timing window.
 */
export type DevPreviewLock = <T>(holder: DevPreviewHolderRef, fn: () => Promise<T>) => Promise<DevPreviewLockOutcome<T>>;

/** Sleep schedules, exported so callers state their own latency budget. */
export const DEV_PREVIEW_USER_ACTION_RETRIES: readonly number[] = [50, 100, 200, 400, 800];
/**
 * The detector retries briefly rather than dropping the frame, because frames
 * are NOT guaranteed to recur: a `port_opened` for a dev server that then sits
 * quiet is often the last frame for minutes, so a dropped frame can mean the
 * preview silently never appears.
 */
export const DEV_PREVIEW_DETECTOR_RETRIES: readonly number[] = [100, 250];

export interface CreateDevPreviewLockOptions {
  pool?: AdvisoryLockPool;
  retries?: readonly number[];
  wait?: (ms: number) => Promise<void>;
  log?: { warn(message: string, context?: Record<string, unknown>): void };
}

/** A lock bound to the real pool. The pool is resolved lazily, per call, so importing this module opens nothing. */
export function createDevPreviewLock({ pool, retries = [], wait, log }: CreateDevPreviewLockOptions = {}): DevPreviewLock {
  const sleep = wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async <T>(holder: DevPreviewHolderRef, fn: () => Promise<T>): Promise<DevPreviewLockOutcome<T>> => {
    const key = devPreviewLockKeyFor(holder);
    // attempts = the first try plus one per retry delay.
    for (let attempt = 0; attempt <= retries.length; attempt += 1) {
      const locked = await withAdvisoryLock(pool ?? getAdvisoryLockPool(), key, fn);
      if (locked.outcome === 'acquired') return { outcome: 'acquired', result: locked.result };
      if (locked.outcome === 'connection_error') {
        // NOT "proceeding unserialized" — nothing serialized ever runs without
        // the lock. The detector DEFERS its reconcile entirely, and a user
        // action records only its INTENT (one compare-and-set, safe on its
        // own) and defers the relay work with `lockContended`. The old wording
        // read as though the read-plan-apply sequence had gone ahead
        // unprotected, which is the one thing that never happens here.
        log?.warn('dev-preview: lock pool unavailable, relay work deferred', {
          holderKind: holder.kind,
          holderId: holder.id,
          error: locked.error instanceof Error ? locked.error.message : String(locked.error),
        });
        return { outcome: 'busy' };
      }
      const delay = retries[attempt];
      if (delay !== undefined) await sleep(delay);
    }
    return { outcome: 'busy' };
  };
}

/** A lock that always acquires — the default where serialization is optional (pure unit surfaces, tests). */
export const unlocked: DevPreviewLock = async (_holder, fn) => ({ outcome: 'acquired', result: await fn() });
