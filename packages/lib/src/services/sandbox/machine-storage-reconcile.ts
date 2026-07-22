/**
 * Storage reconcile (Sprites Platform Alignment 6-1) — periodically meters the
 * cost of a Machine's PERSISTENT filesystem, whether the machine is active or
 * hibernating. The platform bills for the bytes a machine has ACTUALLY written
 * (TRIM-friendly — deleting files lowers the bill), NOT the provisioned volume
 * size (docs.sprites.dev/concepts/lifecycle). So this bills the last PERSISTED
 * MEASURED footprint (`machine-storage-measure.ts` captures it opportunistically
 * while the sprite is already awake for real work), never the provisioned cap —
 * a machine that wrote 200MB is metered at 200MB, not the 5GB allocation. See
 * credit-pricing.ts's `MACHINE_STORAGE_USD_PER_GB_MONTH` and
 * machine-pricing.ts's `calculateMachineStorageCostDollars`.
 *
 * NEVER wakes a paused sprite to measure — that would recreate the Phase-3
 * keep-awake billing bug. The cron reads only what real-work wakes have already
 * persisted; a machine that has never been measured bills a conservative 0
 * floor (NOT the provisioned cap) for that window, and its watermark still
 * advances so the un-measured span is not billed retroactively when a
 * measurement lands (clean cutover from the old allocation-billing). Bounded
 * exception: the FIRST measured window spans from the last watermark advance to
 * now, so at most ONE reconcile interval of pre-measurement time is billed once,
 * at the measured rate — a deliberate, bounded, one-time residual (a single
 * watermark carries no separate "measurement started here" marker).
 *
 * Known trade-offs of the "never wake to measure" rule (favouring the platform's
 * hard no-keep-awake constraint over perfect accuracy):
 *   • Coverage: measurement is captured only on wake paths that call
 *     `measureMachineStorageOpportunistically` (the agent tool-runner today). A
 *     machine exercised ONLY through a wake path that doesn't yet measure (e.g.
 *     interactive-PTY-only) stays never-measured and bills the 0 floor until such
 *     a path wires measurement in — an under-count, strictly better than the old
 *     flat-cap over-bill, and closed by wiring more wake paths (follow-up).
 *   • Shrink lag: a machine that frees storage then hibernates without any
 *     further real-work wake keeps billing its last (higher) measured footprint;
 *     it self-corrects on the next wake. `staleMeasurements` surfaces how many
 *     rows are billing on an ageing measurement so this is observable.
 *
 * THREE row sources, one meter (issue #2204 phases 3 and 7): a Machine's own
 * Sprite (`machine_sessions`), every live branch-terminal Sprite
 * (`machine_branches`), and every PROMOTED project Sprite (`machine_projects`)
 * — each a separate persistent filesystem. Each one's measurement and watermark
 * live on its OWN row, but every CHARGE is attributed to the owning Machine page
 * — the payer key and the field the per-machine usage breakdown groups on (see
 * `machine-storage-attribution.ts`). Before phase 3, branch Sprites accrued
 * storage cost that was billed nowhere at all; a promoted project's Sprite would
 * have had the same hole, since promotion moves its bytes off the machine's own
 * measured filesystem.
 *
 * `machine_sessions` already enumerates every known machine: a row is only
 * ever deleted on explicit session-end/crash, NOT on idle — persistent
 * sessions hibernate in place and keep their row (machine-session-manager.ts's
 * `planMachineLifecycle`) — so iterating this table covers both active and
 * hibernating machines with no separate registry needed.
 *
 * Idempotent / drift-correcting on the happy path: each row tracks its own
 * `storageLastBilledAt` watermark, so a run only bills the window that has
 * ACTUALLY elapsed since it last billed that row. Two runs back-to-back (or
 * any rerun before real time has passed) see zero elapsed time, which prices
 * to exactly $0 (`calculateMachineStorageCostDollars` floors non-positive
 * quantities to 0) — so a rerun charges nothing and leaves the watermark
 * untouched, a pure no-op. A missed run is caught up exactly on the next one
 * (the watermark never silently advances without a matching charge), so
 * there's no drift either way.
 *
 * `chargeStorage` and `advanceWatermark` are two separate un-transactioned
 * writes (the charge goes through the shared credit pipeline; the watermark
 * is a plain column update) — deliberately charge-before-advance so a crash
 * before charging never loses a window. The flip side: if the process dies
 * BETWEEN the two (rare — no I/O happens in between), that row's window is
 * billed again on the next run, since the watermark never moved. Each row is
 * isolated in its own try/catch (below) so this failure mode stays scoped to
 * one machine and never aborts the rest of the batch; it does not eliminate
 * the residual double-bill risk, which would need the charge and the
 * watermark update to commit atomically to close entirely.
 */

