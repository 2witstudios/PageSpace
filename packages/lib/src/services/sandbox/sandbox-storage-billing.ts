/**
 * Default (real) IO composition for the storage reconcile cron (Sprites
 * Platform Alignment 6-1) — binds `reconcileSandboxStorage`'s deps seam to its
 * TWO row sources (`agent_workspaces` and `drive_envs`) and the credit
 * pipeline. Reads the last PERSISTED measured bytes (never the provisioned cap,
 * never waking a sprite).
 *
 * **Envs are a row source here, not a meter of their own.** A drive environment
 * is the billed persistence unit, and it is billed through this same
 * composition: same cron, same advisory lock, same credit pipeline, one extra
 * SELECT and one extra watermark UPDATE. The only place the two units diverge
 * is the payer — an env resolves to its DRIVE OWNER with no fallback
 * (`resolveEnvPayerId`), because `drive_envs` has no owner column to fall back
 * to. Nothing here names a substrate: an env that later runs on a bigger guest,
 * a GPU host or a non-Fly platform bills through these exact lines.
 *
 * Narrowed by the Phase 8 teardown: this used to also enumerate FOUR
 * machine-tree row sources (a Machine's own Sprite, every live branch
 * Sprite, every promoted project Sprite, every per-session agent-terminal
 * Sprite) and exposed the opportunistic per-op storage-measurement writers
 * for them (`measureMachineStorageOpportunistically` and its three siblings).
 * Those tables and those writers are gone.
 *
 * **Where the measurements come from now.** This module only ever READS
 * `storageMeasuredBytes`; something else has to write it, and without a writer
 * every session bills its empty-disk baseline forever while the watermark
 * advances over whatever it actually wrote. Three writers exist:
 *
 *  - the provisioner's `measureSessionStorage`, on `create` — a baseline
 *    against a disk that is empty by definition, so useful only as a floor;
 *  - `measureStorage` on the bash path, fired from `release` AFTER the op;
 *  - the same seam on the git path, likewise post-op — the one that matters
 *    most, since `git_clone` is the largest writer in the system.
 *
 * All three are throttled per session and best-effort: a billing observation
 * must never wake a paused Sprite, delay a tool call, or fail one.
 *
 * An ENV's measurements come from the same seam, bound at its own provisioner:
 * `buildEnvProvisionDeps` (apps/web `drive-envs-runtime.ts`) supplies
 * `measureStorage`, so a freshly-provisioned env is measured while its Sprite is
 * still awake. Without it an env would bill the never-measured 0 floor forever
 * while this cron kept advancing its watermark.
 */

import { eq, and, isNotNull, isNull, sql } from '@pagespace/db/operators';
import { db, getAdvisoryLockPool } from '@pagespace/db/db';
import { withAdvisoryLock, type AdvisoryLockPool } from '@pagespace/db/advisory-lock';
import { agentWorkspaces } from '@pagespace/db/schema/agent-workspaces';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { lookupDriveOwnerId } from '../../billing/sandbox-payer';
import { MACHINE_MARKUP_BPS } from '../../billing/credit-pricing';
import { AIMonitoring } from '../../monitoring/ai-monitoring';
import {
  reconcileSandboxStorage,
  type ReconcileSandboxStorageDeps,
  type ReconcileSandboxStorageResult,
} from './sandbox-storage-reconcile';

/**
 * Read a watermark write's outcome off the value the UPDATE returned.
 *
 * ONE statement answers all three cases, which is why the monotonicity lives in
 * `GREATEST` rather than in a `WHERE ... <= ...` predicate. A predicate would
 * have collapsed "the guard declined" and "the row is gone" into the same empty
 * result — and since envs meter ~$0 today, a deleted env is by far the likelier
 * of the two, so an operator would have been told a generation boundary cut a
 * billing window when nothing of the sort happened.
 *
 *  - no row back → `row_gone`: the row was deleted mid-tick (a drive delete
 *    cascades its envs). Ordinary, and nothing to report.
 *  - the value we asked for → `advanced`: the window closed as planned.
 *  - a LATER value → `superseded`: a provision reset this row's watermark past
 *    this tick's `now` while the tick ran, and `GREATEST` correctly kept it.
 */
function classifyWatermarkWrite(
  written: Date | null | undefined,
  billedThrough: Date,
): 'advanced' | 'superseded' | 'row_gone' {
  if (!written) return 'row_gone';
  return written.getTime() > billedThrough.getTime() ? 'superseded' : 'advanced';
}

