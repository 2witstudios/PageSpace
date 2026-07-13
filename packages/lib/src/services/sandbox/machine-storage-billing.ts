/**
 * Default (real) IO composition for the storage reconcile cron (Sprites
 * Platform Alignment 6-1) — binds `reconcileMachineStorage`'s deps seam to the
 * real `machine_sessions` table, the shared payer-resolution join
 * (`machine-payer.ts`'s `lookupPageOwnerId`), and the credit pipeline. Reads
 * the last PERSISTED measured bytes (never the provisioned cap, never waking a
 * sprite). Also exposes the opportunistic measurement writer + a non-fatal
 * capture helper that real-work paths call while a sprite is already awake.
 * Mirrors `machine-billing.ts`'s composition for active-runtime metering.
 */

import { eq } from '@pagespace/db/operators';
import { db, pool } from '@pagespace/db/db';
import { machineSessions } from '@pagespace/db/schema/machine-sessions';
import { lookupPageOwnerId } from '../../billing/machine-payer';
import { MACHINE_MARKUP_BPS } from '../../billing/credit-pricing';
import { AIMonitoring } from '../../monitoring/ai-monitoring';
import { loggers } from '../../logging/logger-config';
import type { MachineHandle } from './machine-host';
import {
  refreshStorageMeasurement,
  shouldRefreshMeasurement,
  STORAGE_MEASUREMENT_THROTTLE_MS,
  type PersistStorageMeasurement,
} from './machine-storage-measure';
import {
  reconcileMachineStorage,
  type ReconcileMachineStorageDeps,
  type ReconcileMachineStorageResult,
} from './machine-storage-reconcile';

export const defaultReconcileMachineStorageDeps: ReconcileMachineStorageDeps = {
  async listMachines() {
    const rows = await db
      .select({
        pageId: machineSessions.pageId,
        storageLastBilledAt: machineSessions.storageLastBilledAt,
        measuredBytes: machineSessions.storageMeasuredBytes,
        measuredAt: machineSessions.storageMeasuredAt,
        lastActiveAt: machineSessions.lastActiveAt,
      })
      .from(machineSessions);
    return rows;
  },

  lookupPageOwnerId,

  async chargeStorage({ payerId, pageId, costDollars, gbMonths }) {
    await AIMonitoring.trackUsage({
      userId: payerId,
      provider: 'sprites',
      model: 'terminal-machine-storage',
      source: 'terminal',
      // The machine's identifying page — the usage-breakdown's per-machine view
      // groups on this (see machine-billing.ts's trackUsage for the same field).
      pageId,
      providerCostDollars: costDollars,
      // Not a wall-clock duration (this is a background storage charge, not a
      // single timed run) — 0 mirrors the shape of every other non-timed
      // usage row while staying a valid non-negative duration.
      duration: 0,
      success: true,
      // No holdId: a background reconcile charge, not gated against a
      // pre-placed hold (mirrors reconcile-ai-cost's settle path).
      costSource: 'list_price',
      // Same 1.5x substrate floor as active-runtime billing (machine-billing.ts),
      // independent of the shared AI MARKUP_BPS default.
      markupBpsOverride: MACHINE_MARKUP_BPS,
      metadata: { type: 'terminal_storage', pageId, gbMonths },
    });
  },

  async advanceWatermark({ pageId, billedThrough }) {
    await db
      .update(machineSessions)
      .set({ storageLastBilledAt: billedThrough })
      .where(eq(machineSessions.pageId, pageId));
  },

  now: () => new Date(),
};

/**
 * Advisory-lock key for serializing `reconcileMachineStorage` across EVERY
 * caller — a second web/worker container, or a manual/API trigger, can run
 * the cron route concurrently with no shared state to stop it. The crontab
 * flock (Sprites Platform Alignment, #2032) only guards one container's own
 * scheduled ticks; it does nothing for a second container or an out-of-band
 * invocation. `chargeStorage` and `advanceWatermark` are two separate
 * un-transactioned writes (see machine-storage-reconcile.ts's module doc), so
 * two overlapping runs can double-bill the same watermark window. This lock
 * makes every caller overlap-safe, in addition to (not instead of) the flock.
 */
const RECONCILE_MACHINE_STORAGE_LOCK_KEY = 'reconcile-machine-storage';

/**
 * Minimal subset of pg's Pool/PoolClient API the lock needs — kept local
 * (mirrors audit-chainer-worker.ts's PgClient/PgPool) so it's mockable in
 * tests without a real Postgres connection.
 */