import { calculateMachineStorageCostDollars } from '../../monitoring/machine-pricing';
import { bytesToGB } from './machine-storage-measure';
import { storageAttributionPageId, type StorageSubject } from './machine-storage-attribution';
import { loggers } from '../../logging/logger-config';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** A billing month, for prorating the monthly storage rate over an elapsed span. Not tied to any subscription's actual renewal cycle — storage accrual is metered independently of it. */
export const MS_PER_STORAGE_MONTH = 30 * MS_PER_DAY;

/**
 * A persisted measurement older than this (on a machine NOT currently awake) is
 * flagged stale by `pickBillableGB`. Informational only — the reconcile still
 * bills the last measured value (it must NEVER wake a sprite to re-measure);
 * the flag exists so a persistently-stale machine can be surfaced/alerted. An
 * awake machine is refreshed opportunistically, so an old timestamp there isn't
 * stale — a fresh measurement is imminent.
 */
export const STALE_MEASUREMENT_MS = 24 * 60 * 60 * 1000;

/** A machine touched within this window counts as "awake" for staleness — a real-work wake is refreshing its measurement. */
export const RECENTLY_ACTIVE_MS = 5 * 60 * 1000;

/** Pure: GB-months accrued by `measuredGB` of persistent storage over `elapsedMs`. Non-positive inputs accrue nothing. */
export function computeElapsedGbMonths(input: { measuredGB: number; elapsedMs: number }): number {
  if (input.measuredGB <= 0 || input.elapsedMs <= 0) return 0;
  return (input.measuredGB * input.elapsedMs) / MS_PER_STORAGE_MONTH;
}

/**
 * Pure: decide the GB to bill for this window from the last PERSISTED
 * measurement, without ever waking the sprite.
 *
 * - Never measured (null) → 0 floor (NOT the provisioned cap — the old bug),
 *   flagged stale.
 * - Measured → bill the measured GB. `stale` is true only when the machine is
 *   NOT awake and the measurement is older than {@link STALE_MEASUREMENT_MS}
 *   (an awake machine's old timestamp is fine — a refresh is imminent).
 */
export function pickBillableGB(input: {
  lastMeasuredGB: number | null;
  lastMeasuredAt: Date | null;
  awake: boolean;
  now: Date;
}): { gb: number; stale: boolean } {
  const { lastMeasuredGB, lastMeasuredAt, awake, now } = input;
  if (lastMeasuredGB === null || lastMeasuredAt === null) {
    return { gb: 0, stale: true };
  }
  const ageMs = now.getTime() - lastMeasuredAt.getTime();
  const stale = !awake && ageMs > STALE_MEASUREMENT_MS;
  return { gb: Math.max(0, lastMeasuredGB), stale };
}

export interface MachineStorageRow {
  pageId: string;
  storageLastBilledAt: Date;
  /** Last opportunistically-measured used bytes; null when never measured. */
  measuredBytes: number | null;
  /** When `measuredBytes` was captured; null when never measured. */
  measuredAt: Date | null;
  /** Last real-work activity — used to derive `awake` for the staleness signal. */
  lastActiveAt: Date;
}