export const defaultReconcileSandboxStorageDeps: ReconcileSandboxStorageDeps = {
  async listAgentSessionSprites() {
    const rows = await db
      .select({
        workspaceId: agentWorkspaces.id,
        driveId: agentWorkspaces.driveId,
        ownerId: agentWorkspaces.ownerId,
        storageLastBilledAt: agentWorkspaces.storageLastBilledAt,
        measuredBytes: agentWorkspaces.storageMeasuredBytes,
        measuredAt: agentWorkspaces.storageMeasuredAt,
        lastActiveAt: agentWorkspaces.lastActiveAt,
      })
      .from(agentWorkspaces)
      .where(and(isNotNull(agentWorkspaces.sandboxId), isNull(agentWorkspaces.spriteTornDownAt)));
    // `lastActiveAt` is nullable on `agent_workspaces` ("reported only, never
    // acted on") — a row that has never recorded activity falls back to the
    // epoch, the honest-conservative "not awake" reading.
    return rows.map((row) => ({ ...row, lastActiveAt: row.lastActiveAt ?? new Date(0) }));
  },

  /**
   * The ENV row source — the same "still believed live" predicate, against the
   * partial index `drive_envs_live_sprite_idx` exists for. Never-provisioned
   * envs (`sandboxId` null) fall outside it and cost nothing to skip: an env row
   * with no machine holds no filesystem, so there is nothing to meter.
   */
  async listDriveEnvSprites() {
    const rows = await db
      .select({
        envId: driveEnvs.id,
        driveId: driveEnvs.driveId,
        storageLastBilledAt: driveEnvs.storageLastBilledAt,
        measuredBytes: driveEnvs.storageMeasuredBytes,
        measuredAt: driveEnvs.storageMeasuredAt,
        lastActiveAt: driveEnvs.lastActiveAt,
      })
      .from(driveEnvs)
      .where(and(isNotNull(driveEnvs.sandboxId), isNull(driveEnvs.spriteTornDownAt)));
    // `lastActiveAt` is nullable on `drive_envs` too ("reported, never acted on"
    // — an env is persistent, so idleness must not destroy it). Same
    // honest-conservative epoch fallback: reads as "not awake" for the staleness
    // flag only, never for billing.
    return rows.map((row) => ({ ...row, lastActiveAt: row.lastActiveAt ?? new Date(0) }));
  },

  lookupDriveOwnerId,

  /**
   * NOTE ON FAILURE: this cannot report one. `AIMonitoring.trackUsage` returns
   * `Promise<void>` and swallows its own errors into a
   * `'AI usage tracking failed — spend may be UNBILLED'` log rather than
   * rejecting, so a credit-ledger outage looks identical to a successful charge
   * from here — the reconcile counts it as `charged`, advances the watermark, and
   * the window is closed for good. That swallow is deliberate upstream (a throw
   * there would break user-facing generation), so it is not this PR's to undo;
   * the consequence is documented on `ReconcileSandboxStorageResult.charged` and
   * tracked in issue #2444.
   */
  async chargeStorage({ payerId, driveId, subjectKind, subjectId, costDollars, gbMonths }) {
    await AIMonitoring.trackUsage({
      userId: payerId,
      provider: 'sprites',
      // The billed unit, named in the meter line itself. Sessions keep the
      // string they have always written (renaming it would split one meter's
      // history across two labels in every existing usage breakdown); envs get
      // their own. Neither string names a substrate — an env that moves to a
      // bigger guest, a GPU host or another platform keeps billing under this
      // same label.
      //
      // What this label does NOT yet do is separate the two in the usage
      // breakdown's per-agent section: that view buckets every `source:
      // 'terminal'` row by `pageId`, and an env has none, so env storage lands
      // in the same "Unattributed agent" line as global-assistant session
      // storage. Only the by-model view distinguishes them today. Ratified as
      // acceptable for this slice; envs get their own breakdown section as a
      // binding requirement on the Environments UI task.
      model: subjectKind === 'env' ? 'drive-env-storage' : 'terminal-machine-storage',
      // One feature bucket for both: this is sandbox persistence either way, and
      // splitting the source would fragment the usage breakdown's totals.
      source: 'terminal',
      // No pageId: a session is a drive-level workspace, not page-anchored, so
      // there is no page to group its storage under. `trackUsage` treats a
      // missing pageId as unattributed-to-a-page, not an error.
      pageId: undefined,
      // First-class drive/session attribution (Terminal Epic 3 usage-breakdown
      // fix) — top-level columns the breakdown can group/filter on directly,
      // not just freeform metadata forensics. `driveId` undefined for a
      // global-assistant session (mirrors `pageId`'s "unattributed" reading).
      driveId,
      // `AIUsageData.sessionId` is the shared analytics column (`monitoring.session_id`),
      // written by many sources — out of this rename's scope, so map at the
      // boundary. Carries the `drive_envs` id for an env row; `model` above is
      // what says which table the id addresses.
      sessionId: subjectId,
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
      metadata: { type: subjectKind === 'env' ? 'env_storage' : 'terminal_storage', gbMonths },
    });
  },

  // The `agent_workspaces` Sprite's OWN watermark — directly on the row itself:
  // the design's "per-row watermark" made literal, no separate tracking
  // table.
  //
  // MONOTONIC, and that guard is load-bearing rather than defensive.
  // `billedThrough` is the ONE `now` the whole tick captured, and a tick makes
  // several awaits per row, so it can span minutes. A provision landing inside
  // that window resets the row's watermark FORWARD to its own provision time
  // (`revivedAgentSessionColumns`/`revivedDriveEnvColumns` — a new Sprite
  // generation is a fresh disk, so the old window must not be billed against
  // it). An unguarded UPDATE would then drag the watermark BACKWARDS over that
  // reset, and the span between them is billed a second time on the next tick —
  // exactly the double-bill the module doc otherwise reserves for a crash
  // between the charge and the advance. `GREATEST` in the SET makes a newer
  // reset win — deliberately NOT a `WHERE ... <= ...` predicate, which would
  // collapse "the guard declined" and "the row is gone" into the same empty
  // result (see `classifyWatermarkWrite`).
  //
  // Losing the write is the safe direction: the row already claims to be billed
  // further ahead than this tick reached, so at worst one tick-duration of the
  // DEAD generation's window goes unbilled.
  async advanceAgentSessionWatermark({ workspaceId, billedThrough }) {
    const [row] = await db
      .update(agentWorkspaces)
      .set({ storageLastBilledAt: sql`GREATEST(${agentWorkspaces.storageLastBilledAt}, ${sql.param(billedThrough, agentWorkspaces.storageLastBilledAt)})` })
      .where(eq(agentWorkspaces.id, workspaceId))
      .returning({ storageLastBilledAt: agentWorkspaces.storageLastBilledAt });
    return classifyWatermarkWrite(row?.storageLastBilledAt, billedThrough);
  },

  // The env row's OWN watermark, same literal per-row design and the same
  // monotonic guard — envs need it more, since `rebuildDriveEnv` is a verb a
  // user can invoke at any moment, including the middle of a reconcile tick.
  //
  // Deliberately NOT guarded on the Sprite pointers, though: the charge it
  // follows has already happened, so refusing the advance because the env was
  // torn down mid-run would re-bill that window on the next tick.
  async advanceDriveEnvWatermark({ envId, billedThrough }) {
    const [row] = await db
      .update(driveEnvs)
      .set({ storageLastBilledAt: sql`GREATEST(${driveEnvs.storageLastBilledAt}, ${sql.param(billedThrough, driveEnvs.storageLastBilledAt)})` })
      .where(eq(driveEnvs.id, envId))
      .returning({ storageLastBilledAt: driveEnvs.storageLastBilledAt });
    return classifyWatermarkWrite(row?.storageLastBilledAt, billedThrough);
  },

  now: () => new Date(),
};

