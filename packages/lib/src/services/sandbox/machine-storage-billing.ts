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

import { eq, isNull } from '@pagespace/db/operators';
import { db, getAdvisoryLockPool } from '@pagespace/db/db';
import { withAdvisoryLock, type AdvisoryLockPool } from '@pagespace/db/advisory-lock';
import { machineSessions } from '@pagespace/db/schema/machine-sessions';
import { machineBranches } from '@pagespace/db/schema/machine-branches';
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
import { storageSubjectKey, type StorageSubject } from './machine-storage-attribution';

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

  /**
   * Every branch-terminal Sprite we still believe is LIVE. `spriteTornDownAt IS
   * NOT NULL` rows are excluded, not billed at 0: their filesystem is gone, and
   * the row survives only as re-creatable config (see the column's doc in
   * `@pagespace/db/schema/machine-branches`) — metering a destroyed disk would
   * bill for storage nobody holds.
   *
   * `lastActiveAt` is joined from the OWNING machine's session row because that
   * is where branch runs record activity (`branch-session.ts` keys the guardrail
   * and activity by `machineId`). It feeds ONLY the staleness health flag; a
   * branch whose machine has no session row at all (never opened) falls back to
   * the epoch — i.e. "not awake", the honest conservative reading.
   */
  async listBranchSprites() {
    const rows = await db
      .select({
        machineBranchId: machineBranches.id,
        machinePageId: machineBranches.machineId,
        storageLastBilledAt: machineBranches.storageLastBilledAt,
        measuredBytes: machineBranches.storageMeasuredBytes,
        measuredAt: machineBranches.storageMeasuredAt,
        lastActiveAt: machineSessions.lastActiveAt,
      })
      .from(machineBranches)
      .leftJoin(machineSessions, eq(machineSessions.pageId, machineBranches.machineId))
      .where(isNull(machineBranches.spriteTornDownAt));
    // `machine_sessions.pageId` carries NO uniqueness guarantee (only
    // `sessionKey` is unique), so the join can fan a branch out into one row
    // per matching session — and a fanned-out row here is a branch disk
    // BILLED TWICE by reconcile. One row per branch, freshest activity wins
    // (the join only feeds the staleness flag).
    const byBranch = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const kept = byBranch.get(row.machineBranchId);
      if (!kept || (row.lastActiveAt ?? new Date(0)) > (kept.lastActiveAt ?? new Date(0))) {
        byBranch.set(row.machineBranchId, row);
      }
    }
    return [...byBranch.values()].map((row) => ({ ...row, lastActiveAt: row.lastActiveAt ?? new Date(0) }));
  },

  lookupPageOwnerId,

  async chargeStorage({ payerId, pageId, costDollars, gbMonths }) {
    await AIMonitoring.trackUsage({
      userId: payerId,
      provider: 'sprites',
      model: 'terminal-machine-storage',
      source: 'terminal',
      // The ATTRIBUTION page (machine-storage-attribution.ts): the machine's own
      // identifying page, or — for a branch-terminal Sprite — its OWNING
      // machine's. The usage-breakdown's per-machine view groups on this (see
      // machine-billing.ts's trackUsage for the same field), so a branch's
      // storage lands under the Terminal the user actually sees.
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

  // The branch Sprite's OWN watermark — on its `machine_branches` row, keyed by
  // the branch row id, even though the charge it follows was attributed to the
  // owning machine page. Two branches of one machine each bill their own window.
  async advanceBranchWatermark({ machineBranchId, billedThrough }) {
    await db
      .update(machineBranches)
      .set({ storageLastBilledAt: billedThrough })
      .where(eq(machineBranches.id, machineBranchId));
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
 * Acquired via `withAdvisoryLock` on `getAdvisoryLockPool()`'s dedicated
 * pool — see that pool's doc in `@pagespace/db/db` for why it must stay
 * separate from the main `db` pool `deps` below queries against.
 */
const RECONCILE_MACHINE_STORAGE_LOCK_KEY = 'reconcile-machine-storage';

export type ReconcileMachineStorageRunResult =
  | { outcome: 'lock_busy' }
  | ({ outcome: 'reconciled' } & ReconcileMachineStorageResult);

/**
 * Serializes `reconcileMachineStorage` with a Postgres session-level advisory
 * try-lock (see `withAdvisoryLock`): a run that cannot acquire it (another
 * run — any process, any container — already holds it) is a clean no-op and
 * never touches `deps.listMachines`/`chargeStorage`/`advanceWatermark`.
 */
export async function reconcileMachineStorageSerialized(
  deps: ReconcileMachineStorageDeps,
  pgPool: AdvisoryLockPool = getAdvisoryLockPool(),
): Promise<ReconcileMachineStorageRunResult> {
  const locked = await withAdvisoryLock(pgPool, RECONCILE_MACHINE_STORAGE_LOCK_KEY, () =>
    reconcileMachineStorage(deps),
  );
  if (locked.outcome === 'lock_busy') {
    return { outcome: 'lock_busy' };
  }
  if (locked.outcome === 'connection_error') {
    // Preserves this caller's existing behavior exactly (previously an unwrapped throw
    // from `withAdvisoryLock` itself): propagate so the cron route's own catch logs it
    // and the next scheduled tick retries. `withAdvisoryLock` resolving this outcome
    // instead of throwing (leaf 5.6/5.7) only removes the AMBIGUITY for callers that
    // need to distinguish it from `fn` throwing — this caller's `fn`
    // (`reconcileMachineStorage`) already documents that it never throws, so there is
    // no such ambiguity here, and the choice to keep propagating is now explicit at the
    // type level rather than implicit in an uncaught rejection.
    throw locked.error;
  }
  return { outcome: 'reconciled', ...locked.result };
}

/**
 * Persist an opportunistic storage measurement onto the row of the Sprite that
 * was actually measured — the machine's `machine_sessions` row, or the branch
 * terminal's own `machine_branches` row. Writing a branch's footprint onto its
 * machine's row would clobber the machine's own measured bytes and over-bill it
 * (the reason branch storage was attributed nowhere before phase 3), so the
 * subject picks the table; only BILLING collapses both onto the machine page.
 * A no-op UPDATE if no such row exists, so callers need not pre-check.
 */
export const persistStorageMeasurement: PersistStorageMeasurement = async ({
  subject,
  measuredBytes,
  measuredAt,
}) => {
  if (subject.kind === 'machine') {
    await db
      .update(machineSessions)
      .set({ storageMeasuredBytes: measuredBytes, storageMeasuredAt: measuredAt })
      .where(eq(machineSessions.pageId, subject.pageId));
    return;
  }
  await db
    .update(machineBranches)
    .set({ storageMeasuredBytes: measuredBytes, storageMeasuredAt: measuredAt })
    .where(eq(machineBranches.id, subject.machineBranchId));
};

/**
 * In-process per-SUBJECT clock recording the last DEFINITIVE measurement outcome
 * (a successful measure, an already-fresh row, or a confirmed no-billing-row).
 * The tool runner calls the helper below on EVERY bash/read/write/edit op, but a
 * sprite only needs measuring once per throttle window — this lets the common
 * case (within-window, after a definitive outcome) short-circuit BEFORE touching
 * the DB, so a 30-tool-call turn does one measurement attempt, not 30 wasted
 * `SELECT`s. It is a best-effort hint only: the authoritative throttle is the
 * PERSISTED `storageMeasuredAt` (survives restart, shared across instances).
 *
 * Keyed by `storageSubjectKey`, NOT a bare id: a machine and one of its branch
 * Sprites are two independent filesystems measured on their own windows, and the
 * namespaced key keeps a branch row id from ever colliding with a page id.
 *
 * Deliberately NOT stamped on a transient failure (unreachable sprite / failed
 * attach / failed exec) so continuous real work keeps retrying the measurement
 * within the window instead of being locked out until it elapses. Bounded to
 * {@link MEASURE_CACHE_MAX} entries with oldest-first eviction so a long-lived
 * process serving many ephemeral subjects cannot leak memory.
 */
const MEASURE_CACHE_MAX = 10_000;
const lastMeasureAttemptAtMs = new Map<string, number>();

/**
 * Subjects with a measurement IN FLIGHT on this instance right now. The window
 * clock above is only stamped on a definitive OUTCOME (after the awaits), so it
 * cannot collapse a synchronous BURST — N parallel ops for the same sprite fired
 * in one tick would all pass the window gate and each spawn a DB read + attach +
 * `du` walk. This set is added-to synchronously before the first await and
 * cleared in `finally`, so all-but-the-first concurrent call short-circuits.
 */
const measurementInFlight = new Set<string>();

function noteMeasureAttempt(key: string, nowMs: number): void {
  // delete-then-set moves the key to the end so eviction is oldest-first (LRU-ish).
  lastMeasureAttemptAtMs.delete(key);
  lastMeasureAttemptAtMs.set(key, nowMs);
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
 * Read the measurement bookkeeping for a subject from ITS OWN table. `found:
 * false` is a DEFINITIVE "nothing to attribute a measurement to" — no billing
 * row (machine), or a branch whose Sprite is already torn down (its filesystem
 * is gone, so a measurement of it would be meaningless).
 */
async function readMeasurementState(
  subject: StorageSubject,
): Promise<{ found: boolean; lastMeasuredAt: Date | null }> {
  if (subject.kind === 'machine') {
    const [row] = await db
      .select({ storageMeasuredAt: machineSessions.storageMeasuredAt })
      .from(machineSessions)
      .where(eq(machineSessions.pageId, subject.pageId))
      .limit(1);
    return row ? { found: true, lastMeasuredAt: row.storageMeasuredAt ?? null } : { found: false, lastMeasuredAt: null };
  }
  const [row] = await db
    .select({
      storageMeasuredAt: machineBranches.storageMeasuredAt,
      spriteTornDownAt: machineBranches.spriteTornDownAt,
    })
    .from(machineBranches)
    .where(eq(machineBranches.id, subject.machineBranchId))
    .limit(1);
  if (!row || row.spriteTornDownAt !== null) return { found: false, lastMeasuredAt: null };
  return { found: true, lastMeasuredAt: row.storageMeasuredAt ?? null };
}

/**
 * Opportunistically measure a Sprite's used storage bytes while it is ALREADY
 * awake for real work, throttled and fully non-fatal — the ONE core both the
 * machine and branch entry points below share, so neither can drift onto its own
 * throttle, dedup or persist rule. Fast-paths on an in-process per-subject clock
 * to avoid a DB read on every tool op; on a due subject it reads the persisted
 * measurement time, measures via `du -sxB1`, and persists to the subject's own
 * row. Never throws to the caller and NEVER wakes a paused sprite — the handle is
 * already live because real work is happening on it (a lazy `resolveHandle` is
 * only ever called for a sprite the caller already holds/attached).
 */
async function measureStorageOpportunistically(input: {
  subject: StorageSubject;
  handle?: Pick<MachineHandle, 'exec'>;
  resolveHandle?: () => Promise<Pick<MachineHandle, 'exec'> | null>;
}): Promise<void> {
  const key = storageSubjectKey(input.subject);
  const nowMs = Date.now();
  // Cheap in-process gate: skip entirely (no DB, no attach, no exec) if THIS
  // instance reached a DEFINITIVE outcome for this subject within the window. NOT
  // stamped yet — a transient failure below must leave the subject retryable.
  const lastAttempt = lastMeasureAttemptAtMs.get(key);
  if (lastAttempt !== undefined && nowMs - lastAttempt < STORAGE_MEASUREMENT_THROTTLE_MS) {
    return;
  }
  // Synchronous concurrent-dedup: a burst of parallel ops for the same subject in
  // one tick must collapse to a single measurement (the window clock above only
  // stamps AFTER the awaits, so it can't dedup within a tick).
  if (measurementInFlight.has(key)) return;
  measurementInFlight.add(key);

  try {
    const state = await readMeasurementState(input.subject);
    // Nothing to attribute the measurement to (no billing row / torn-down
    // Sprite). Definitive: cache so we don't re-SELECT every op for it.
    if (!state.found) {
      noteMeasureAttempt(key, nowMs);
      return;
    }

    // Authoritative (persisted) throttle: if another process/instance measured
    // this subject within the window, skip BEFORE resolving the handle so a lazy
    // caller with a cold in-process cache (e.g. a freshly-restarted realtime
    // node) never pays a wasted network attach. refreshStorageMeasurement
    // re-checks this too — this is purely to gate the attach. Definitive: cache.
    if (
      !shouldRefreshMeasurement({
        lastMeasuredAt: state.lastMeasuredAt,
        now: new Date(nowMs),
        throttleMs: STORAGE_MEASUREMENT_THROTTLE_MS,
      })
    ) {
      noteMeasureAttempt(key, nowMs);
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
      subject: input.subject,
      lastMeasuredAt: state.lastMeasuredAt,
      now: new Date(nowMs),
      persist: persistStorageMeasurement,
    });
    // Cache only on a successful measure. A failed/unparseable `du` (measured:
    // false) is transient — leave the subject retryable within the window.
    if (result.measured) noteMeasureAttempt(key, nowMs);
  } catch (error) {
    // Best-effort: a measurement failure must never break the real work that
    // woke the sprite.
    loggers.ai.warn('Opportunistic storage measurement failed', {
      subject: key,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    measurementInFlight.delete(key);
  }
}

/**
 * Measure a MACHINE's own Sprite (persists to its `machine_sessions` row).
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
  await measureStorageOpportunistically({
    subject: { kind: 'machine', pageId: input.pageId },
    handle: input.handle,
    resolveHandle: input.resolveHandle,
  });
}

/**
 * Measure a BRANCH-TERMINAL's own Sprite (persists to its `machine_branches`
 * row; billed to the owning machine page by the reconcile — see
 * machine-storage-attribution.ts).
 *
 * Wired at the branch wake paths that hold a live handle: `spawnBranch` (right
 * after the clone that writes the bulk of a branch Sprite's footprint) and
 * `attachBranch` (every reattach), both in
 * `services/machines/machine-branches.ts`. Same never-wake rule as the machine
 * entry point — it only ever measures a sprite the caller already has awake.
 */
export async function measureBranchStorageOpportunistically(input: {
  machineBranchId: string;
  machinePageId: string;
  handle?: Pick<MachineHandle, 'exec'>;
  resolveHandle?: () => Promise<Pick<MachineHandle, 'exec'> | null>;
}): Promise<void> {
  await measureStorageOpportunistically({
    subject: {
      kind: 'branch',
      machineBranchId: input.machineBranchId,
      machinePageId: input.machinePageId,
    },
    handle: input.handle,
    resolveHandle: input.resolveHandle,
  });
}
