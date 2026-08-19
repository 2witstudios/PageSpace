/**
 * Storage reconcile (Sprites Platform Alignment 6-1) — periodically meters the
 * cost of a PERSISTENT filesystem, whether its sandbox is active or
 * hibernating. TWO row sources, ONE meter: an agent session
 * (`agent_workspaces`) and a drive ENVIRONMENT (`drive_envs`). The platform bills for the bytes actually
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
 *
 * **Widened again by drive environments — deliberately as a row source, not as
 * a meter.** An env is the platform's billed PERSISTENCE unit: a drive-owned
 * machine that outlives every session run inside it, whose `drive_envs` storage
 * columns were defined column-for-column against `agent_workspaces` precisely so
 * this one reconcile could read both. So envs join here, under the SAME cron,
 * the SAME advisory lock and the SAME credit pipeline — no second meter and no
 * second schedule, because a second one would be a second place for a
 * double-bill to hide.
 *
 * The metering loop below is written against a normalized
 * `BillableStorageSubject`, never against a table, and its vocabulary is
 * deliberately substrate-agnostic: what is billed is an environment's (or a
 * session's) persisted footprint over elapsed time. Env guest sizes, GPU
 * classes and non-Fly substrates are all PROVISIONING facts — when they arrive
 * they attach as another billed attribute of the environment, and none of them
 * may change what this file charges for or how a payer is resolved.
 *
 * Envs differ from sessions in exactly one billing-relevant way, and it is a
 * structural one: an env has NO owner column to fall back to (`createdBy` is
 * audit only), so its payer is the drive owner or nobody — see
 * `resolveEnvPayerId`, and the skip-on-unresolvable rule below.
 *
 * **`reconcileSandboxStorage` NEVER THROWS**, and `reconcileSandboxStorageSerialized`
 * relies on that to tell an advisory-lock connection error apart from a failure
 * of the work itself. Every per-row failure is already isolated in its own
 * try/catch; folding in a second row source made the LIST calls the last
 * remaining escape hatch, and `listSource` closes it — before this, a throw from
 * `listAgentSessionSprites` propagated out of here and blurred exactly that
 * distinction.
 *
 * **Coverage, stated honestly.** The "never wake to measure" rule means this
 * bills what real-work wakes have persisted, and an env's only writer today is
 * its provision-time baseline (`env-storage-measure.ts`) — env-bound sessions,
 * which are what would refresh it, are a follow-up. So envs currently meter
 * near-zero by construction, and that is a coverage gap rather than a pricing
 * one: the payer, the attribution, the watermark and the idempotence are all
 * exercised, and the number they multiply is small until the warm path lands.
 * `neverMeasured` counts live rows in exactly that state, so the gap is a metric
 * an operator can watch rather than a silence — and because this loop advances
 * the watermark for a 0-floor row anyway, a measurement that never lands is
 * discarded rather than deferred. Retrying a failed baseline is issue #2443.
 */

import { calculateMachineStorageCostDollars } from '../../monitoring/machine-pricing';
import { resolveEnvPayerId } from '../../billing/sandbox-payer';
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

/**
 * A drive ENVIRONMENT's own Sprite — the second row source, and the one the
 * platform actually sells persistence as.
 *
 * Shape-identical to {@link AgentSessionStorageRow} save for the payer columns,
 * because `drive_envs`' storage columns were defined column-for-column against
 * `agent_workspaces` precisely so ONE reconcile could read both. Two differences,
 * both structural rather than incidental:
 *
 *  - `driveId` is NOT nullable. An env has no user-scoped form (there is no
 *    "global assistant env"), so there is no `ownerId` branch and no payer of
 *    last resort — see `resolveEnvPayerId`.
 *  - there is no `ownerId` at all. `drive_envs.createdBy` is AUDIT ONLY and is
 *    deliberately not read here.
 *
 * Nothing in this shape names a substrate. An env's guest size, its GPU-ness or
 * the platform it runs on are provisioning facts; what is billed is the
 * ENVIRONMENT's persisted footprint over elapsed time, so a future size/class
 * attribute joins this row as another billed attribute rather than as a new
 * meter. Rows without a live Sprite (`sandboxId` null) or torn down are expected
 * to be filtered out by the row source, not billed at 0 here.
 */