interface AdvisoryLockClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  /** pg semantics: release(err) DESTROYS the connection instead of pooling it. */
  release(destroyWithError?: Error): void;
}
interface AdvisoryLockPool {
  connect(): Promise<AdvisoryLockClient>;
}

export type ReconcileMachineStorageRunResult =
  | { outcome: 'lock_busy' }
  | ({ outcome: 'reconciled' } & ReconcileMachineStorageResult);

/**
 * Serializes `reconcileMachineStorage` with a Postgres session-level advisory
 * try-lock, acquired on a dedicated connection: a run that cannot acquire it
 * (another run — any process, any container — already holds it) is a clean
 * no-op and never touches `deps.listMachines`/`chargeStorage`/`advanceWatermark`.
 * The lock is always released in the `finally` when acquired; if the unlock
 * query itself fails, the connection is DESTROYED rather than returned to the
 * pool alive, so a poisoned session cannot leak the session-level lock forever
 * (same rationale as audit-chainer-worker.ts).
 */
export async function reconcileMachineStorageSerialized(
  deps: ReconcileMachineStorageDeps,
  pgPool: AdvisoryLockPool = pool,
): Promise<ReconcileMachineStorageRunResult> {
  const client = await pgPool.connect();
  let lockAcquired = false;

  try {
    const lockResult = await client.query(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
      [RECONCILE_MACHINE_STORAGE_LOCK_KEY],
    );
    lockAcquired = Boolean(lockResult.rows[0]?.acquired);
    if (!lockAcquired) {
      return { outcome: 'lock_busy' };
    }

    const result = await reconcileMachineStorage(deps);
    return { outcome: 'reconciled', ...result };
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [RECONCILE_MACHINE_STORAGE_LOCK_KEY]);
        client.release();
      } catch (unlockError) {
        const err = unlockError instanceof Error ? unlockError : new Error(String(unlockError));
        client.release(err);
      }
    } else {
      client.release();
    }
  }
}

/**
 * Persist an opportunistic storage measurement onto the machine's
 * `machine_sessions` row. Keyed by pageId — a no-op UPDATE if no row exists
 * for the page (nothing to bill against), so callers need not pre-check.
 */
export const persistStorageMeasurement: PersistStorageMeasurement = async ({
  pageId,
  measuredBytes,
  measuredAt,
}) => {
  await db
    .update(machineSessions)
    .set({ storageMeasuredBytes: measuredBytes, storageMeasuredAt: measuredAt })
    .where(eq(machineSessions.pageId, pageId));
};

/**
 * In-process per-page clock recording the last DEFINITIVE measurement outcome
 * (a successful measure, an already-fresh row, or a confirmed no-billing-row).
 * The tool runner calls the helper below on EVERY bash/read/write/edit op, but a
 * machine only needs measuring once per throttle window — this lets the common
 * case (within-window, after a definitive outcome) short-circuit BEFORE touching
 * the DB, so a 30-tool-call turn does one measurement attempt, not 30 wasted
 * `SELECT`s. It is a best-effort hint only: the authoritative throttle is the
 * PERSISTED `storageMeasuredAt` (survives restart, shared across instances).
 *
 * Deliberately NOT stamped on a transient failure (unreachable sprite / failed
 * attach / failed exec) so continuous real work keeps retrying the measurement
 * within the window instead of being locked out until it elapses. Bounded to
 * {@link MEASURE_CACHE_MAX} entries with oldest-first eviction so a long-lived
 * process serving many ephemeral pageIds cannot leak memory.
 */
const MEASURE_CACHE_MAX = 10_000;
const lastMeasureAttemptAtMs = new Map<string, number>();

/**
 * Pages with a measurement IN FLIGHT on this instance right now. The window
 * clock above is only stamped on a definitive OUTCOME (after the awaits), so it
 * cannot collapse a synchronous BURST — N parallel ops for the same page fired
 * in one tick would all pass the window gate and each spawn a DB read + attach +
 * `du` walk. This set is added-to synchronously before the first await and
 * cleared in `finally`, so all-but-the-first concurrent call short-circuits.
 */
const measurementInFlight = new Set<string>();

function noteMeasureAttempt(pageId: string, nowMs: number): void {
  // delete-then-set moves the key to the end so eviction is oldest-first (LRU-ish).
  lastMeasureAttemptAtMs.delete(pageId);
  lastMeasureAttemptAtMs.set(pageId, nowMs);
  if (lastMeasureAttemptAtMs.size > MEASURE_CACHE_MAX) {
    const oldest = lastMeasureAttemptAtMs.keys().next().value;
    if (oldest !== undefined) lastMeasureAttemptAtMs.delete(oldest);
  }
}