/**
 * A branch-terminal's OWN Sprite (issue #2204 phase 3). Its filesystem is
 * separate from the owning Machine's, so its measurement and watermark live on
 * its own `machine_branches` row — but it is billed to `machinePageId`, the
 * owning Machine page (see machine-storage-attribution.ts). Torn-down branches
 * have no filesystem left to meter and are expected to be filtered out by the
 * row source, not billed at 0 here.
 */
export interface BranchStorageRow {
  /** The `machine_branches` row id — where THIS Sprite's measurement/watermark are persisted. */
  machineBranchId: string;
  /** The owning Machine page — the attribution key (payer + usage-breakdown grouping). */
  machinePageId: string;
  storageLastBilledAt: Date;
  /** Last opportunistically-measured used bytes on the BRANCH Sprite; null when never measured. */
  measuredBytes: number | null;
  /** When `measuredBytes` was captured; null when never measured. */
  measuredAt: Date | null;
  /**
   * The OWNING machine's last real-work activity — branch runs record activity
   * on the machine key (`branch-session.ts` keys the guardrail/activity by
   * `machineId`), so this is the only awake signal a branch row has. Used
   * solely for the staleness health flag, never for billing.
   */
  lastActiveAt: Date;
}

/**
 * A PROMOTED project's OWN Sprite (issue #2204 phase 7) — the project-tier twin
 * of `BranchStorageRow`, and identical in every billing respect. Promotion moves
 * a project's bytes OFF the machine's own filesystem onto this one, so without
 * this row source those bytes would stop being metered anywhere the moment a
 * project was promoted. Unpromoted and torn-down projects have no Sprite of
 * their own and are expected to be filtered out by the row source, not billed at
 * 0 here.
 */
export interface ProjectStorageRow {
  /** The `machine_projects` row id — where THIS Sprite's measurement/watermark are persisted. */
  machineProjectId: string;
  /** The owning Machine page — the attribution key (payer + usage-breakdown grouping). */
  machinePageId: string;
  storageLastBilledAt: Date;
  /** Last opportunistically-measured used bytes on the PROJECT Sprite; null when never measured. */
  measuredBytes: number | null;
  /** When `measuredBytes` was captured; null when never measured. */
  measuredAt: Date | null;
  /**
   * The OWNING machine's last real-work activity — a promoted project's runs
   * record activity on the machine key (`project-session.ts` keys the
   * guardrail/activity by `machineId`), so this is the only awake signal it has.
   * Used solely for the staleness health flag, never for billing.
   */
  lastActiveAt: Date;
}

/** One metered filesystem, kind-agnostic: what to bill, and who to bill it to. */
interface BillableStorage {
  subject: StorageSubject;
  storageLastBilledAt: Date;
  measuredBytes: number | null;
  measuredAt: Date | null;
  lastActiveAt: Date;
}

export interface ReconcileMachineStorageDeps {
  /** Every machine with a persistent fs to meter (see module doc — hibernated rows are included). */
  listMachines: () => Promise<MachineStorageRow[]>;
  /**
   * Every LIVE branch-terminal Sprite to meter — a second persistent filesystem
   * per row, billed to its owning Machine page. Same never-wake rule: this reads
   * persisted measurements only.
   */
  listBranchSprites: () => Promise<BranchStorageRow[]>;
  /**
   * Every PROMOTED project Sprite to meter (`sandboxId` set, not torn down) —
   * a third persistent filesystem per row, billed to its owning Machine page.
   * Same never-wake rule: this reads persisted measurements only.
   */
  listProjectSprites: () => Promise<ProjectStorageRow[]>;
  /** Resolves a page's owning drive's ownerId; null when it can't be resolved (e.g. an orphaned row). */
  lookupPageOwnerId: (pageId: string) => Promise<string | null>;
  /** Charges the payer for this machine's accrued storage cost. Not hold-gated — a background reconcile charge, mirroring reconcile-ai-cost. */
  chargeStorage: (input: { payerId: string; pageId: string; costDollars: number; gbMonths: number }) => Promise<void>;
  /** Persists the new watermark so the next run only bills the following window. */
  advanceWatermark: (input: { pageId: string; billedThrough: Date }) => Promise<void>;
  /**
   * The same watermark advance for a BRANCH Sprite — a separate writer because
   * the watermark lives on the branch's own `machine_branches` row, even though
   * the CHARGE it follows is attributed to the owning Machine page.
   */
  advanceBranchWatermark: (input: { machineBranchId: string; billedThrough: Date }) => Promise<void>;
  /** The same watermark advance for a PROMOTED PROJECT Sprite, on its own `machine_projects` row. */
  advanceProjectWatermark: (input: { machineProjectId: string; billedThrough: Date }) => Promise<void>;
  now: () => Date;
}

