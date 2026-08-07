/**
 * Storage reconcile (Sprites Platform Alignment 6-1) — periodically meters the
 * cost of an agent session's PERSISTENT filesystem, whether the session's
 * sandbox is active or hibernating. The platform bills for the bytes actually
 * written (TRIM-friendly — deleting files lowers the bill), NOT the
 * provisioned volume size (docs.sprites.dev/concepts/lifecycle). So this
 * bills the last PERSISTED MEASURED footprint, never the provisioned cap — a
 * sandbox that wrote 200MB is metered at 200MB, not the 5GB allocation. See
 * credit-pricing.ts's `MACHINE_STORAGE_USD_PER_GB_MONTH` and
 * machine-pricing.ts's `calculateMachineStorageCostDollars`.
 *
 * NEVER wakes a paused sprite to measure — that would recreate the Phase-3
 * keep-awake billing bug. The cron reads only what real-work wakes have
 * already persisted; a session that has never been measured bills a
 * conservative 0 floor (NOT the provisioned cap) for that window, and its
 * watermark still advances so the un-measured span is not billed
 * retroactively when a measurement lands. Bounded exception: the FIRST
 * measured window spans from the last watermark advance to now, so at most
 * ONE reconcile interval of pre-measurement time is billed once, at the
 * measured rate — a deliberate, bounded, one-time residual (a single
 * watermark carries no separate "measurement started here" marker).
 *
 * Known trade-offs of the "never wake to measure" rule (favouring the
 * platform's hard no-keep-awake constraint over perfect accuracy):
 *   • Coverage: a session exercised only through a wake path that doesn't
 *     (yet) measure stays never-measured and bills the 0 floor — an
 *     under-count, strictly better than a flat-cap over-bill.
 *   • Shrink lag: a session that frees storage then hibernates without any
 *     further real-work wake keeps billing its last (higher) measured
 *     footprint; it self-corrects on the next wake. `staleMeasurements`
 *     surfaces how many rows are billing on an ageing measurement so this is
 *     observable.
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
 * billed again on the next run. Each row is isolated in its own try/catch
 * (below) so this failure mode stays scoped to one session and never aborts
 * the rest of the batch.
 *
 * Narrowed by the Phase 8 teardown: this used to meter FIVE row sources — a
 * Machine's own Sprite, every live branch-terminal Sprite, every promoted
 * project Sprite, every per-session agent-terminal Sprite, and every
 * `agent_workspaces` Sprite — one per tier of the deleted Machine page type's
 * tree, ADDED alongside the `agent_workspaces` source in Phase 7 while the
 * machine-tree tables still existed. Only `agent_workspaces` survives (the
 * other four's tables are dropped): a session is a drive-level workspace, so
 * its attribution target is its DRIVE's owner (`driveId` set) OR the
 * session's own `ownerId` directly (a user-scoped global-assistant session,
 * `driveId` null). `storageBillingTarget` (`sandbox-storage-attribution.ts`)
 * is the one place that branches on this for ATTRIBUTION; the `ownerId` case
 * needs no lookup at all — mirroring `billing/sandbox-payer.ts`, whose
 * fallback the real IO composition (`sandbox-storage-billing.ts`) delegates
 * to so the nullable-payer rule is written exactly once.
 */

import { calculateMachineStorageCostDollars } from '../../monitoring/machine-pricing';
import { storageBillingTarget, type StorageSubject } from './sandbox-storage-attribution';
import { loggers } from '../../logging/logger-config';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** A billing month, for prorating the monthly storage rate over an elapsed span. Not tied to any subscription's actual renewal cycle — storage accrual is metered independently of it. */
export const MS_PER_STORAGE_MONTH = 30 * MS_PER_DAY;

/**
 * A persisted measurement older than this (on a sandbox NOT currently awake)
 * is flagged stale by `pickBillableGB`. Informational only — the reconcile
 * still bills the last measured value (it must NEVER wake a sprite to
 * re-measure); the flag exists so a persistently-stale sandbox can be
 * surfaced/alerted. An awake sandbox is refreshed opportunistically, so an
 * old timestamp there isn't stale — a fresh measurement is imminent.
 */
export const STALE_MEASUREMENT_MS = 24 * 60 * 60 * 1000;

/** A sandbox touched within this window counts as "awake" for staleness — a real-work wake is refreshing its measurement. */
export const RECENTLY_ACTIVE_MS = 5 * 60 * 1000;