export interface DriveEnvStorageRow {
  /** The `drive_envs` row's own id. Where THIS Sprite's measurement/watermark are persisted. */
  envId: string;
  /** The owning drive — NOT NULL, and the ONLY route to a payer. */
  driveId: string;
  storageLastBilledAt: Date;
  /** Last opportunistically-measured used bytes on the ENV Sprite; null when never measured. */
  measuredBytes: number | null;
  /** When `measuredBytes` was captured; null when never measured. */
  measuredAt: Date | null;
  /** The env's last real-work activity (`drive_envs.lastActiveAt`, null-coalesced by the row source). Used solely for the staleness health flag, never for billing — an env is persistent, so idleness never affects it. */
  lastActiveAt: Date;
}

/** WHICH kind of row a charge is for. The meter is one; the persistence units it meters are two. */
export type StorageSubjectKind = 'session' | 'env';

export interface ReconcileSandboxStorageDeps {
  /**
   * Every LIVE `agent_workspaces` Sprite to meter. Never wakes a sprite: reads
   * persisted measurements only.
   */
  listAgentSessionSprites: () => Promise<AgentSessionStorageRow[]>;
  /**
   * Every LIVE `drive_envs` Sprite to meter — the same read, against the second
   * row source. Never wakes a sprite.
   */
  listDriveEnvSprites: () => Promise<DriveEnvStorageRow[]>;
  /**
   * Resolves a drive's ownerId; null when it can't be resolved (e.g. a stale
   * read of a drive mid-delete). Used for every env row, and for a session
   * subject whose `driveId` is set — the session `driveId === null` case
   * bypasses this entirely (see `storageBillingTarget`, whose `{ ownerId }`
   * branch is already resolved, pure data with no IO needed).
   */
  lookupDriveOwnerId: (driveId: string) => Promise<string | null>;
  /**
   * Charges the payer for this subject's accrued storage cost. Not hold-gated —
   * a background reconcile charge, mirroring reconcile-ai-cost. `driveId` is
   * omitted only for a global-assistant agent-session (no drive to attribute
   * usage-breakdown to); an env always has one.
   *
   * `subjectKind`/`subjectId` deliberately name the BILLED UNIT rather than a
   * table: one meter, two persistence units, and no substrate anywhere in the
   * vocabulary.
   */
  chargeStorage: (input: {
    payerId: string;
    driveId?: string;
    subjectKind: StorageSubjectKind;
    /** The `agent_workspaces` id or the `drive_envs` id, per `subjectKind`. */
    subjectId: string;
    costDollars: number;
    gbMonths: number;
  }) => Promise<void>;
  /** Persists the new watermark for an `agent_workspaces` Sprite, on the ROW ITSELF — the per-row watermark the design calls for, no separate tracking table needed. */
  advanceAgentSessionWatermark: (input: { workspaceId: string; billedThrough: Date }) => Promise<void>;
  /** The same per-row watermark write, against `drive_envs`. */
  advanceDriveEnvWatermark: (input: { envId: string; billedThrough: Date }) => Promise<void>;
  now: () => Date;
}