export interface ReconcileMachineStorageResult {
  processed: number;
  charged: number;
  /** Rows with a positive accrual whose owner could not be resolved — left unbilled (watermark untouched) for a future run to retry. */
  skipped: number;
  /** Rows where `chargeStorage`/`advanceWatermark` threw — isolated so one bad row doesn't abort the batch; see module doc on the residual double-bill risk this leaves for a future run to retry. */
  failed: number;
  /**
   * Rows billed from a MEASURED footprint whose measurement is older than
   * {@link STALE_MEASUREMENT_MS} while the machine is not currently awake — the
   * cron bills the last value regardless (it never wakes a sprite), so this is
   * a health signal: a persistently-high count means measurements aren't being
   * refreshed by real-work wakes. Excludes never-measured rows (see `skipped`
   * is unrelated; never-measured simply bill 0).
   */
  staleMeasurements: number;
  totalCostDollars: number;
}

export async function reconcileMachineStorage(
  deps: ReconcileMachineStorageDeps,
): Promise<ReconcileMachineStorageResult> {
  // Both row sources are read the same way — persisted measurements only, no
  // sprite handle anywhere in the deps seam — then metered by ONE loop, so a
  // branch Sprite can never drift onto a different pricing/watermark/staleness
  // rule than a machine's own. Only two things vary by kind: which row the
  // watermark advance writes to, and nothing else (the charge always keys on
  // the attribution page — see machine-storage-attribution.ts).
  const [machines, branches, projects] = await Promise.all([
    deps.listMachines(),
    deps.listBranchSprites(),
    deps.listProjectSprites(),
  ]);
  const now = deps.now();

  const billable: BillableStorage[] = [
    ...machines.map((m) => ({
      subject: { kind: 'machine', pageId: m.pageId } as const,
      storageLastBilledAt: m.storageLastBilledAt,
      measuredBytes: m.measuredBytes,
      measuredAt: m.measuredAt,
      lastActiveAt: m.lastActiveAt,
    })),
    ...branches.map((b) => ({
      subject: { kind: 'branch', machineBranchId: b.machineBranchId, machinePageId: b.machinePageId } as const,
      storageLastBilledAt: b.storageLastBilledAt,
      measuredBytes: b.measuredBytes,
      measuredAt: b.measuredAt,
      lastActiveAt: b.lastActiveAt,
    })),
    ...projects.map((p) => ({
      subject: { kind: 'project', machineProjectId: p.machineProjectId, machinePageId: p.machinePageId } as const,
      storageLastBilledAt: p.storageLastBilledAt,
      measuredBytes: p.measuredBytes,
      measuredAt: p.measuredAt,
      lastActiveAt: p.lastActiveAt,
    })),
  ];

  const advanceWatermark = (subject: StorageSubject, billedThrough: Date): Promise<void> => {
    switch (subject.kind) {
      case 'machine':
        return deps.advanceWatermark({ pageId: subject.pageId, billedThrough });
      case 'branch':
        return deps.advanceBranchWatermark({ machineBranchId: subject.machineBranchId, billedThrough });
      case 'project':
        return deps.advanceProjectWatermark({ machineProjectId: subject.machineProjectId, billedThrough });
    }
  };

  let charged = 0;
  let skipped = 0;
  let failed = 0;
  let staleMeasurements = 0;
  let totalCostDollars = 0;

  for (const machine of billable) {
    // The page this filesystem bills to — the machine's own page, or, for a
    // branch Sprite, its OWNING machine page. One key for the payer lookup, the
    // charge's `pageId`, and therefore the per-machine usage breakdown.
    const attributionPageId = storageAttributionPageId(machine.subject);
    try {
      const elapsedMs = now.getTime() - machine.storageLastBilledAt.getTime();
      const lastMeasuredGB = machine.measuredBytes === null ? null : bytesToGB(machine.measuredBytes);
      const awake = now.getTime() - machine.lastActiveAt.getTime() < RECENTLY_ACTIVE_MS;
      const { gb, stale } = pickBillableGB({ lastMeasuredGB, lastMeasuredAt: machine.measuredAt, awake, now });
      // Health signal (measured-but-stale only; never-measured rows bill 0 and
      // aren't "stale" in the refresh sense).
      if (stale && lastMeasuredGB !== null) staleMeasurements += 1;
      const gbMonths = computeElapsedGbMonths({ measuredGB: gb, elapsedMs });
      const costDollars = calculateMachineStorageCostDollars(gbMonths);

      // Nothing to charge this window (zero elapsed, a never-measured 0 floor,
      // or a footprint so tiny its per-window cost rounds to $0). ALWAYS advance
      // the watermark to now when real time elapsed — for measured and
      // never-measured rows alike.
      //
      // Advancing unconditionally is deliberate: it caps this window's residual
      // at the pricing rounding floor (a sub-cent, and only for footprints under
      // ~2.4MB on an hourly cron, which genuinely cost ~$0), and — critically —
      // it prevents a retroactive OVER-bill. If we instead froze the watermark
      // on a tiny measured footprint, a machine that later grows to (say) 100GB
      // and is re-measured would be billed 100GB across the entire frozen span,
      // charging the payer for storage they did not hold. Losing a sub-cent
      // residual is negligible; retroactively over-charging is not. The
      // never-measured case is likewise advanced so the cutover from the old
      // allocation-billing is clean (its first measured window bills AT MOST one
      // reconcile interval of pre-measurement time — bounded and one-time).
      //
      // A back-to-back rerun (elapsedMs === 0) advances nothing, a pure no-op.
      if (costDollars <= 0) {
        if (elapsedMs > 0) {
          await advanceWatermark(machine.subject, now);
        }
        continue;
      }

      const ownerId = await deps.lookupPageOwnerId(attributionPageId);
      if (!ownerId) {
        // Can't resolve who to bill (e.g. the page/drive vanished). Leave the
        // watermark untouched so this window keeps accruing until it either
        // resolves on a later run or the session row itself is torn down.
        skipped += 1;
        continue;
      }

      await deps.chargeStorage({ payerId: ownerId, pageId: attributionPageId, costDollars, gbMonths });
      await advanceWatermark(machine.subject, now);
      totalCostDollars += costDollars;
      charged += 1;
    } catch (error) {
      // Isolated per-row: one machine's charge/advance failure must not drop
      // every other machine in this run from being billed. Left unresolved: if
      // chargeStorage already committed before advanceWatermark threw, this
      // row's window bills again next run (see module doc).
      failed += 1;
      loggers.ai.error(
        'Machine storage reconcile failed for machine',
        error instanceof Error ? error : new Error(String(error)),
        // The attribution page plus the subject kind: a branch or promoted-project
        // failure must be distinguishable from its owning machine's own row
        // failing, since all three log the same pageId.
        { pageId: attributionPageId, subject: machine.subject.kind },
      );
    }
  }

  return { processed: billable.length, charged, skipped, failed, staleMeasurements, totalCostDollars };
}
