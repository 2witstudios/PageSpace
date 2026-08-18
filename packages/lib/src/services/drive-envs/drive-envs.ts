/**
 * Drive environments: create / list / rename / delete / rebuild (IO, dependency-injected).
 *
 * The lifecycle orchestration around `drive_envs`, split from the store
 * (`drive-envs-store.ts`) and from Sprite provisioning
 * (`agent-workspace-sprite.ts`) because the three answer different questions:
 * this module is about the ENV — does it exist, may it be created, what does a
 * client see, what has to die before its row may go — while those are about the
 * table and the VM.
 *
 * **This module owns two decisions and delegates the rest.** Whether a delete
 * may proceed is `planEnvDelete`'s (pure); whether a Sprite must be created,
 * resumed or killed is `planSpriteHolderLifecycle`'s (pure, and shared with
 * sessions — an env is a Sprite HOLDER, not a second kind of provisioner). What
 * is left here is executing those verdicts in the right order against IO that
 * can crash between any two steps.
 *
 * **`rebuildDriveEnv` is the ONLY verb that replaces an env's Sprite**, and that
 * exclusivity is the point rather than a convention. A Sprite name is
 * deterministic in the env's id, and `SandboxHost.provision` auto-resumes "same
 * name, same filesystem" — which is exactly what makes an env persistent, and
 * exactly why re-provisioning WITHOUT a confirmed kill first would hand back the
 * same disk while telling the user it was rebuilt. So rebuild is teardown ⇒
 * ensure, in that order, under the SAME envId: same address, same name, fresh
 * filesystem. Nothing else in the system is allowed to swap an env's machine,
 * because an env's whole contract with its users is that the files stay put.
 */

import type { SandboxHost } from '../sandbox/sandbox-host';
import { SandboxSpriteReplacedError } from '../sandbox/sandbox-host';
import {
  planSpriteHolderLifecycle,
  type SpriteHolderLifecycleRow,
} from '../../agent-workspaces/plan-workspace-lifecycle';
import { planEnvDelete } from '../../drive-envs/plan-env-delete';
import type { DriveEnvDTO, DriveEnvStatus } from '../../drive-envs/env-contract';
import {
  checkDriveEnvAllowance,
  type DriveEnvAllowanceDenialReason,
} from '../sandbox/quota';
import type { SubscriptionTier } from '../subscription-utils';
import type { EnsureSpriteHolderSandboxResult } from '../agent-workspaces/agent-workspace-sprite';
import type { DriveEnvRecord, DriveEnvStore } from './drive-envs-store';

/**
 * Row → `DriveEnvStatus`, as a pure function (the ONE place the mapping exists)
 * — the env twin of `deriveSandboxStatus`.
 *
 * Two columns, checked in this order:
 *
 *  - `spriteTornDownAt` FIRST, because a torn-down env KEEPS the `sandboxId` of
 *    the Sprite it used to own (that pointer is what a reclaim needs), so
 *    testing for a sandbox first would report a destroyed VM as running. This is
 *    the same trap `workspace-status.ts` documents, and it bites identically here.
 *  - `sandboxId` — a Sprite is linked, INCLUDING a hibernating one. Idle Sprites
 *    hibernate and wake on demand, which is invisible to the user, so it is not
 *    a status of its own.
 *
 * There is no `endedAt` to consult, and no `'ended'` to return: an env is never
 * ended, only deleted. A row that still exists is an environment that still
 * exists, whether or not it currently has a machine.
 */
export interface DriveEnvStatusColumns {
  sandboxId: string | null;
  spriteTornDownAt: Date | null;
}

export function deriveDriveEnvStatus(row: DriveEnvStatusColumns): DriveEnvStatus {
  if (row.spriteTornDownAt !== null) return 'stopped';
  if (row.sandboxId !== null) return 'running';
  return 'none';
}

/**
 * Project a stored row onto the wire DTO (pure).
 *
 * `Date` never crosses the boundary (ISO-8601 strings only), and no Sprite
 * pointer, egress token or storage measurement is projected at all — see
 * `env-contract.ts` for why the DTO is deliberately narrow.
 */
