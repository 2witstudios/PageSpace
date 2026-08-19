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

import { loggers } from '../../logging/logger-config';
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
  getDriveEnvLimit,
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
  store: Pick<DriveEnvStore, 'createIfUnderLimit' | 'countEnvsOwnedBy'>;
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
 *
 * **The ceiling is enforced TWICE, and the second one is the real one.** The
 * allowance check below is an advisory pre-check: it reads a count and produces
 * the right denial vocabulary (`tier_ineligible` vs `env_limit_reached`) without
 * a write. It is also racy on its own — two admins creating differently-named
 * envs for one payer at the ceiling both read "under", and `(driveId, name)`
 * uniqueness does not serialize different names. So the count-and-insert is
 * repeated inside `createIfUnderLimit` under a per-payer advisory lock, which is
 * what actually holds the line. This is the same two-layer shape the session
 * spawn ceiling uses (an advisory pre-check at the route, a structural
 * count-and-insert in the store), for the same reason: the pre-check exists to
 * give a good answer, the structural check exists to be correct.
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

  const created = await deps.store.createIfUnderLimit({
    driveId,
    name,
    createdBy,
    now: deps.now(),
    payerId: payer.payerId,
    maxEnvs: getDriveEnvLimit(payer.tier),
  });
  if (!created.ok) {
    if (created.reason === 'name_taken') return { ok: false, reason: 'name_taken' };
    // Lost the structural race the pre-check above could not see. Reported as
    // the SAME refusal the pre-check would have produced, because it is the
    // same fact — the payer is at their ceiling — learned a moment later.
    return {
      ok: false,
      reason: 'quota_exceeded',
      denial: 'env_limit_reached',
      limit: getDriveEnvLimit(payer.tier),
    };
  }
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
 * so that a process dying mid-teardown leaves a durable record of the INTENT.
 * The confirmation stamp goes on afterwards under a CAS on the INSTANCE, because
 * a concurrent provision may have put a LIVE replacement into this row, and
 * marking that one torn down would hide a billing VM from every pointer there is.
 *
 * **This is the REBUILD path only.** `deleteDriveEnv` does not come through
 * here: it kills after the row is gone, where there is no row to stamp and the
 * reclaim outbox is the record. Rebuild by definition keeps the row, so it is
 * the one caller that still needs intent-before-kill.
 *
 * **What recovers a failed kill here, and the one gap in it.** `drive_envs` is a
 * row source of `reconcileOrphanSprites`, enumerated on exactly the predicate
 * this function leaves behind — a teardown intent stamped, no confirmation, a
 * sandbox still pointed at — so an env whose kill failed is normally retried on
 * the next tick under the same instance-CAS guard a session gets, rather than
 * waiting for a person to press rebuild again.
 *
 * That retry licence is `teardownRequestedAt`, and **a concurrent `ensure` can
 * clear it**: a resume verdict's stamps reset the teardown request as part of
 * recording that the holder is live again (`plan-workspace-lifecycle.ts`, the
 * `resume` arm). So the sequence "kill fails ⇒ somebody opens a shell in the env
 * ⇒ the resume clears the intent" leaves a VM this process knows it failed to
 * kill with nothing enumerating it: the row reads live, and it IS live, so no
 * source claims it. It stops being an orphan and becomes an env whose machine
 * was never actually replaced — wrong for a rebuild, but not leaked, and the
 * next rebuild kills it.
 *
 * Not closed here on purpose: re-stamping the intent after a failed kill would
 * race the very resume that cleared it, and stamping a teardown intent onto a
 * row a user is actively working in is how you get the reconciler to destroy a
 * live filesystem — the one mistake this whole subsystem is built to avoid. The
 * honest mitigation is the ERROR below, which surfaces the failed kill at the
 * moment it happens rather than relying on a cron to notice later.
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
      // A real failure: the VM may still be running, and it bills until
      // something kills it. LOGGED here rather than only returned, because the
      // cron retry that would otherwise cover this can have its licence cleared
      // by a concurrent ensure (see the doc above) — so this line is the one
      // signal guaranteed to be emitted at the moment the kill fails.
      loggers.ai.error(
        'Drive environment sprite teardown failed; env row keeps its teardown intent',
        error instanceof Error ? error : new Error(String(error)),
        { envId, sandboxId },
      );
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
  /**
   * No teardown stamps here, unlike `RebuildDriveEnvDeps`: this verb kills the
   * Sprite AFTER the row is gone, so there is no row left to stamp an intent or
   * a confirmation onto. The reclaim outbox holds that record instead.
   */
  store: Pick<DriveEnvStore, 'findById' | 'countLiveSessionsInEnv' | 'deleteIfUnoccupied'>;
  host: SandboxHost;
  now: () => Date;
}