export interface ReconcileSandboxStorageResult {
  processed: number;
  /** Rows where `chargeStorage` SUCCEEDED — the money moved, regardless of whether the watermark then advanced. Always reflected in `totalCostDollars`. */
  charged: number;
  /** Rows with a positive accrual whose owner could not be resolved — left unbilled (watermark untouched) for a future run to retry. */
  skipped: number;
  /**
   * Rows where NOTHING was billed because something threw before or during the
   * charge — the payer lookup, the accrual computation, `chargeStorage` itself,
   * or (on a row whose window prices to $0) its watermark advance, which sits in
   * the same guarded block. Isolated per row so one bad row doesn't abort the batch.
   *
   * Distinct from {@link ReconcileSandboxStorageResult.chargedButUnadvanced},
   * which means the opposite: money DID move and only the watermark write
   * failed. Worth knowing which way round for envs in particular, since they
   * meter near-zero today and therefore take the $0 branch on almost every tick.
   */
  failed: number;
  /**
   * Rows where `chargeStorage` succeeded but the FOLLOWING watermark advance
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
   * aren't being refreshed by real-work wakes.
   *
   * Excludes never-measured rows, which bill 0 and are counted by
   * {@link ReconcileSandboxStorageResult.neverMeasured} instead. Unrelated to
   * `skipped`, which is about an unresolvable payer, not a missing measurement.
   */
  staleMeasurements: number;
  /**
   * LIVE rows with no measurement at all, billing the 0 floor while their
   * watermark advances — storage the platform is holding and not charging for.
   *
   * Separated from `staleMeasurements` because it is the more serious signal and
   * the stale count structurally cannot contain it (a row with no reading cannot
   * have an ageing one). It matters most for ENVS: a session has three
   * measurement writers, so a dropped one self-corrects on the next real work,
   * whereas an env's baseline is written once at provision and a single failed
   * `du` there leaves the row NULL with nothing to retry it. A count that stays
   * above zero across ticks means exactly that has happened.
   */
  neverMeasured: number;
  /**
   * The same two measurement signals, split by persistence unit — and the split
   * is what makes them readable at all once envs exist.
   *
   * An env's ONLY measurement writer is its provision-time baseline, and its
   * only `lastActiveAt` writer is that same provision, so 24h after it is
   * created every live env reads as not-awake with an ageing measurement, and
   * `staleMeasurements` saturates at the env count by construction. Reported
   * flat, that would drown the signal it exists for: an operator could no longer
   * tell a genuine SESSION-side measurement outage from the expected env
   * baseline. Split, each unit's number means what it always meant, and the env
   * column stops being alarming once the warm path starts refreshing it.
   */
  measurementHealth: Record<StorageSubjectKind, { live: number; neverMeasured: number; stale: number }>;
  /**
   * Row sources whose LIST threw this tick — their rows were not metered at all
   * (not skipped, not billed: unread). Their accrual is untouched and is caught
   * up in full on the next tick. Named rather than counted so an operator can
   * see WHICH persistence unit went unbilled.
   */
  failedSources: StorageSubjectKind[];
  /** Total money actually moved this run — accumulated the moment `chargeStorage` succeeds, never gated on the watermark advance that follows it. */
  totalCostDollars: number;
}

/**
 * One row of either source, normalized to what the metering loop below actually
 * needs: an accrual window, a measurement, a payer resolution, and a watermark
 * write. The loop is written against THIS and never against a table, which is
 * what makes "sessions and envs are two persistence units on one meter" true in
 * the code rather than only in the doc — a third unit is another adapter, not
 * another loop.
 */
interface BillableStorageSubject {
  kind: StorageSubjectKind;
  /** The owning row's id — logged, and passed to `chargeStorage` as `subjectId`. */
  subjectId: string;
  /** The drive this charge attributes to in the usage breakdown; undefined for a global-assistant session. */
  attributionDriveId: string | undefined;
  /** Who to bill; null means UNRESOLVABLE — the caller skips the cycle rather than substituting a payer. */
  resolvePayerId: () => Promise<string | null>;
  advanceWatermark: (billedThrough: Date) => Promise<void>;
  storageLastBilledAt: Date;
  measuredBytes: number | null;
  measuredAt: Date | null;
  lastActiveAt: Date;
}

function toSessionSubject(
  session: AgentSessionStorageRow,
  deps: ReconcileSandboxStorageDeps,
): BillableStorageSubject {
  const subject: StorageSubject = { workspaceId: session.workspaceId, driveId: session.driveId, ownerId: session.ownerId };
  // The billing target this filesystem attributes to — the DRIVE's owner
  // when the session has one, OR, for a global-assistant session, the
  // session's own `ownerId` directly (see `storageBillingTarget`'s doc —
  // the one place this fork exists).
  const target = storageBillingTarget(subject);
  return {
    kind: 'session',
    subjectId: session.workspaceId,
    attributionDriveId: 'driveId' in target ? target.driveId : undefined,
    // `ownerId` in the target means a session with no drive at all, so only
    // the drive-lookup branch can leave this unresolved.
    resolvePayerId: async () =>
      'ownerId' in target ? target.ownerId : await deps.lookupDriveOwnerId(target.driveId),
    advanceWatermark: (billedThrough) =>
      deps.advanceAgentSessionWatermark({ workspaceId: session.workspaceId, billedThrough }),
    storageLastBilledAt: session.storageLastBilledAt,
    measuredBytes: session.measuredBytes,
    measuredAt: session.measuredAt,
    lastActiveAt: session.lastActiveAt,
  };
}

