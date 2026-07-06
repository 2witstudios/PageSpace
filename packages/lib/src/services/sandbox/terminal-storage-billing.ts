/**
 * Default (real) IO composition for the idle-storage reconcile cron
 * (Terminal Epic 3) — binds `reconcileTerminalStorage`'s deps seam to the real
 * `terminal_sessions` table, the shared payer-resolution join
 * (`terminal-payer.ts`'s `lookupPageOwnerId`), and the credit pipeline.
 * Mirrors `machine-billing.ts`'s composition for active-runtime metering.
 */

import { eq } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { terminalSessions } from '@pagespace/db/schema/terminal-sessions';
import { SANDBOX_RESOURCE_CAPS } from './execution-policy';
import { lookupPageOwnerId } from '../../billing/terminal-payer';
import { AIMonitoring } from '../../monitoring/ai-monitoring';
import type { ReconcileTerminalStorageDeps } from './terminal-storage-reconcile';

export const defaultReconcileTerminalStorageDeps: ReconcileTerminalStorageDeps = {
  async listMachines() {
    const rows = await db
      .select({ pageId: terminalSessions.pageId, storageLastBilledAt: terminalSessions.storageLastBilledAt })
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

  // The actual provisioned persistent-storage cap per machine (agent + terminal
  // sandboxes share this at creation — see network-options.ts), not an estimate.
  storageGB: SANDBOX_RESOURCE_CAPS.storageGB,
};