export type DeleteDriveEnvResult =
  | { ok: true; spriteTornDown: boolean }
  | { ok: false; reason: 'not_found' }
  /** Sessions are still live in here and `force` was not given. Nothing was touched. */
  | { ok: false; reason: 'live_sessions'; liveSessionCount: number };

/**
 * Delete an environment — the destructive verb, and the only one that takes a
 * shared filesystem with it.
 *
 * The flow, in the order the invariants require:
 *
 *  1. **Guard, cheaply.** Refuse while sessions are live inside the env, unless
 *     `force`. This read is deliberately NOT the authoritative guard — it is the
 *     one that refuses without taking a lock, which is what makes the common
 *     case cost nothing.
 *  2. **Delete, atomically guarded.** `deleteIfUnoccupied` repeats the count
 *     inside one transaction holding `FOR UPDATE` on the env row, and THAT is
 *     the guard that decides: a session cannot bind between the count and the
 *     delete, because binding needs an FK lock on the row this transaction
 *     holds. The cascade then removes bound sessions (and their panes, rev
 *     counters and shells).
 *  3. **Kill, once nothing can be harmed by it.** Only after the row is gone.
 *
 * **The kill comes LAST, and the order is the whole safety property.** It used
 * to come second — kill, then delete under the lock — and that was wrong in a
 * way the refusal disguised: a session binding between the unlocked count and
 * the kill had the environment's machine destroyed under it, and then the
 * authoritative re-count refused the delete and told the caller the delete had
 * FAILED. Nothing was deleted, so the failure read as "nothing happened" — but
 * the shared filesystem was already gone, and an env's entire contract with its
 * users is that the files stay put. Killing after the delete cannot reach a
 * live session at all: once the row is gone no session is bound to it and none
 * can become bound (the FK has nothing to point at), so by construction there
 * is nobody left to harm.
 *
 * **What happens to a kill that fails now.** The row is already gone, so this
 * function cannot hold the pointer for a retry — the reclaim outbox does,
 * which is precisely what it exists for. The AFTER DELETE trigger fires
 * `WHEN sandboxId IS NOT NULL AND spriteTornDownAt IS NULL` — true for exactly
 * the rows whose Sprite we are about to kill — and parks the pointer inside the
 * deleting transaction. So the pointer OUTLIVES the row unconditionally, and
 * `reconcileOrphanSprites` drains the outbox with a retry that never gives up
 * and an attempt count that makes a stuck VM visible. The kill here is an
 * OPTIMISATION on that: it reclaims promptly in the overwhelming common case,
 * and when it fails the cron finishes the job. `killSprite` is idempotent, so
 * the cron re-killing a VM this call already destroyed is a no-op that then
 * releases the outbox row.
 *
 * This is the one place the reclaim outbox is load-bearing rather than a crash
 * net, and that is a deliberate trade: a lingering VM costs money until the next
 * cron tick, a destroyed filesystem costs someone their work.
 *
 * The cascade cannot strand a VM: an env-bound session is CHECK-forbidden from
 * holding Sprite pointers (`agent_workspaces_env_no_sprite_check`), so the only
 * machine in play is the env's own. That is also why `force` does not need to
 * end sessions one by one first — there is nothing in a session row for an
 * orderly end to release.
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

  // Step 1. Cheap and non-authoritative — see the docblock. Its only job is to
  // refuse the common "you have sessions open in here" case without taking a
  // lock. It is safe for this read to be stale in EITHER direction now: nothing
  // is destroyed until step 2, which re-decides under the lock.
  const liveSessionCount = await deps.store.countLiveSessionsInEnv(envId);
  const plan = planEnvDelete({ row, liveSessionCount, force });

  if (plan.action === 'deny_live_sessions') {
    return { ok: false, reason: 'live_sessions', liveSessionCount: plan.liveSessionCount };
  }

  // Step 2. THE guard. A refusal here means nothing was touched — which is now
  // literally true, where before it meant "nothing was deleted, but the machine
  // is already gone".
  const deleted = await deps.store.deleteIfUnoccupied({ envId, force });
  if (!deleted.ok) {
    // `not_found`: a concurrent delete removed the row first. The env is gone
    // either way, which is what the caller asked for — but say so honestly
    // rather than claim this call is what killed the Sprite.
    if (deleted.reason === 'not_found') return { ok: false, reason: 'not_found' };
    // `live_sessions`: a session bound between step 1 and the lock. Refusing
    // costs that session nothing at all; cascading it away would cost someone
    // their work.
    return { ok: false, reason: 'live_sessions', liveSessionCount: deleted.liveSessionCount };
  }

  // Step 3. The row is gone and the AFTER DELETE trigger has already parked this
  // pointer in the reclaim outbox, so the VM is guaranteed to be reclaimed with
  // or without us. Kill it now anyway: promptness is worth a network call, and
  // failure here costs a cron tick rather than a leak.
  if (plan.action !== 'teardown_then_delete') return { ok: true, spriteTornDown: false };
  const spriteTornDown = await killDeletedEnvSprite({
    envId,
    sandboxId: plan.sandboxId,
    expectedInstanceId: plan.expectedInstanceId,
    deps,
  });
  return { ok: true, spriteTornDown };
}

/**
 * Best-effort kill of the Sprite belonging to an env row that has ALREADY been
 * deleted. Never throws, and never reports a failure to the caller, because by
 * this point there is no failure the caller could act on: the env is gone (which
 * is what they asked for) and the outbox owns the retry.
 *
 * Returns whether the kill was CONFIRMED — reported to the caller as
 * `spriteTornDown` and audited, so "did this request also stop the machine"
 * stays an honest answer rather than an assumed one.
 *
 * `expectedInstanceId` is load-bearing exactly as it is on every other kill
 * path: the name is reused across re-creates, so an unqualified "destroy
 * whatever holds this name" could destroy a replacement that legitimately took
 * it. A `SandboxSpriteReplacedError` therefore means our target is already gone
 * — nothing to do, and NOT a confirmation, because the outbox row must go on
 * chasing whatever is alive under that name now.
 */