/**
 * Advisory-lock key for serializing `reconcileSandboxStorage` across EVERY
 * caller — a second web/worker container, or a manual/API trigger, can run
 * the cron route concurrently with no shared state to stop it. The crontab
 * flock (Sprites Platform Alignment, #2032) only guards one container's own
 * scheduled ticks; it does nothing for a second container or an out-of-band
 * invocation. `chargeStorage` and `advanceAgentSessionWatermark` are two
 * separate un-transactioned writes (see sandbox-storage-reconcile.ts's module
 * doc), so two overlapping runs can double-bill the same watermark window.
 * This lock makes every caller overlap-safe, in addition to (not instead of)
 * the flock. Acquired via `withAdvisoryLock` on `getAdvisoryLockPool()`'s
 * dedicated pool — see that pool's doc in `@pagespace/db/db` for why it must
 * stay separate from the main `db` pool `deps` below queries against.
 *
 * The literal value is UNCHANGED from the pre-Phase-8 key (still
 * `reconcile-machine-storage`, not `reconcile-sandbox-storage`) — it is a
 * Postgres advisory-lock name shared across a rolling deploy, and changing it
 * would let an old-code and new-code container run the reconcile
 * concurrently against each other for the length of the rollout.
 */
const RECONCILE_SANDBOX_STORAGE_LOCK_KEY = 'reconcile-machine-storage';

export type ReconcileSandboxStorageRunResult =
  | { outcome: 'lock_busy' }
  | ({ outcome: 'reconciled' } & ReconcileSandboxStorageResult);

/**
 * Serializes `reconcileSandboxStorage` with a Postgres session-level advisory
 * try-lock (see `withAdvisoryLock`): a run that cannot acquire it (another
 * run — any process, any container — already holds it) is a clean no-op and
 * never touches `deps.listAgentSessionSprites`/`chargeStorage`/`advanceAgentSessionWatermark`.
 */
export async function reconcileSandboxStorageSerialized(
  deps: ReconcileSandboxStorageDeps,
  pgPool: AdvisoryLockPool = getAdvisoryLockPool(),
): Promise<ReconcileSandboxStorageRunResult> {
  const locked = await withAdvisoryLock(pgPool, RECONCILE_SANDBOX_STORAGE_LOCK_KEY, () =>
    reconcileSandboxStorage(deps),
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
    // (`reconcileSandboxStorage`) already documents that it never throws — including
    // its row-source LISTs, which `listSource` isolates — so there is
    // no such ambiguity here, and the choice to keep propagating is now explicit at the
    // type level rather than implicit in an uncaught rejection.
    throw locked.error;
  }
  return { outcome: 'reconciled', ...locked.result };
}