/** Pure: bytes → DECIMAL gigabytes (÷1e9), matching how the platform expresses its allocation ("100 GB") and its per-GB-month rate — NOT binary GiB. Invalid or non-positive input floors to 0. */
export function bytesToGB(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return bytes / 1_000_000_000;
}

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
 * - Measured → bill the measured GB. `stale` is true only when the sandbox is
 *   NOT awake and the measurement is older than {@link STALE_MEASUREMENT_MS}
 *   (an awake sandbox's old timestamp is fine — a refresh is imminent).
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

/**
 * An `agent_workspaces` row's own Sprite. Rows without a live Sprite
 * (`sandboxId` null) or torn down are expected to be filtered out by the row
 * source, not billed at 0 here.
 */
export interface AgentSessionStorageRow {
  /** The `agent_workspaces` row's own id. Where THIS Sprite's measurement/watermark are persisted. */
  workspaceId: string;
  /** The session's drive; null for a user-scoped global-assistant session (see `storageBillingTarget`). */
  driveId: string | null;
  /** The session's own owner — the payer of last resort, and the ONLY payer when `driveId` is null. */
  ownerId: string;
  storageLastBilledAt: Date;
  /** Last opportunistically-measured used bytes on the SESSION Sprite; null when never measured. */
  measuredBytes: number | null;
  /** When `measuredBytes` was captured; null when never measured. */
  measuredAt: Date | null;
  /** The session's own last real-work activity — `agent_workspaces.lastActiveAt` is a first-class column, no join needed. Used solely for the staleness health flag, never for billing. */
  lastActiveAt: Date;
}

export interface ReconcileSandboxStorageDeps {
  /**
   * Every LIVE `agent_workspaces` Sprite to meter. Never wakes a sprite: reads
   * persisted measurements only.
   */
  listAgentSessionSprites: () => Promise<AgentSessionStorageRow[]>;
  /**
   * Resolves a drive's ownerId; null when it can't be resolved (e.g. a stale
   * read of a drive mid-delete). Used only for a subject whose `driveId` is
   * set — the `driveId === null` case bypasses this entirely (see
   * `storageBillingTarget`, whose `{ ownerId }` branch is already resolved,
   * pure data with no IO needed).
   */
  lookupDriveOwnerId: (driveId: string) => Promise<string | null>;
  /** Charges the payer for this session's accrued storage cost. Not hold-gated — a background reconcile charge, mirroring reconcile-ai-cost. `driveId` is omitted for a global-assistant agent-session (no drive to attribute usage-breakdown to). */
  chargeStorage: (input: { payerId: string; driveId?: string; workspaceId: string; costDollars: number; gbMonths: number }) => Promise<void>;
  /** Persists the new watermark for an `agent_workspaces` Sprite, on the ROW ITSELF — the per-row watermark the design calls for, no separate tracking table needed. */
  advanceAgentSessionWatermark: (input: { workspaceId: string; billedThrough: Date }) => Promise<void>;
  now: () => Date;
}

export interface ReconcileSandboxStorageResult {
  processed: number;
  /** Rows where `chargeStorage` SUCCEEDED — the money moved, regardless of whether the watermark then advanced. Always reflected in `totalCostDollars`. */
  charged: number;
  /** Rows with a positive accrual whose owner could not be resolved — left unbilled (watermark untouched) for a future run to retry. */
  skipped: number;
  /** Rows where `chargeStorage` ITSELF threw — nothing was billed, isolated so one bad row doesn't abort the batch. */
  failed: number;
  /**
   * Rows where `chargeStorage` succeeded but the FOLLOWING `advanceAgentSessionWatermark`
   * threw — the money already moved (counted in `charged`/`totalCostDollars`), but the
   * watermark did not advance, so this row's window WILL be billed again on the next run
   * (see module doc on the double-bill risk this leaves). Distinct from `failed`, where
   * nothing was charged at all.
   */
  chargedButUnadvanced: number;
  /**
   * Rows billed from a MEASURED footprint whose measurement is older than
   * {@link STALE_MEASUREMENT_MS} while the sandbox is not currently awake —
   * the cron bills the last value regardless (it never wakes a sprite), so
   * this is a health signal: a persistently-high count means measurements
   * aren't being refreshed by real-work wakes. Excludes never-measured rows
   * (see `skipped` is unrelated; never-measured simply bill 0).
   */
  staleMeasurements: number;
  /** Total money actually moved this run — accumulated the moment `chargeStorage` succeeds, never gated on the watermark advance that follows it. */
  totalCostDollars: number;
}

export async function reconcileSandboxStorage(
  deps: ReconcileSandboxStorageDeps,
): Promise<ReconcileSandboxStorageResult> {
  const sessions = await deps.listAgentSessionSprites();
  const now = deps.now();

  let charged = 0;
  let skipped = 0;
  let failed = 0;
  let chargedButUnadvanced = 0;
  let staleMeasurements = 0;
  let totalCostDollars = 0;

  for (const session of sessions) {
    const subject: StorageSubject = { workspaceId: session.workspaceId, driveId: session.driveId, ownerId: session.ownerId };
    // The billing target this filesystem attributes to — the DRIVE's owner
    // when the session has one, OR, for a global-assistant session, the
    // session's own `ownerId` directly (see `storageBillingTarget`'s doc —
    // the one place this fork exists).
    const target = storageBillingTarget(subject);
    const attributionDriveId = 'driveId' in target ? target.driveId : undefined;

    // Everything up to (but NOT including) the charge itself: pure accrual
    // computation plus the owner lookup. A throw anywhere in here means
    // nothing was billed, so it counts as `failed` exactly like before.
    let resolved: { ownerId: string; costDollars: number; gbMonths: number } | undefined;
    try {
      const elapsedMs = now.getTime() - session.storageLastBilledAt.getTime();
      const lastMeasuredGB = session.measuredBytes === null ? null : bytesToGB(session.measuredBytes);
      const awake = now.getTime() - session.lastActiveAt.getTime() < RECENTLY_ACTIVE_MS;
      const { gb, stale } = pickBillableGB({ lastMeasuredGB, lastMeasuredAt: session.measuredAt, awake, now });
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
      // on a tiny measured footprint, a session that later grows to (say) 100GB
      // and is re-measured would be billed 100GB across the entire frozen span,
      // charging the payer for storage they did not hold. Losing a sub-cent
      // residual is negligible; retroactively over-charging is not.
      //
      // A back-to-back rerun (elapsedMs === 0) advances nothing, a pure no-op.
      if (costDollars <= 0) {
        if (elapsedMs > 0) {
          await deps.advanceAgentSessionWatermark({ workspaceId: session.workspaceId, billedThrough: now });
        }
        continue;
      }

      // `ownerId` in the target means a session with no drive at all, so only
      // the drive-lookup branch can leave this unresolved.
      //
      // Deliberately NOT the charge-time fallback (billing/sandbox-payer.ts
      // falls back to the session owner when the lookup fails, which is right
      // at CHARGE time — someone must pay for compute already consumed — and
      // wrong here). A failed lookup during a storage sweep usually means a
      // stale read of a drive mid-delete; billing it to an owner who may not
      // be the drive owner would be a misattributed money movement we cannot
      // take back, whereas skipping costs one cycle of accrual and
      // self-corrects on the next tick.
      const ownerId =
        'ownerId' in target ? target.ownerId : await deps.lookupDriveOwnerId(target.driveId);
      if (!ownerId) {
        // Can't resolve who to bill (e.g. the page/drive vanished). Leave the
        // watermark untouched so this window keeps accruing until it either
        // resolves on a later run or the session row itself is torn down.
        skipped += 1;
        continue;
      }

      resolved = { ownerId, costDollars, gbMonths };
    } catch (error) {
      failed += 1;
      loggers.ai.error(
        'Sandbox storage reconcile failed for session',
        error instanceof Error ? error : new Error(String(error)),
        { driveId: attributionDriveId, workspaceId: session.workspaceId },
      );
      continue;
    }
    if (!resolved) continue;

    // The charge itself — isolated from the watermark advance below so the
    // two outcomes ("nothing was billed" vs "billed, but the watermark write
    // failed") are never conflated. Real money moves the moment this
    // resolves, so `charged`/`totalCostDollars` reflect it immediately,
    // regardless of what happens next.
    try {
      await deps.chargeStorage({
        payerId: resolved.ownerId,
        driveId: attributionDriveId,
        workspaceId: session.workspaceId,
        costDollars: resolved.costDollars,
        gbMonths: resolved.gbMonths,
      });
    } catch (error) {
      // Isolated per-row: one session's charge failure must not drop every
      // other session in this run from being billed. Nothing was moved, so
      // this is a genuine failure — the accrual is retried next run.
      failed += 1;
      loggers.ai.error(
        'Sandbox storage reconcile: chargeStorage failed for session',
        error instanceof Error ? error : new Error(String(error)),
        { driveId: attributionDriveId, workspaceId: session.workspaceId },
      );
      continue;
    }
    totalCostDollars += resolved.costDollars;
    charged += 1;

    try {
      await deps.advanceAgentSessionWatermark({ workspaceId: session.workspaceId, billedThrough: now });
    } catch (error) {
      // The charge already committed (counted above) — only the watermark
      // write failed, so this row's window WILL be billed again on the next
      // run (see module doc on the double-bill risk). Distinguishable from a
      // real charge failure: `chargedButUnadvanced`, not `failed`.
      chargedButUnadvanced += 1;
      loggers.ai.error(
        'Sandbox storage reconcile: watermark advance failed after a successful charge — this window will be re-billed next run',
        error instanceof Error ? error : new Error(String(error)),
        { driveId: attributionDriveId, workspaceId: session.workspaceId },
      );
    }
  }

  return { processed: sessions.length, charged, skipped, failed, chargedButUnadvanced, staleMeasurements, totalCostDollars };
}
