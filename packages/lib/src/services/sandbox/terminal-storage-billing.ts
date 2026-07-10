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
 * Opportunistically measure a machine's used storage bytes while it is ALREADY
 * awake for real work (terminal connect, agent run, file browse), throttled and
 * fully non-fatal. Reads the row's last measurement time for the throttle,
 * measures via a cheap `df`, and persists. Never throws to the caller and never
 * wakes a paused sprite — the handle is already live because real work is
 * happening on it. Skips silently when the page has no `terminal_sessions` row.
 */
export async function measureMachineStorageOpportunistically(input: {
  handle: Pick<MachineHandle, 'exec'>;
  pageId: string;
}): Promise<void> {
  try {
    const [row] = await db
      .select({ storageMeasuredAt: terminalSessions.storageMeasuredAt })
      .from(terminalSessions)
      .where(eq(terminalSessions.pageId, input.pageId))
      .limit(1);
    // No billing row for this page → nothing to attribute the measurement to.
    if (!row) return;

    await refreshStorageMeasurement({
      handle: input.handle,
      pageId: input.pageId,
      lastMeasuredAt: row.storageMeasuredAt ?? null,
      now: new Date(),
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