/** Test-only: clear the in-process measurement caches so cases don't bleed state. */
export function __resetStorageMeasurementCachesForTests(): void {
  lastMeasureAttemptAtMs.clear();
  measurementInFlight.clear();
}

/**
 * Opportunistically measure a machine's used storage bytes while it is ALREADY
 * awake for real work, throttled and fully non-fatal. Fast-paths on an
 * in-process per-page clock to avoid a DB read on every tool op; on a due page
 * it reads the persisted measurement time, measures via `du -sxB1`, and persists.
 * Never throws to the caller and never wakes a paused sprite — the handle is
 * already live because real work is happening on it. Skips silently when the
 * page has no `machine_sessions` row.
 *
 * Provide the live `handle` directly when the caller already holds one (the
 * agent tool-runner), or a lazy `resolveHandle` when obtaining one costs a
 * network attach (the realtime PTY connect) — `resolveHandle` is called ONLY
 * after the in-process throttle and the row-existence check pass, so a throttled
 * wake pays nothing. Wired at the agent tool-runner (`sandbox-tools-runtime.ts`)
 * and the realtime machine-connect path (`apps/realtime/src/index.ts`); safe to
 * call from any wake source since it is idempotent and throttled.
 */
export async function measureMachineStorageOpportunistically(input: {
  pageId: string;
  handle?: Pick<MachineHandle, 'exec'>;
  resolveHandle?: () => Promise<Pick<MachineHandle, 'exec'> | null>;
}): Promise<void> {
  const nowMs = Date.now();
  // Cheap in-process gate: skip entirely (no DB, no attach, no exec) if THIS
  // instance reached a DEFINITIVE outcome for this page within the window. NOT
  // stamped yet — a transient failure below must leave the page retryable.
  const lastAttempt = lastMeasureAttemptAtMs.get(input.pageId);
  if (lastAttempt !== undefined && nowMs - lastAttempt < STORAGE_MEASUREMENT_THROTTLE_MS) {
    return;
  }
  // Synchronous concurrent-dedup: a burst of parallel ops for the same page in
  // one tick must collapse to a single measurement (the window clock above only
  // stamps AFTER the awaits, so it can't dedup within a tick).
  if (measurementInFlight.has(input.pageId)) return;
  measurementInFlight.add(input.pageId);

  try {
    const [row] = await db
      .select({ storageMeasuredAt: machineSessions.storageMeasuredAt })
      .from(machineSessions)
      .where(eq(machineSessions.pageId, input.pageId))
      .limit(1);
    // No billing row for this page → nothing to attribute the measurement to.
    // Definitive: cache so we don't re-SELECT every op for a page we can't bill.
    if (!row) {
      noteMeasureAttempt(input.pageId, nowMs);
      return;
    }

    // Authoritative (persisted) throttle: if another process/instance measured
    // this page within the window, skip BEFORE resolving the handle so a lazy
    // caller with a cold in-process cache (e.g. a freshly-restarted realtime
    // node) never pays a wasted network attach. refreshStorageMeasurement
    // re-checks this too — this is purely to gate the attach. Definitive: cache.
    if (
      !shouldRefreshMeasurement({
        lastMeasuredAt: row.storageMeasuredAt ?? null,
        now: new Date(nowMs),
        throttleMs: STORAGE_MEASUREMENT_THROTTLE_MS,
      })
    ) {
      noteMeasureAttempt(input.pageId, nowMs);
      return;
    }

    // Resolve the handle only now that we know a measurement is actually due,
    // so a lazy caller's network attach is never paid on a throttled wake. A
    // null handle is a TRANSIENT failure (sprite vanished / attach failed) — do
    // NOT cache, so a later op this window retries.
    const handle = input.handle ?? (input.resolveHandle ? await input.resolveHandle() : null);
    if (!handle) return;

    const result = await refreshStorageMeasurement({
      handle,
      pageId: input.pageId,
      lastMeasuredAt: row.storageMeasuredAt ?? null,
      now: new Date(nowMs),
      persist: persistStorageMeasurement,
    });
    // Cache only on a successful measure. A failed/unparseable `du` (measured:
    // false) is transient — leave the page retryable within the window.
    if (result.measured) noteMeasureAttempt(input.pageId, nowMs);
  } catch (error) {
    // Best-effort: a measurement failure must never break the real work that
    // woke the sprite.
    loggers.ai.warn('Opportunistic machine storage measurement failed', {
      pageId: input.pageId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    measurementInFlight.delete(input.pageId);
  }
}