export function toDriveEnvDTO(row: DriveEnvRecord): DriveEnvDTO {
  return {
    id: row.id,
    driveId: row.driveId,
    name: row.name,
    status: deriveDriveEnvStatus(row),
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateDriveEnvDeps {
  store: Pick<DriveEnvStore, 'create' | 'countEnvsOwnedBy'>;
  /**
   * The drive's PAYER and their tier — the drive's OWNER, with no fallback.
   * `null` means the drive is gone, which fails the create closed rather than
   * metering the request against anybody else.
   */
  resolvePayer: (driveId: string) => Promise<{ payerId: string; tier: SubscriptionTier } | null>;
  now: () => Date;
}

export type CreateDriveEnvResult =
  | { ok: true; env: DriveEnvRecord }
  /** The drive does not exist (so there is no payer to meter, and no drive to own the env). */
  | { ok: false; reason: 'drive_not_found' }
  /** `(driveId, name)` is taken — the database refused, which is how concurrent creates are resolved. */
  | { ok: false; reason: 'name_taken' }
  /** The payer's tier forbids environments, or they are at their ceiling. `limit` is the ceiling that applied. */
  | { ok: false; reason: 'quota_exceeded'; denial: DriveEnvAllowanceDenialReason; limit: number };

/**
 * Create an environment: mint the row.
 *
 * Does NOT touch a Sprite — envs provision lazily, on the first session that
 * runs inside one — so creating an env is instant, and an env that nobody has
 * opened yet costs storage for nothing.
 *
 * **The quota is called HERE, not injected**, and that is deliberate. The row is
 * the billed persistence unit, so this function is the one moment the commitment
 * is made; a `checkQuota` dependency would be a gate a future caller could
 * supply as `async () => ({ allowed: true })` without any reviewer noticing.
 * What IS injected is the payer lookup, which is genuinely per-deployment IO.
 */
export async function createDriveEnv({
  driveId,
  name,
  createdBy,
  deps,
}: {
  driveId: string;
  /** Already validated and trimmed by `driveEnvNameSchema` at the boundary. */
  name: string;
  /** AUDIT ONLY: who asked. Never consulted for permission, payment or lifecycle. */
  createdBy: string | null;
  deps: CreateDriveEnvDeps;
}): Promise<CreateDriveEnvResult> {
  const payer = await deps.resolvePayer(driveId);
  if (!payer) return { ok: false, reason: 'drive_not_found' };

  const allowance = await checkDriveEnvAllowance({
    payerId: payer.payerId,
    tier: payer.tier,
    countEnvsOwnedBy: (payerId) => deps.store.countEnvsOwnedBy(payerId),
  });
  if (!allowance.allowed) {
    return { ok: false, reason: 'quota_exceeded', denial: allowance.reason, limit: allowance.limit };
  }

  const created = await deps.store.create({ driveId, name, createdBy, now: deps.now() });
  if (!created.ok) return { ok: false, reason: 'name_taken' };
  return { ok: true, env: created.env };
}

// ---------------------------------------------------------------------------
// List / rename
// ---------------------------------------------------------------------------

export interface ListDriveEnvsDeps {
  store: Pick<DriveEnvStore, 'list'>;
}

/**
 * The drive's environments, as DTOs.
 *
 * Access is NOT checked here: the caller has already established that this
 * requester may enumerate this drive (that is what naming the drive IS), exactly
 * as `listAgentSessions` treats its filter.
 */
export async function listDriveEnvs({
  driveId,
  deps,
}: {
  driveId: string;
  deps: ListDriveEnvsDeps;
}): Promise<DriveEnvDTO[]> {
  const rows = await deps.store.list(driveId);
  return rows.map(toDriveEnvDTO);
}

export interface RenameDriveEnvDeps {
  store: Pick<DriveEnvStore, 'rename'>;
  now: () => Date;
}

export type RenameDriveEnvResult =
  | { ok: true; env: DriveEnvRecord }
  | { ok: false; reason: 'not_found' | 'name_taken' };

/**
 * Rename an environment.
 *
 * A rename MOVES AN ADDRESS: `(driveId, name)` is unique because pipelines and
 * people target an env by name ("promote to staging"), so renaming is a
 * deliberate admin act and a collision is refused rather than resolved. Nothing
 * else moves — the id, the Sprite key folded from it, and therefore the
 * filesystem are all untouched.
 */
export async function renameDriveEnv({
  envId,
  name,
  deps,
}: {
  envId: string;
  /** Already validated and trimmed by `driveEnvNameSchema` at the boundary. */
  name: string;
  deps: RenameDriveEnvDeps;
}): Promise<RenameDriveEnvResult> {
  const renamed = await deps.store.rename({ envId, name, now: deps.now() });
  if (!renamed.ok) return { ok: false, reason: renamed.reason };
  return { ok: true, env: renamed.env };
}

// ---------------------------------------------------------------------------
// The shared teardown step (delete and rebuild both need it)
// ---------------------------------------------------------------------------

/** The env row, in the shape the shared lifecycle planner decides on. */
function toLifecycleRow(row: DriveEnvRecord): SpriteHolderLifecycleRow {
  return {
    holderId: row.id,
    spriteKey: row.spriteKey,
    sandboxId: row.sandboxId,
    spriteInstanceId: row.spriteInstanceId,
    egressPolicyToken: row.egressPolicyToken,
    teardownRequestedAt: row.teardownRequestedAt,
    spriteTornDownAt: row.spriteTornDownAt,
    // An env has no `endedAt` column and no ended state — it is deleted, never
    // ended. Pinned null so the shared planner reads the row exactly as it is
    // rather than inferring a session-shaped lifecycle the env does not have.
    endedAt: null,
    lastActiveAt: row.lastActiveAt,
  };
}

interface TeardownEnvSpriteDeps {
  store: Pick<DriveEnvStore, 'requestTeardown' | 'stampSpriteTornDown'>;
  host: SandboxHost;
  now: () => Date;
}

type TeardownEnvSpriteResult =
  /** The Sprite is gone. `stamped` is false when a concurrent provision won the CAS — see below. */
  | { ok: true; stamped: boolean }
  | { ok: false; detail: string };

/**
 * Kill an env's Sprite: intent first, kill second, confirmation third.
 *
 * The order is the crash contract, and it is the same one `endAgentSession`
 * follows for the same reason. `teardownRequestedAt` is written BEFORE the kill
 * so that a process dying mid-teardown still leaves the VM reclaimable — the
 * orphan reconciler requires that stamp before it destroys anything. The
 * confirmation stamp goes on afterwards under a CAS on the INSTANCE, because a
 * concurrent provision may have put a LIVE replacement into this row, and
 * marking that one torn down would hide a billing VM from the reconciler forever.
 */
async function teardownEnvSprite({
  envId,
  sandboxId,
  expectedInstanceId,
  row,
  deps,
}: {
  envId: string;
  sandboxId: string;
  expectedInstanceId: string | null;
  row: DriveEnvRecord;
  deps: TeardownEnvSpriteDeps;
}): Promise<TeardownEnvSpriteResult> {
  const now = deps.now();
  // WHICH columns a confirmed teardown stamps stays the shared planner's
  // decision, not this module's: an env is a Sprite holder, and "what does
  // killing a holder's VM record" is precisely the question that planner
  // answers for both holder kinds. (Its `endedAt` stamp is dropped by
  // `envStampColumns` — `drive_envs` has no such column.)
  const plan = planSpriteHolderLifecycle({
    row: toLifecycleRow(row),
    intent: 'end',
    // Ignored for `end`: the planner decides cleanup BEFORE the authorization
    // gate, because releasing compute must never be blocked by losing access to
    // it. Passing `true` documents that this path deliberately does not gate.
    canRun: true,
    now,
  });
  // Not a teardown verdict means the row does not believe it holds a live
  // Sprite — it was torn down between this caller's read and the planner's
  // reading of it. Nothing to kill and nothing to stamp: inventing stamps here
  // would write a confirmation this call never confirmed.
  if (plan.action !== 'teardown') return { ok: true, stamped: false };
  const stamps = plan.stamps;

  await deps.store.requestTeardown({ envId, sandboxId, spriteInstanceId: expectedInstanceId, at: now });

  try {
    await deps.host.kill({ sandboxId, expectedInstanceId });
  } catch (error) {
    // A DIFFERENT VM holds this name now, so the one we targeted is already gone
    // — confirmed enough to stamp (the CAS below still refuses if the row has
    // moved on to that replacement).
    if (!(error instanceof SandboxSpriteReplacedError)) {
      // A real failure: the VM may still be running. The row keeps its teardown
      // request, so the orphan reconciler retries — which is why this is
      // reported rather than swallowed, and why the caller must NOT go on to
      // delete the row: deleting it would hand the reclaim job to the AFTER
      // DELETE trigger while we still believe the kill is retryable here.
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  const stamped = await deps.store.stampSpriteTornDown({ envId, sandboxId, spriteInstanceId: expectedInstanceId, stamps });
  return { ok: true, stamped };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export interface DeleteDriveEnvDeps {
  store: Pick<
    DriveEnvStore,
    'findById' | 'countLiveSessionsInEnv' | 'requestTeardown' | 'stampSpriteTornDown' | 'deleteById'
  >;
  host: SandboxHost;
  now: () => Date;
}

export type DeleteDriveEnvResult =
  | { ok: true; spriteTornDown: boolean }
  | { ok: false; reason: 'not_found' }
  /** Sessions are still live in here and `force` was not given. Nothing was touched. */
  | { ok: false; reason: 'live_sessions'; liveSessionCount: number }
  | { ok: false; reason: 'teardown_failed'; detail: string };

/**
 * Delete an environment — the destructive verb, and the only one that takes a
 * shared filesystem with it.
 *
 * The flow, in the order the invariants require:
 *
 *  1. **Guard.** Refuse while sessions are live inside the env, unless `force`.
 *     This has to come first because the row delete CASCADES to those sessions:
 *     by the time the row is gone, the work someone was doing in it is gone too.
 *  2. **Teardown.** Kill the env's Sprite while the row still points at it, so
 *     the kill is confirmed by the caller that asked for it. A failed kill
 *     ABORTS the delete: the row keeps its teardown request and stays as the
 *     reconciler's handle on the VM.
 *  3. **Delete.** The row goes, and the cascade removes bound sessions (and
 *     their panes, rev counters and shells).
 *
 * The AFTER DELETE trigger is the crash net UNDER step 2, not a second copy of
 * it: it fires only `WHEN sandboxId IS NOT NULL AND spriteTornDownAt IS NULL` —
 * a row that still believes it holds a live Sprite. After a confirmed teardown
 * that predicate is false and nothing is enqueued, which is correct: an outbox
 * row for a dead name would have the reclaim cron chase it forever. What the
 * trigger DOES catch is the case step 2 cannot close by itself — a concurrent
 * provision put a live replacement on the row, the confirmation CAS rightly
 * refused, and the delete carries a machine nothing else would ever find.
 *
 * The cascade cannot strand a VM: an env-bound session is CHECK-forbidden from
 * holding Sprite pointers (`agent_workspaces_env_no_sprite_check`), so the only
 * machine in play is the env's own, which step 2 has already dealt with. That is
 * also why `force` does not need to end sessions one by one first — there is
 * nothing in a session row for an orderly end to release.
 */
export async function deleteDriveEnv({
  envId,
  force,
  deps,
}: {
  envId: string;
  /** Override the live-session guard. Nothing else in this flow consults it. */
  force: boolean;
  deps: DeleteDriveEnvDeps;
}): Promise<DeleteDriveEnvResult> {
  const row = await deps.store.findById(envId);
  if (!row) return { ok: false, reason: 'not_found' };

  const liveSessionCount = await deps.store.countLiveSessionsInEnv(envId);
  const plan = planEnvDelete({ row, liveSessionCount, force });

  if (plan.action === 'deny_live_sessions') {
    return { ok: false, reason: 'live_sessions', liveSessionCount: plan.liveSessionCount };
  }

  let spriteTornDown = false;
  if (plan.action === 'teardown_then_delete') {
    const teardown = await teardownEnvSprite({
      envId,
      sandboxId: plan.sandboxId,
      expectedInstanceId: plan.expectedInstanceId,
      row,
      deps,
    });
    // A kill we could not confirm must NOT be followed by a row delete: the row
    // is the reconciler's only handle on a VM it may still have to retry, and
    // the reclaim outbox is a net for crashes, not a substitute for a teardown
    // this process knows failed.
    if (!teardown.ok) return { ok: false, reason: 'teardown_failed', detail: teardown.detail };
    // `stamped: false` means the confirmation CAS refused — a concurrent
    // provision owns this row's pointer now. The delete still proceeds (the
    // caller asked for the env to be gone, and it is), and the replacement VM
    // is handed to the reclaim outbox by the AFTER DELETE trigger, which fires
    // precisely because the row still reads as live.
    spriteTornDown = teardown.stamped;
  }

  const deleted = await deps.store.deleteById(envId);
  // Losing this race means a concurrent delete removed the row first. The env is
  // gone either way, which is what the caller asked for — but say so honestly
  // rather than claim this call is what killed the Sprite.
  if (!deleted) return { ok: false, reason: 'not_found' };
  return { ok: true, spriteTornDown };
}

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

export interface RebuildDriveEnvDeps {
  store: Pick<DriveEnvStore, 'findById' | 'requestTeardown' | 'stampSpriteTornDown'>;
  host: SandboxHost;
  /**
   * Provision this env's Sprite — the app's binding of the holder-neutral
   * `ensureSpriteHolderSandbox` with the env's key derivation, authorization,
   * egress and quota deps.
   *
   * Injected rather than composed here for the reason
   * `agent-workspace-sprite.ts` gives about its own seams: every one of those
   * deps is deployment IO (a Sprite driver, a secret, a network policy), and a
   * service module that reached for them could not be tested without them.
   * Crucially this is `ensure`, not a second provisioning path — the CAS that
   * serializes concurrent provisions of one holder only works if every
   * provisioner runs the same one.
   */
  ensureSandbox: (row: DriveEnvRecord) => Promise<EnsureSpriteHolderSandboxResult>;
  now: () => Date;
}

export type RebuildDriveEnvResult =
  | { ok: true; sandboxId: string }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'teardown_failed'; detail: string }
  /** The old Sprite is gone but the new one could not be minted. The env survives, machineless, and the next ensure retries. */
  | { ok: false; reason: 'provision_failed'; detail: string };

/**
 * Rebuild an environment: destroy its machine and give it a fresh one, under the
 * SAME env id.
 *
 * The admin escape hatch for an env someone has broken from the inside — a wedged
 * daemon, a full disk, a dependency tree past saving. It is destructive by
 * design: the filesystem does not survive, which is precisely what the caller is
 * asking for, and is why this is an owner/admin verb rather than something a
 * session can trigger on its own behalf.
 *
 * **Teardown must be CONFIRMED before the re-provision**, and this is the one
 * place that ordering is subtle: Sprite names are deterministic in the env id, so
 * provisioning again without a confirmed kill resumes the SAME name and hands
 * back the SAME disk. The user would be told their environment was rebuilt while
 * looking at the files they asked to be rid of. So a failed kill aborts, and the
 * env keeps the machine it had.
 *
 * The window between the two steps is deliberately left open rather than locked:
 * an env whose Sprite is torn down and not yet replaced is an ORDINARY state
 * (`status: 'stopped'`), reachable by a reclaim just as easily as by a rebuild,
 * and the next ensure — this one or anyone's — provisions from it correctly.
 */
export async function rebuildDriveEnv({
  envId,
  deps,
}: {
  envId: string;
  deps: RebuildDriveEnvDeps;
}): Promise<RebuildDriveEnvResult> {
  const row = await deps.store.findById(envId);
  if (!row) return { ok: false, reason: 'not_found' };

  if (row.sandboxId !== null && row.spriteTornDownAt === null) {
    const teardown = await teardownEnvSprite({
      envId,
      sandboxId: row.sandboxId,
      expectedInstanceId: row.spriteInstanceId,
      row,
      deps,
    });
    if (!teardown.ok) return { ok: false, reason: 'teardown_failed', detail: teardown.detail };
  }

  // Re-read: the teardown just moved this row's stamps, and the provisioner
  // plans from the pointer columns. Handing it the pre-teardown snapshot would
  // ask it to decide against a Sprite that no longer exists.
  const fresh = await deps.store.findById(envId);
  if (!fresh) return { ok: false, reason: 'not_found' };

  const provisioned = await deps.ensureSandbox(fresh);
  if (!provisioned.ok) {
    return {
      ok: false,
      reason: 'provision_failed',
      detail: provisioned.detail ?? provisioned.denial ?? provisioned.reason,
    };
  }
  return { ok: true, sandboxId: provisioned.sandboxId };
}