function toEnvSubject(env: DriveEnvStorageRow, deps: ReconcileSandboxStorageDeps): BillableStorageSubject {
  return {
    kind: 'env',
    subjectId: env.envId,
    // Always attributed: an env's `driveId` is NOT NULL.
    attributionDriveId: env.driveId,
    // The drive owner, with NO fallback — an env has no owner column to fall
    // back to, and inventing one would bill a machine to somebody who does not
    // own it. See `resolveEnvPayerId`.
    // `lookupDriveOwnerId` is wrapped, not passed unbound: `resolveEnvPayerId`
    // invokes it off its own input object, so handing over the bare reference
    // would drop `this` for any deps implementation that is a real object rather
    // than a literal — billing every session correctly while every env threw and
    // counted as `failed`, every tick. The session arm above keeps `this` for
    // free by calling it as a method; this arm has to say so.
    resolvePayerId: () =>
      resolveEnvPayerId({
        driveId: env.driveId,
        lookupDriveOwnerId: (driveId) => deps.lookupDriveOwnerId(driveId),
      }),
    advanceWatermark: (billedThrough) => deps.advanceDriveEnvWatermark({ envId: env.envId, billedThrough }),
    storageLastBilledAt: env.storageLastBilledAt,
    measuredBytes: env.measuredBytes,
    measuredAt: env.measuredAt,
    lastActiveAt: env.lastActiveAt,
  };
}

/**
 * Read one row source, converting a LIST failure into an empty tick for THAT
 * source alone.
 *
 * Deliberately isolated rather than fatal. The two sources share a meter but no
 * invariant: every row carries its own watermark, so billing sessions while
 * `drive_envs` is unreadable is not a half-run, it is a correct run over the
 * rows that could be read — the unread ones accrue and are caught up in full on
 * the next tick, exactly as a row skipped for an unresolvable payer is. Letting
 * an env-side read error abort the tick would instead stop SESSION billing,
 * which folding envs in must never do: this PR adds a row source, and a row
 * source must not be able to take the existing meter down with it.
 *
 * Named in the result (`failedSources`) and logged, because a source that is
 * silently contributing nothing looks exactly like a source with no rows.
 */
async function listSource<T>(
  kind: StorageSubjectKind,
  load: () => Promise<T[]>,
): Promise<{ rows: T[]; failed: boolean }> {
  try {
    return { rows: await load(), failed: false };
  } catch (error) {
    loggers.ai.error(
      `Sandbox storage reconcile: could not list the ${kind} row source — its rows are unmetered this tick and accrue for the next`,
      error instanceof Error ? error : new Error(String(error)),
      { subjectKind: kind },
    );
    return { rows: [], failed: true };
  }
}

