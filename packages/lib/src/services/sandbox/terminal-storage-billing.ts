/**
 * Default (real) IO composition for the storage reconcile cron (Sprites
 * Platform Alignment 6-1) — binds `reconcileTerminalStorage`'s deps seam to the
 * real `terminal_sessions` table, the shared payer-resolution join
 * (`terminal-payer.ts`'s `lookupPageOwnerId`), and the credit pipeline. Reads
 * the last PERSISTED measured bytes (never the provisioned cap, never waking a
 * sprite). Also exposes the opportunistic measurement writer + a non-fatal
 * capture helper that real-work paths call while a sprite is already awake.
 * Mirrors `machine-billing.ts`'s composition for active-runtime metering.
 */

import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { terminalSessions } from '@pagespace/db/schema/terminal-sessions';
import { lookupPageOwnerId } from '../../billing/terminal-payer';
import { TERMINAL_MARKUP_BPS } from '../../billing/credit-pricing';
import { AIMonitoring } from '../../monitoring/ai-monitoring';
import { loggers } from '../../logging/logger-config';
import type { MachineHandle } from './machine-host';
import {
  refreshStorageMeasurement,
  shouldRefreshMeasurement,
  STORAGE_MEASUREMENT_THROTTLE_MS,
  type PersistStorageMeasurement,
} from './terminal-storage-measure';
import type { ReconcileTerminalStorageDeps } from './terminal-storage-reconcile';

export const defaultReconcileTerminalStorageDeps: ReconcileTerminalStorageDeps = {
  async listMachines() {
    const rows = await db
      .select({
        pageId: terminalSessions.pageId,
        storageLastBilledAt: terminalSessions.storageLastBilledAt,
        measuredBytes: terminalSessions.storageMeasuredBytes,
        measuredAt: terminalSessions.storageMeasuredAt,
        lastActiveAt: terminalSessions.lastActiveAt,
      })
      .from(terminalSessions);
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
      markupBpsOverride: TERMINAL_MARKUP_BPS,
      metadata: { type: 'terminal_storage', pageId, gbMonths },
    });
  },

  async advanceWatermark({ pageId, billedThrough }) {
    await db
      .update(terminalSessions)
      .set({ storageLastBilledAt: billedThrough })
      .where(eq(terminalSessions.pageId, pageId));
  },

  now: () => new Date(),
};

/**
 * Persist an opportunistic storage measurement onto the machine's
 * `terminal_sessions` row. Keyed by pageId — a no-op UPDATE if no row exists
 * for the page (nothing to bill against), so callers need not pre-check.
 */
export const persistStorageMeasurement: PersistStorageMeasurement = async ({
  pageId,
  measuredBytes,
  measuredAt,
}) => {
  await db
    .update(terminalSessions)
    .set({ storageMeasuredBytes: measuredBytes, storageMeasuredAt: measuredAt })
    .where(eq(terminalSessions.pageId, pageId));
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
 * page has no `terminal_sessions` row.
 *
 * Provide the live `handle` directly when the caller already holds one (the
 * agent tool-runner), or a lazy `resolveHandle` when obtaining one costs a
 * network attach (the realtime PTY connect) — `resolveHandle` is called ONLY
 * after the in-process throttle and the row-existence check pass, so a throttled
 * wake pays nothing. Wired at the agent tool-runner (`sandbox-tools-runtime.ts`)
 * and the realtime terminal-connect path (`apps/realtime/src/index.ts`); safe to
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
      .select({ storageMeasuredAt: terminalSessions.storageMeasuredAt })
      .from(terminalSessions)
      .where(eq(terminalSessions.pageId, input.pageId))
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
    loggers.ai.warn('Opportunistic terminal storage measurement failed', {
      pageId: input.pageId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    measurementInFlight.delete(input.pageId);
  }
}