async function killDeletedEnvSprite({
  envId,
  sandboxId,
  expectedInstanceId,
  deps,
}: {
  envId: string;
  sandboxId: string;
  expectedInstanceId: string | null;
  deps: Pick<DeleteDriveEnvDeps, 'host'>;
}): Promise<boolean> {
  try {
    await deps.host.kill({ sandboxId, expectedInstanceId });
    return true;
  } catch (error) {
    if (error instanceof SandboxSpriteReplacedError) return false;
    // Logged, not swallowed silently: the outbox will retry forever, but a kill
    // that fails is still the signal that something is wrong with the substrate,
    // and a VM that keeps refusing to die bills the whole time.
    loggers.ai.error(
      'Drive environment sprite kill failed after the row was deleted; reclaim outbox will retry',
      error instanceof Error ? error : new Error(String(error)),
      { envId, sandboxId },
    );
    return false;
  }
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
    // `stamped: false` means the confirmation CAS refused: a concurrent
    // provision put a LIVE replacement on this row while we were killing the
    // old VM. For a DELETE that is survivable (the row goes and the AFTER
    // DELETE trigger reclaims the replacement) — for a REBUILD it is not.
    // Continuing would re-read a row pointing at a live machine, resume it, and
    // report `rebuilt: true` over a filesystem this call never destroyed, which
    // is precisely the lie the kill-before-provision ordering exists to
    // prevent. Abort and let the caller retry against the current machine.
    if (!teardown.stamped) {
      return { ok: false, reason: 'teardown_failed', detail: 'teardown_not_confirmed' };
    }
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
