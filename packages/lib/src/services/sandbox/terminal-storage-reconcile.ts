/**
 * Idle-storage reconcile (Terminal Epic 3) — periodically meters the cost of
 * a Machine's PERSISTENT filesystem, whether the machine is active or
 * hibernating. Sprites' storage volume is NOT free while hibernating (only
 * CPU/mem are), so a Machine left idle-but-not-torn-down still accrues this
 * cost — see credit-pricing.ts's `TERMINAL_STORAGE_USD_PER_GB_MONTH` and
 * terminal-pricing.ts's `calculateTerminalStorageCostDollars`, whose first
 * caller this is.
 *
 * `terminal_sessions` already enumerates every known machine: a row is only
 * ever deleted on explicit session-end/crash, NOT on idle — persistent
 * sessions hibernate in place and keep their row (terminal-session-manager.ts's
 * `planTerminalLifecycle`) — so iterating this table covers both active and
 * hibernating machines with no separate registry needed.
 *
 * Idempotent / drift-correcting: each row tracks its own
 * `storageLastBilledAt` watermark, so a run only bills the window that has
 * ACTUALLY elapsed since it last billed that row. Two runs back-to-back (or
 * any rerun before real time has passed) see zero elapsed time, which prices
 * to exactly $0 (`calculateTerminalStorageCostDollars` floors non-positive
 * quantities to 0) — so a rerun charges nothing and leaves the watermark
 * untouched, a pure no-op. A missed run is caught up exactly on the next one
 * (the watermark never silently advances without a matching charge), so
 * there's no drift either way.
 */

import { calculateTerminalStorageCostDollars } from '../../monitoring/terminal-pricing';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** A billing month, for prorating the monthly storage rate over an elapsed span. Not tied to any subscription's actual renewal cycle — storage accrual is metered independently of it. */
export const MS_PER_STORAGE_MONTH = 30 * MS_PER_DAY;

/** Pure: GB-months accrued by `storageGB` of persistent storage over `elapsedMs`. Non-positive inputs accrue nothing. */
export function computeElapsedGbMonths(input: { storageGB: number; elapsedMs: number }): number {
  if (input.storageGB <= 0 || input.elapsedMs <= 0) return 0;
  return (input.storageGB * input.elapsedMs) / MS_PER_STORAGE_MONTH;
}

export interface TerminalStorageMachineRow {
  pageId: string;
  storageLastBilledAt: Date;
}

export interface ReconcileTerminalStorageDeps {
  /** Every machine with a persistent fs to meter (see module doc — hibernated rows are included). */
  listMachines: () => Promise<TerminalStorageMachineRow[]>;
  /** Resolves a page's owning drive's ownerId; null when it can't be resolved (e.g. an orphaned row). */
  lookupPageOwnerId: (pageId: string) => Promise<string | null>;
  /** Charges the payer for this machine's accrued storage cost. Not hold-gated — a background reconcile charge, mirroring reconcile-ai-cost. */
  chargeStorage: (input: { payerId: string; pageId: string; costDollars: number; gbMonths: number }) => Promise<void>;
  /** Persists the new watermark so the next run only bills the following window. */
  advanceWatermark: (input: { pageId: string; billedThrough: Date }) => Promise<void>;
  now: () => Date;
  /** Persistent storage provisioned per machine, in GB (the actual per-machine cap — not an estimate). */
  storageGB: number;
}

export interface ReconcileTerminalStorageResult {
  processed: number;
  charged: number;
  /** Rows with a positive accrual whose owner could not be resolved — left unbilled (watermark untouched) for a future run to retry. */
  skipped: number;
  totalCostDollars: number;
}

export async function reconcileTerminalStorage(
  deps: ReconcileTerminalStorageDeps,
): Promise<ReconcileTerminalStorageResult> {
  const machines = await deps.listMachines();
  const now = deps.now();

  let charged = 0;
  let skipped = 0;
  let totalCostDollars = 0;

  for (const machine of machines) {
    const elapsedMs = now.getTime() - machine.storageLastBilledAt.getTime();
    const gbMonths = computeElapsedGbMonths({ storageGB: deps.storageGB, elapsedMs });
    const costDollars = calculateTerminalStorageCostDollars(gbMonths);

    // Nothing has accrued (zero/negative elapsed window) — no-op, watermark
    // stays put since there is nothing to advance it past.
    if (costDollars <= 0) continue;

    const ownerId = await deps.lookupPageOwnerId(machine.pageId);
    if (!ownerId) {
      // Can't resolve who to bill (e.g. the page/drive vanished). Leave the
      // watermark untouched so this window keeps accruing until it either
      // resolves on a later run or the session row itself is torn down.
      skipped += 1;
      continue;
    }

    await deps.chargeStorage({ payerId: ownerId, pageId: machine.pageId, costDollars, gbMonths });
    await deps.advanceWatermark({ pageId: machine.pageId, billedThrough: now });
    totalCostDollars += costDollars;
    charged += 1;
  }

  return { processed: machines.length, charged, skipped, totalCostDollars };
}
