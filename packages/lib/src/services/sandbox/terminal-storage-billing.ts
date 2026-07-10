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
 * In-process "last attempted a real measurement" clock per pageId. The tool
 * runner calls the helper below on EVERY bash/read/write/edit op, but a machine
 * only needs measuring once per throttle window — this cache lets the common
 * case (within-window) short-circuit BEFORE touching the DB, so a 30-tool-call
 * agent turn does one measurement attempt, not 30 wasted `SELECT`s. It is a
 * best-effort hint only: the authoritative throttle is still the PERSISTED
 * `storageMeasuredAt` re-checked inside `refreshStorageMeasurement` (which
 * survives a process restart and is shared across web instances), so a cold
 * cache simply falls through to the DB read exactly as before.
 */
const lastMeasureAttemptAtMs = new Map<string, number>();

/**
 * Opportunistically measure a machine's used storage bytes while it is ALREADY
 * awake for real work, throttled and fully non-fatal. Fast-paths on an
 * in-process per-page clock to avoid a DB read on every tool op; on a due page
 * it reads the persisted measurement time, measures via `du -sbx`, and persists.
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
  // instance already attempted a measurement for this page within the window.
  const lastAttempt = lastMeasureAttemptAtMs.get(input.pageId);
  if (lastAttempt !== undefined && nowMs - lastAttempt < STORAGE_MEASUREMENT_THROTTLE_MS) {
    return;
  }
  lastMeasureAttemptAtMs.set(input.pageId, nowMs);

  try {
    const [row] = await db
      .select({ storageMeasuredAt: terminalSessions.storageMeasuredAt })
      .from(terminalSessions)
      .where(eq(terminalSessions.pageId, input.pageId))
      .limit(1);
    // No billing row for this page → nothing to attribute the measurement to.
    if (!row) return;

    // Authoritative (persisted) throttle: if another process/instance measured
    // this page within the window, skip BEFORE resolving the handle so a lazy
    // caller with a cold in-process cache (e.g. a freshly-restarted realtime
    // node) never pays a wasted network attach. refreshStorageMeasurement
    // re-checks this too — this is purely to gate the attach.
    if (
      !shouldRefreshMeasurement({
        lastMeasuredAt: row.storageMeasuredAt ?? null,
        now: new Date(nowMs),
        throttleMs: STORAGE_MEASUREMENT_THROTTLE_MS,
      })
    ) {
      return;
    }

    // Resolve the handle only now that we know a measurement is actually due,
    // so a lazy caller's network attach is never paid on a throttled wake.
    const handle = input.handle ?? (input.resolveHandle ? await input.resolveHandle() : null);
    if (!handle) return;

    await refreshStorageMeasurement({
      handle,
      pageId: input.pageId,
      lastMeasuredAt: row.storageMeasuredAt ?? null,
      now: new Date(nowMs),
      persist: persistStorageMeasurement,
    });
  } catch (error) {
    // Best-effort: a measurement failure must never break the real work that
    // woke the sprite.
    loggers.ai.warn('Opportunistic terminal storage measurement failed', {
      pageId: input.pageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
