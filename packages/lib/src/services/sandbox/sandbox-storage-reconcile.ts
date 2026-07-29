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
 * `agent_sessions` Sprite — one per tier of the deleted Machine page type's
 * tree, ADDED alongside the `agent_sessions` source in Phase 7 while the
 * machine-tree tables still existed. Only `agent_sessions` survives (the
 * other four's tables are dropped): its attribution target may be a page
 * (`agentPageId` set) OR the session's own `ownerId` directly (a
 * global-assistant session, `agentPageId` null — there is no page to group
 * its usage under). `storageBillingTarget` (`sandbox-storage-attribution.ts`)
 * is the one place that branches on this for ATTRIBUTION; `resolveAgentSessionPayerId` in the
 * deps seam resolves the payer for the `ownerId` case with no page lookup at
 * all — mirroring `billing/sandbox-payer.ts`'s function of the same name,
 * which the real IO composition (`sandbox-storage-billing.ts`) delegates to
 * directly so the nullable-payer fallback is written exactly once.
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
 * An `agent_sessions` row's own Sprite. Rows without a live Sprite
 * (`sandboxId` null) or torn down are expected to be filtered out by the row
 * source, not billed at 0 here.
 */
export interface AgentSessionStorageRow {
  /** The `agent_sessions` row's PK — ≡ sessionId ≡ conversationId. Where THIS Sprite's measurement/watermark are persisted. */
  sessionId: string;
  /** The session's backing agent page; null for a global-assistant session (see `storageBillingTarget`). */
  agentPageId: string | null;
  /** The session's own owner — the payer of last resort, and the ONLY payer when `agentPageId` is null. */
  ownerId: string;
  storageLastBilledAt: Date;
  /** Last opportunistically-measured used bytes on the SESSION Sprite; null when never measured. */
  measuredBytes: number | null;
  /** When `measuredBytes` was captured; null when never measured. */
  measuredAt: Date | null;
  /** The session's own last real-work activity — `agent_sessions.lastActiveAt` is a first-class column, no join needed. Used solely for the staleness health flag, never for billing. */
  lastActiveAt: Date;
}

export interface ReconcileSandboxStorageDeps {
  /**
   * Every LIVE `agent_sessions` Sprite to meter. Never wakes a sprite: reads
   * persisted measurements only.
   */
  listAgentSessionSprites: () => Promise<AgentSessionStorageRow[]>;
  /**
   * Resolves a page's owning drive's ownerId; null when it can't be resolved
   * (e.g. an orphaned row). Used only for an `agent-session` subject whose
   * `agentPageId` is set — the `agentPageId === null` case bypasses this
   * entirely (see `storageBillingTarget`, whose `{ ownerId }` branch is
   * already resolved, pure data with no IO needed).
   */
  lookupPageOwnerId: (pageId: string) => Promise<string | null>;
  /** Charges the payer for this session's accrued storage cost. Not hold-gated — a background reconcile charge, mirroring reconcile-ai-cost. `pageId` is omitted for a global-assistant agent-session (no page to attribute usage-breakdown to). */
  chargeStorage: (input: { payerId: string; pageId?: string; costDollars: number; gbMonths: number }) => Promise<void>;
  /** Persists the new watermark for an `agent_sessions` Sprite, on the ROW ITSELF — the per-row watermark the design calls for, no separate tracking table needed. */
  advanceAgentSessionWatermark: (input: { sessionId: string; billedThrough: Date }) => Promise<void>;
  now: () => Date;
}

export interface ReconcileSandboxStorageResult {
  processed: number;
  charged: number;
  /** Rows with a positive accrual whose owner could not be resolved — left unbilled (watermark untouched) for a future run to retry. */
  skipped: number;
  /** Rows where `chargeStorage`/`advanceWatermark` threw — isolated so one bad row doesn't abort the batch; see module doc on the residual double-bill risk this leaves for a future run to retry. */
  failed: number;
  /**
   * Rows billed from a MEASURED footprint whose measurement is older than
   * {@link STALE_MEASUREMENT_MS} while the sandbox is not currently awake —
   * the cron bills the last value regardless (it never wakes a sprite), so
   * this is a health signal: a persistently-high count means measurements
   * aren't being refreshed by real-work wakes. Excludes never-measured rows
   * (see `skipped` is unrelated; never-measured simply bill 0).
   */
  staleMeasurements: number;
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
  let staleMeasurements = 0;
  let totalCostDollars = 0;

  for (const session of sessions) {
    const subject: StorageSubject = { sessionId: session.sessionId, agentPageId: session.agentPageId, ownerId: session.ownerId };
    // The billing target this filesystem attributes to — `agentPageId` when
    // set, OR, for a global-assistant session, the session's own `ownerId`
    // directly (see `storageBillingTarget`'s doc — the one place this fork
    // exists).
    const target = storageBillingTarget(subject);
    const attributionPageId = 'pageId' in target ? target.pageId : undefined;
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
          await deps.advanceAgentSessionWatermark({ sessionId: session.sessionId, billedThrough: now });
        }
        continue;
      }

      // `ownerId` in the target means an agent-session with no page at all, so
      // only the page-lookup branch can leave this unresolved.
      //
      // Deliberately NOT `resolveAgentSessionPayerId` (billing/sandbox-payer.ts),
      // even though the two agree on every other input: that function falls back
      // to the session owner when the page lookup fails, which is right at CHARGE
      // time (someone must pay for compute already consumed) and wrong here. A
      // failed lookup during a storage sweep usually means a stale read of a page
      // mid-delete; billing it to an owner who may not be the drive owner would
      // be a misattributed money movement we cannot take back, whereas skipping
      // costs one cycle of accrual and self-corrects on the next tick.
      const ownerId =
        'ownerId' in target ? target.ownerId : await deps.lookupPageOwnerId(target.pageId);
      if (!ownerId) {
        // Can't resolve who to bill (e.g. the page/drive vanished). Leave the
        // watermark untouched so this window keeps accruing until it either
        // resolves on a later run or the session row itself is torn down.
        skipped += 1;
        continue;
      }

      await deps.chargeStorage({ payerId: ownerId, pageId: attributionPageId, costDollars, gbMonths });
      await deps.advanceAgentSessionWatermark({ sessionId: session.sessionId, billedThrough: now });
      totalCostDollars += costDollars;
      charged += 1;
    } catch (error) {
      // Isolated per-row: one session's charge/advance failure must not drop
      // every other session in this run from being billed. Left unresolved: if
      // chargeStorage already committed before advanceWatermark threw, this
      // row's window bills again next run (see module doc).
      failed += 1;
      loggers.ai.error(
        'Sandbox storage reconcile failed for session',
        error instanceof Error ? error : new Error(String(error)),
        { pageId: attributionPageId, sessionId: session.sessionId },
      );
    }
  }

  return { processed: sessions.length, charged, skipped, failed, staleMeasurements, totalCostDollars };
}