export async function reconcileSandboxStorage(
  deps: ReconcileSandboxStorageDeps,
): Promise<ReconcileSandboxStorageResult> {
  // Both sources are read BEFORE any charging (so the whole tick is planned
  // from one consistent-enough snapshot), but they are read INDEPENDENTLY —
  // see `listSource` for why one source's failure must not stop the other's
  // money.
  const [sessions, envs] = await Promise.all([
    // Called through a closure, not passed unbound: a deps implementation is
    // free to be a real object whose row source reads `this`, and an unbound
    // reference would break it in a way only production would show.
    listSource('session', () => deps.listAgentSessionSprites()),
    listSource('env', () => deps.listDriveEnvSprites()),
  ]);
  const subjects: BillableStorageSubject[] = [
    ...sessions.rows.map((session) => toSessionSubject(session, deps)),
    ...envs.rows.map((env) => toEnvSubject(env, deps)),
  ];
  const failedSources: StorageSubjectKind[] = [];
  if (sessions.failed) failedSources.push('session');
  if (envs.failed) failedSources.push('env');
  const now = deps.now();

  let charged = 0;
  let skipped = 0;
  let failed = 0;
  let chargedButUnadvanced = 0;
  let staleMeasurements = 0;
  let neverMeasured = 0;
  let totalCostDollars = 0;
  const measurementHealth: Record<StorageSubjectKind, { live: number; neverMeasured: number; stale: number }> = {
    session: { live: 0, neverMeasured: 0, stale: 0 },
    env: { live: 0, neverMeasured: 0, stale: 0 },
  };

  for (const subject of subjects) {
    const attributionDriveId = subject.attributionDriveId;

    // Everything up to (but NOT including) the charge itself: pure accrual
    // computation plus the owner lookup. A throw anywhere in here means
    // nothing was billed, so it counts as `failed` exactly like before.
    let resolved: { ownerId: string; costDollars: number; gbMonths: number } | undefined;
    try {
      const elapsedMs = now.getTime() - subject.storageLastBilledAt.getTime();
      const lastMeasuredGB = subject.measuredBytes === null ? null : bytesToGB(subject.measuredBytes);
      const awake = now.getTime() - subject.lastActiveAt.getTime() < RECENTLY_ACTIVE_MS;
      const { gb, stale } = pickBillableGB({ lastMeasuredGB, lastMeasuredAt: subject.measuredAt, awake, now });
      // Two DISTINCT health signals, and conflating them would hide the worse
      // one. `staleMeasurements` is measured-but-ageing — a footprint we know,
      // billing on an old reading. `neverMeasured` is a live row with NO reading
      // at all, billing the 0 floor while its watermark advances: not stale in
      // the refresh sense, and therefore invisible in the stale count, which is
      // precisely why it needs its own.
      const health = measurementHealth[subject.kind];
      health.live += 1;
      if (lastMeasuredGB === null) {
        neverMeasured += 1;
        health.neverMeasured += 1;
      } else if (stale) {
        staleMeasurements += 1;
        health.stale += 1;
      }
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
      // on a tiny measured footprint, a subject that later grows to (say) 100GB
      // and is re-measured would be billed 100GB across the entire frozen span,
      // charging the payer for storage they did not hold. Losing a sub-cent
      // residual is negligible; retroactively over-charging is not.
      //
      // A back-to-back rerun (elapsedMs === 0) advances nothing, a pure no-op.
      if (costDollars <= 0) {
        if (elapsedMs > 0) {
          await subject.advanceWatermark(now);
        }
        continue;
      }

      // Deliberately NOT the charge-time fallback (billing/sandbox-payer.ts's
      // `resolveSessionPayerId` falls back to the session owner when the lookup
      // fails, which is right at CHARGE time — someone must pay for compute
      // already consumed — and wrong here). A failed lookup during a storage
      // sweep usually means a stale read of a drive mid-delete; billing it to an
      // owner who may not be the drive owner would be a misattributed money
      // movement we cannot take back, whereas skipping costs one cycle of
      // accrual and self-corrects on the next tick. For an ENV there is not even
      // a fallback available (`resolveEnvPayerId`) — the skip is the only
      // honest answer.
      const ownerId = await subject.resolvePayerId();
      if (!ownerId) {
        // Can't resolve who to bill (e.g. the drive vanished). Leave the
        // watermark untouched so this window keeps accruing until it either
        // resolves on a later run or the row itself is torn down/deleted.
        skipped += 1;
        continue;
      }

      resolved = { ownerId, costDollars, gbMonths };
    } catch (error) {
      failed += 1;
      loggers.ai.error(
        'Sandbox storage reconcile failed for subject',
        error instanceof Error ? error : new Error(String(error)),
        { driveId: attributionDriveId, subjectKind: subject.kind, subjectId: subject.subjectId },
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
        subjectKind: subject.kind,
        subjectId: subject.subjectId,
        costDollars: resolved.costDollars,
        gbMonths: resolved.gbMonths,
      });
    } catch (error) {
      // Isolated per-row: one subject's charge failure must not drop every
      // other subject in this run from being billed. Nothing was moved, so
      // this is a genuine failure — the accrual is retried next run.
      failed += 1;
      loggers.ai.error(
        'Sandbox storage reconcile: chargeStorage failed for subject',
        error instanceof Error ? error : new Error(String(error)),
        { driveId: attributionDriveId, subjectKind: subject.kind, subjectId: subject.subjectId },
      );
      continue;
    }
    totalCostDollars += resolved.costDollars;
    charged += 1;

    try {
      await subject.advanceWatermark(now);
    } catch (error) {
      // The charge already committed (counted above) — only the watermark
      // write failed, so this row's window WILL be billed again on the next
      // run (see module doc on the double-bill risk). Distinguishable from a
      // real charge failure: `chargedButUnadvanced`, not `failed`.
      chargedButUnadvanced += 1;
      loggers.ai.error(
        'Sandbox storage reconcile: watermark advance failed after a successful charge — this window will be re-billed next run',
        error instanceof Error ? error : new Error(String(error)),
        { driveId: attributionDriveId, subjectKind: subject.kind, subjectId: subject.subjectId },
      );
    }
  }

  return {
    processed: subjects.length,
    charged,
    skipped,
    failed,
    chargedButUnadvanced,
    staleMeasurements,
    neverMeasured,
    measurementHealth,
    failedSources,
    totalCostDollars,
  };
}
