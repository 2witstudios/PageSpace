/**
 * Sprite provisioning for a SPRITE HOLDER (IO, dependency-injected) — the ONE
 * code path that gives a holder its sandbox.
 *
 * A **sprite holder** is any row that owns exactly one Sprite under a
 * deterministic name: an agent session (`agent_workspaces`) and a per-drive
 * environment (`drive_envs`). The provisioning core below knows nothing about
 * which — it is handed a store slice, a key-derivation function, an
 * authorization function and a quota check, and it runs the same
 * probe → plan → provision → CAS machinery over whatever they address.
 *
 * That "one path" is not a style preference: the CAS below only serializes
 * concurrent provisioners if every provisioner runs it. Two surfaces with two
 * copies of this logic would race each other into two live VMs under one holder,
 * and only one of them would ever be pointed at. This is exactly why a second
 * holder kind must be a set of DEPS rather than a second provisioner — an environment
 * with its own copy of this flow would be correct against itself and race
 * against nothing, right up until two sessions opened in one environment at once.
 * `ensureAgentSessionSandbox` is therefore a thin session-flavored wrapper, not
 * an alternative implementation: the web app and the realtime bridge keep
 * calling it, and it keeps calling the one core.
 *
 * **On the file's address.** A holder-neutral core under `agent-workspaces/` is a
 * deliberate stop, not an oversight. Moving it would rewrite the `@pagespace/lib`
 * exports map and both app-side import paths in the same change that generalizes
 * the logic, which is exactly the mix that makes a "no behavior change" claim
 * unreviewable. The move belongs with the second holder, where a reviewer can see
 * two callers justifying the new address.
 *
 * Ported from `services/machines/agent-terminal-sprites.ts`, with two structural
 * changes:
 *
 *  1. **ALL THREE scope-specific clone arms are gone.** The predecessor cloned a
 *     repo per scope (machine → nothing, project → `PROJECT_REPO_PATH`, branch →
 *     clone + checkout), which is what made git the information architecture. An
 *     agent-session sandbox starts EMPTY at `$HOME`; if the agent needs a repo it
 *     clones one with its git tools, inside the session, like any other piece of
 *     work. With the clones go `cloneAndCheckoutBranch`, `cloneRepoInto`, the
 *     project/branch lookups, the `clone_failed`/`clone_collision` outcomes and
 *     the dest-exists race they existed to survive.
 *  2. **`propagateClaudeCredential` is dropped entirely.** It copied a Claude
 *     Code login from the owning Machine's root Sprite — an anchor that no longer
 *     exists (a session has no parent VM), for a CLI that is not what a session's
 *     chat surface runs.
 *
 * What is kept, deliberately and unchanged in substance: provisioning under the
 * holder's derived Sprite key, the egress-enablement gate and the
 * `egressPolicyToken` proof round-trip, the identity CAS with its ABA guard, and
 * the reconcile-before-kill that stops a lost race from destroying the winner's
 * live VM (rescuing the pointer to the reclaim outbox when a cleanup kill cannot
 * be confirmed).
 *
 * **No lifecycle branches live here.** Whether a holder creates, resumes,
 * adopts or is denied is decided by `planSpriteHolderLifecycle`
 * (`agent-workspaces/plan-workspace-lifecycle.ts`); this module observes, asks, and
 * executes the verdict — including which columns the verdict says to stamp.
 */

import type { SandboxHandle, SandboxHost, SandboxSubstrateSpec } from '../sandbox/sandbox-host';
import { SandboxSpriteReplacedError } from '../sandbox/sandbox-host';
import type { SandboxCreateOptions } from '../sandbox/sandbox-options';
import type { FullEgressEnablement } from '../sandbox/containment';
import type { CanRunCodeInput, CanRunCodeResult } from '../sandbox/can-run-code';
import { deriveAgentSessionSpriteKey } from '../../agent-workspaces/workspace-sprite-key';
import {
  planSpriteHolderLifecycle,
  type SpriteHolderDenyReason,
  type SpriteHolderRowStamps,
  type LiveSpriteInstance,
  type SpriteHolderLifecycleRow,
} from '../../agent-workspaces/plan-workspace-lifecycle';
import type { AgentSessionRecord, AgentSessionStore } from './agent-workspaces-store';
import { loggers } from '../../logging/logger-config';

/**
 * The store slice the provisioner needs, addressed by HOLDER id — the identity
 * CAS, the stamp write, the pointer re-read, and the reclaim outbox. Deliberately
 * the whole surface and nothing more: a holder kind that cannot supply these four
 * cannot be provisioned, and one that supplies more does not get to use it here.
 *
 * It mirrors `AgentSessionStore`'s methods of the same names (see that module for
 * the CAS semantics each one owes); the session wrapper below is the adapter.
 */
export interface SpriteHolderStore {
  updateSpriteIdentity(input: {
    holderId: string;
    previousSandboxId: string | null;
    spriteKey: string;
    sandboxId: string;
    spriteInstanceId: string | null;
    egressPolicyToken: string | null;
    stamps: SpriteHolderRowStamps;
    now: Date;
  }): Promise<boolean>;
  applyStamps(input: {
    holderId: string;
    stamps: SpriteHolderRowStamps;
    cas?: { sandboxId?: string | null; endedAt?: Date | null };
  }): Promise<boolean>;
  reloadSpritePointer(holderId: string): Promise<{ sandboxId: string | null; spriteInstanceId: string | null } | null>;
  enqueueReclaim(input: { sandboxId: string; spriteInstanceId: string | null }): Promise<void>;
}

/** The actor a provision runs as. Only what the Sprite key and the authorization gate need — a session has no clone to audit and no git token to resolve. */
export interface AgentSessionActorContext {
  userId: string;
  tenantId: string;
}

/** The intents that can hand back a sandbox. `'end'` is not one of them — teardown lives in `agent-workspaces.ts`, and its verdict is unconditional on authorization. */
export type SpriteHolderProvisionIntent = 'ensure' | 'attach' | 'reprovision';

/**
 * Everything the holder-neutral core needs from the outside. Each dep is the
 * seam where a holder kind differs; nothing below this line branches on which
 * kind is being provisioned.
 */
export interface SpriteHolderProvisionDeps {
  /** The identity/stamp slice of the holder's store — this module never reads or writes anything else. */
  store: SpriteHolderStore;
  /** The provider-neutral Sprite lifecycle seam. */
  host: SandboxHost;
  substrate: SandboxSubstrateSpec;
  options: SandboxCreateOptions;
  /**
   * The holder's deterministic Sprite NAME. Injected rather than derived here
   * because the namespace is what keeps holder kinds from colliding: sessions
   * fold `agent-session-sprite:v2`, environments fold `drive-env-sprite:v1`, and a core
   * that picked for itself would be one `if` away from provisioning an environment onto a
   * session Sprite awaiting reclaim. Only consulted when the row carries no key.
   */
  deriveSpriteKey: (holderId: string) => string;
  /**
   * Authorization for the CURRENT actor against THIS holder, applied BEFORE any
   * Sprite is provisioned OR handed back. Must never throw (the centralized
   * checkers are fail-closed by construction). Its answer is passed to the
   * planner as `canRun` rather than acted on here, so that "re-authorize before
   * returning a warm holder" is a property of the planner, not a habit each call
   * site has to remember. `reason` is surfaced as the denial's `detail`.
   */
  authorize: () => Promise<{ ok: boolean; reason?: string }>;
  /** REQUIRED full-egress enablement gate — a holder's Sprite runs open egress. */
  checkFullEgressEnablement: () => Promise<FullEgressEnablement>;
  /**
   * REQUIRED allowance check, applied where a VM is actually MINTED. Required for
   * the same reason as the egress gate above: this is the one function every
   * first touch funnels through — web routes, the sandbox and session tools, AND
   * the realtime shell bridge, which calls this module directly rather than
   * through the web app's wrapper. A gate placed at any single call site would
   * leave the others free to provision past the tier ceiling, so it is a dep of
   * the shared provisioner and not optional: a future caller cannot forget what
   * it cannot omit.
   *
   * Returning `{ allowed: false }` refuses the provision; a resume is exempt (the
   * row's sandbox is already counted), which the quota module itself decides from
   * `alreadyProvisioned`.
   *
   * A refusal names BOTH halves of what the caller will see, because the core
   * deliberately holds no holder-specific wording:
   *
   *  - `denial` — the machine-readable reason, which surfaces on the result and
   *    which API routes switch on to choose a status code. Injected rather than
   *    assumed: a core that hardcoded `'session_limit_reached'` would label a
   *    environment's refusal a live-SESSION ceiling, mislabel it the same way in the
   *    security audit, and force this return statement back open the moment a
   *    second holder kind wanted its own word — the exact reopening this module
   *    exists to prevent.
   *  - `reason` — the human detail, passed straight through as the result's
   *    `detail`. No fallback here either; inventing user-facing copy for a holder
   *    kind the core knows nothing about is not the core's call.
   *
   * The session wrapper below is the worked example of both: it supplies
   * `'session_limit_reached'` and `SESSION_LIMIT_DETAIL`, so the wire value and
   * the audit payload are byte-for-byte what they were before this seam existed.
   */
  checkQuota: (input: { alreadyProvisioned: boolean }) => Promise<
    | { allowed: true }
    | { allowed: false; denial: SpriteHolderDenyReason; reason: string }
  >;
  /**
   * Optional opportunistic storage measurement. While the Sprite is ALREADY
   * awake right after a provision, capture its used bytes onto the holder's row so
   * the storage reconcile can bill them — without ever waking a hibernating
   * Sprite. Best-effort and fire-and-forget; omitting it disables measurement.
   */
  measureStorage?: (input: { holderId: string; handle: SandboxHandle }) => Promise<void>;
  now: () => Date;
}

export interface AgentSessionSpriteDeps {
  /** Only the identity/stamp slice of the session store — this module never reads or writes anything else. */
  store: Pick<AgentSessionStore, 'updateSpriteIdentity' | 'applyStamps' | 'reloadSpritePointer' | 'enqueueReclaim'>;
  /** The provider-neutral Sprite lifecycle seam. */
  host: SandboxHost;
  substrate: SandboxSubstrateSpec;
  options: SandboxCreateOptions;
  /** Server-held `SANDBOX_SESSION_SECRET` for Sprite-key derivation. */
  secret: string;
  /**
   * Centralized code-execution authorization for the CURRENT actor. See
   * `SpriteHolderProvisionDeps.authorize` — this is the session-shaped form of it,
   * called with the row's drive/owner and `requestOrigin: 'user'`.
   */
  authorize: (input: CanRunCodeInput) => Promise<CanRunCodeResult>;
  /** REQUIRED full-egress enablement gate — a session Sprite runs open egress. */
  checkFullEgressEnablement: () => Promise<FullEgressEnablement>;
  /**
   * REQUIRED per-owner live-session ceiling — the session flavor of
   * `SpriteHolderProvisionDeps.checkQuota`, counted against the ROW's owner rather
   * than the actor (a drive member provisioning inside someone else's agent still
   * consumes the session owner's allocation, not their own).
   */
  checkConcurrency: (input: {
    ownerId: string;
    alreadyProvisioned: boolean;
  }) => Promise<{ allowed: boolean; reason?: string }>;
  /**
   * Optional opportunistic storage measurement — see
   * `SpriteHolderProvisionDeps.measureStorage`.
   */
  measureSessionStorage?: (input: {
    workspaceId: string;
    handle: SandboxHandle;
  }) => Promise<void>;
  /**
   * Provision the ENVIRONMENT an env-bound session runs inside — the same
   * holder-neutral core below, bound to the ENV's store, keyspace and gates
   * instead of the session's.
   *
   * **REQUIRED, and that is the whole safety property.** A session carrying
   * `envId` is CHECK-forbidden from holding Sprite pointers
   * (`agent_workspaces_env_no_sprite_check`), so a caller that "just" ran the
   * session arm for one would not quietly get the wrong machine — it would mint
   * a REAL, billed VM under a session keyspace and then fail the CAS write on
   * the constraint, orphaning it. Making this optional would leave every
   * present and future entry point (the web tool path, the realtime PTY bridge,
   * whatever comes next) one forgotten dep away from that. It is not defaulted
   * for the same reason `checkQuota` is not: a seam whose absence is a silent
   * fault is not one a default should paper over.
   *
   * It takes an intent because the caller's intent has to be TRANSLATED, not
   * forwarded — see `ensureAgentSessionSandbox` for the one case where the two
   * differ.
   */
  ensureEnvSandbox: (input: {
    envId: string;
    intent: SpriteHolderProvisionIntent;
  }) => Promise<EnsureSpriteHolderSandboxResult>;
  now: () => Date;
}

export type EnsureSpriteHolderSandboxResult =
  | { ok: true; sandboxId: string; resumed: boolean }
  | {
      ok: false;
      reason:
        /** The lifecycle planner refused. `denial` names WHICH gate — `not_authorized` is a 403, the rest are 404/409-shaped. */
        | 'denied'
        | 'egress_denied'
        | 'provision_failed'
        | 'persist_failed'
        | 'race_lost';
      denial?: SpriteHolderDenyReason;
      detail?: string;
    };

/**
 * The session-flavored name for the same result.
 *
 * The rule this PR follows for session-flavored aliases, so the one kept here
 * and the one dropped from `plan-workspace-lifecycle.ts` do not read as a coin
 * flip: **an alias survives only if something outside this package imports it.**
 * This one does — `apps/web/src/lib/agent-workspaces/agent-workspaces-runtime.ts`
 * — so dropping it would churn an app for nothing. `planAgentSessionLifecycle`
 * did not, and neither did the provision-intent alias that used to sit above, so
 * both went: an alias with only in-package callers is dead weight the knip
 * ratchet is right to notice.
 */
export type EnsureAgentSessionSandboxResult = EnsureSpriteHolderSandboxResult;

/**
 * Destroy a Sprite we hold that is genuinely unreferenced — and, when the kill
 * CANNOT be confirmed, RESCUE its pointer into the reclaim outbox.
 *
 * At every call site here the holder's row does NOT point at this Sprite (the
 * identity was never persisted, or a re-provision cleared it), so no AFTER-DELETE
 * trigger and no row-based cross-check could ever discover the VM. A
 * fire-and-forget kill that swallowed its error would leak a billed VM forever on
 * any provider hiccup. So: kill, check the outcome, and enqueue on failure. A
 * confirmed kill needs no enqueue — nor does a `SandboxSpriteReplacedError`,
 * which means a replacement already took the name and our target is already gone.
 */
async function killUnreferencedOrEnqueue(
  deps: Pick<SpriteHolderProvisionDeps, 'host' | 'store'>,
  handle: SandboxHandle,
): Promise<void> {
  try {
    await deps.host.kill({ sandboxId: handle.sandboxId, expectedInstanceId: handle.spriteInstanceId });
    return; // confirmed dead
  } catch (error) {
    if (error instanceof SandboxSpriteReplacedError) return;
    await deps.store
      .enqueueReclaim({ sandboxId: handle.sandboxId, spriteInstanceId: handle.spriteInstanceId ?? null })
      .catch((outboxError: unknown) => {
        // BOTH recovery routes are now exhausted: the VM would not die and its
        // pointer could not be parked for the reconciler. Nothing else in the
        // system knows this Sprite exists — no row points at it, so no trigger
        // and no cross-check will ever find it. It bills until an operator
        // notices, which they can only do if this is LOUD. Swallowing it
        // silently made the one path built to catch a permanently leaked VM the
        // one path that produced no signal at all.
        loggers.ai.error(
          'LEAKED SANDBOX: kill failed and reclaim-outbox insert failed; this VM is now unreferenced and will bill until reclaimed manually',
          outboxError instanceof Error ? outboxError : new Error(String(outboxError)),
          { sandboxId: handle.sandboxId, spriteInstanceId: handle.spriteInstanceId ?? null, killError: String(error) },
        );
      });
  }
}

/**
 * Has a concurrent provisioner of the SAME holder already recorded the Sprite WE
 * hold?
 *
 * `SandboxHost.provision` is NAME-keyed on the holder's deterministic key, so
 * two concurrent provisions of one unprovisioned holder can hold the SAME
 * physical VM. A row is a genuine shared winner ONLY when its `spriteInstanceId`
 * MATCHES our handle's instance (both non-null): the true race shares one VM ⇒
 * same instance ⇒ resume against it. A different or absent instance — including a
 * vanished-heal row still carrying its OLD, STALE instance under the reused name
 * — is NOT our generation. Pure reload + compare; kills nothing.
 */
async function findPersistedWinner(
  deps: Pick<SpriteHolderProvisionDeps, 'store'>,
  holderId: string,
  handle: SandboxHandle,
): Promise<{ sandboxId: string } | null> {
  const winner = await deps.store.reloadSpritePointer(holderId).catch(() => null);
  const ourInstance = handle.spriteInstanceId ?? null;
  if (winner?.sandboxId && ourInstance !== null && winner.spriteInstanceId === ourInstance) {
    return { sandboxId: winner.sandboxId };
  }
  return null;
}

/**
 * Reconcile against the persisted row BEFORE killing a Sprite we hold, at any
 * post-provision failure site.
 *
 * A SINGLE immediate reload — no polling, no wait. This runs inside an awaited
 * request path, so it must stay request-cheap; the rare
 * concurrent-identical-provision race where a winner has not yet recorded its
 * identity when we read is accepted, because its cost is bounded: an unconfirmed
 * kill of a shared Sprite is rescued to the reclaim outbox, and a
 * subsequently-vanished pointer self-heals on the next ensure.
 */
async function reconcileBeforeKill({
  deps,
  holderId,
  handle,
}: {
  deps: Pick<SpriteHolderProvisionDeps, 'store' | 'host'>;
  holderId: string;
  handle: SandboxHandle;
}): Promise<{ kind: 'resumed'; sandboxId: string } | { kind: 'killed' }> {
  const winner = await findPersistedWinner(deps, holderId, handle);
  // The row records OUR instance — the live, referenced VM we hold. Must NOT
  // kill; resume against it.
  if (winner) return { kind: 'resumed', sandboxId: winner.sandboxId };
  // No row records our generation — no winner, or only a STALE pre-reprovision
  // instance. Ours is unreferenced: kill it (or rescue it) rather than leak a VM.
  await killUnreferencedOrEnqueue(deps, handle);
  return { kind: 'killed' };
}

/** What a live probe of the recorded Sprite found. */
export type SpriteProbeOutcome =
  /** No probe was made — nothing recorded to probe, or the intent does not resume. */
  | { kind: 'unprobed' }
  /** The recorded Sprite answered. `instance` is what actually holds the name now, which may not be what the row remembers. */
  | { kind: 'live'; instance: LiveSpriteInstance }
  /** The recorded Sprite is GONE — the platform answered, and the VM does not exist. */
  | { kind: 'vanished' }
  /** The control plane would not answer. We learned NOTHING; this must not read as either live or gone. */
  | { kind: 'unknown' };

/**
 * Translate a probe outcome into the intent to ask the planner for (pure).
 *
 * This is the ONE place an observation becomes a lifecycle question, and it is
 * deliberately not a lifecycle decision: what `reprovision` MEANS is still the
 * planner's to say. A VANISHED Sprite is exactly the condition `reprovision`
 * exists for — the caller has observed that the recorded VM is unusable — and
 * without this translation the planner would (correctly, given what it was told)
 * hand back a `resume` onto a dead pointer, which fails later at PTY attach
 * instead of here.
 *
 * `attach` is NEVER upgraded: it carries no provisioning deps and must not mint a
 * VM, so a vanished Sprite on an attach stays a denial. `unknown` changes
 * nothing either — reprovisioning on a control-plane blip could duplicate a live
 * VM, so we leave the pointer alone and let a retry settle it.
 */
export function intentForProbeOutcome(
  intent: SpriteHolderProvisionIntent,
  probe: SpriteProbeOutcome,
): SpriteHolderProvisionIntent {
  if (probe.kind === 'vanished' && intent === 'ensure') return 'reprovision';
  return intent;
}

/** The live instance to hand the planner. Only a probe that actually SAW a Sprite reports one. */
function observedInstance(probe: SpriteProbeOutcome): LiveSpriteInstance | null {
  return probe.kind === 'live' ? probe.instance : null;
}

/**
 * Probe the Sprite the row currently points at.
 *
 * A row pointing at a Sprite we still BELIEVE is live is not proof the VM exists
 * — a provider can destroy it out from under us — and the probe is also how a
 * REPLACEMENT under the same deterministic name is discovered (the ABA case the
 * planner's `adopt` verdict exists for).
 */
async function probeRecordedSprite(
  row: SpriteHolderLifecycleRow,
  deps: Pick<SpriteHolderProvisionDeps, 'host'>,
): Promise<SpriteProbeOutcome> {
  if (row.sandboxId === null || row.spriteTornDownAt !== null) return { kind: 'unprobed' };
  try {
    const handle = await deps.host.attach({ sandboxId: row.sandboxId });
    if (!handle) return { kind: 'vanished' };
    return { kind: 'live', instance: { sandboxId: handle.sandboxId, spriteInstanceId: handle.spriteInstanceId ?? null } };
  } catch {
    return { kind: 'unknown' };
  }
}

/**
 * The row slice a session provision needs — the lifecycle columns under the
 * session's own names, plus who to authorize and meter against.
 *
 * `ownerId` is here for the concurrency ceiling: the quota counts an OWNER's
 * live sessions, and the owner is a fact of the row, never of the actor (a drive
 * member provisioning inside someone else's agent still consumes the session
 * owner's allocation, not their own).
 */
export type AgentSessionSpriteRow = Omit<SpriteHolderLifecycleRow, 'holderId'> & {
  /** The session's id — its `holderId`. Kept under this name so call sites do not churn. */
  workspaceId: string;
} & Pick<AgentSessionRecord, 'driveId' | 'ownerId' | 'envId'>;

/**
 * Ensure this holder's sandbox exists (or resume/adopt the one it has), and
 * record the result on its row.
 *
 * Idempotent by the holder's own id: the Sprite key folds it, so a re-provision
 * of a vanished Sprite lands on the same name — same identity, fresh filesystem.
 * On EVERY failure path the row is left with a NULL `sandboxId` (or its previous
 * pointer untouched) and a typed reason comes back: a holder is never left
 * believing it owns a VM it does not.
 */
export async function ensureSpriteHolderSandbox({
  row,
  intent,
  deps,
}: {
  row: SpriteHolderLifecycleRow;
  intent: SpriteHolderProvisionIntent;
  deps: SpriteHolderProvisionDeps;
}): Promise<EnsureSpriteHolderSandboxResult> {
  // Authorization is computed for THIS request and handed to the planner, which
  // applies it before any warm holder is returned.
  const authorized = await deps.authorize();

  const probe = await probeRecordedSprite(row, deps);
  const now = deps.now();
  const plan = planSpriteHolderLifecycle({
    row,
    intent: intentForProbeOutcome(intent, probe),
    canRun: authorized.ok,
    now,
    liveInstance: observedInstance(probe),
  });

  switch (plan.action) {
    case 'deny':
      return {
        ok: false,
        reason: 'denied',
        denial: plan.reason,
        detail: authorized.ok ? undefined : authorized.reason,
      };

    case 'resume':
      // A VANISHED probe can only reach a resume verdict on `attach`, which
      // deliberately may not mint a VM (it carries no provisioning deps, and the
      // predecessor's habit of healing here is how restored sessions ended up
      // sharing one Sprite). Resuming would hand back a dead pointer that fails
      // later, at PTY open, where it reads as a platform fault rather than a
      // holder that needs re-provisioning. Say so here instead.
      if (probe.kind === 'vanished') {
        return { ok: false, reason: 'provision_failed', detail: 'sandbox_vanished' };
      }
      // Nothing to provision and no identity to move — only the activity stamps
      // the verdict asked for. CAS-guarded on `endedAt` still being null: these
      // stamps (`endedAt: null, teardownRequestedAt: null`) were computed under
      // the assumption the row was NOT ended, and a concurrent `end` that
      // stamped it in between must not be silently erased — an unguarded write
      // here is the mirror-image of the end path's race (review #2261/1). A
      // refusal is not a failure: the identity being resumed is unchanged
      // either way, only the freshness touch is skipped.
      await deps.store.applyStamps({ holderId: row.holderId, stamps: plan.stamps, cas: { endedAt: null } });
      return { ok: true, sandboxId: plan.sandboxId, resumed: true };

    case 'adopt': {
      // A DIFFERENT VM answers to this holder's name. CAS the live identity onto
      // the row before anything treats it as resumed: leaving the stale instance
      // there makes every later teardown politely miss, and the live replacement
      // then bills forever with nothing pointing at it.
      const handle = await deps.host.attach({ sandboxId: plan.sandboxId }).catch(() => null);
      if (!handle) {
        // It vanished between the probe and here. Nothing to adopt and nothing to
        // kill; a retry re-probes and reprovisions.
        return { ok: false, reason: 'provision_failed', detail: 'adopted_sprite_vanished' };
      }
      // The key is deterministic and unchanged across a replacement, so deriving
      // it when the row somehow lacks one yields the same value the row would
      // have carried — never a second source of truth.
      const spriteKey = row.spriteKey ?? deps.deriveSpriteKey(row.holderId);
      let recorded: boolean;
      try {
        recorded = await deps.store.updateSpriteIdentity({
          holderId: row.holderId,
          previousSandboxId: plan.previousSandboxId,
          spriteKey,
          sandboxId: plan.sandboxId,
          spriteInstanceId: plan.spriteInstanceId,
          egressPolicyToken: handle.egressPolicyToken ?? row.egressPolicyToken ?? null,
          stamps: plan.stamps,
          now,
        });
      } catch (error) {
        const outcome = await reconcileBeforeKill({ deps, holderId: row.holderId, handle });
        if (outcome.kind === 'resumed') return { ok: true, sandboxId: outcome.sandboxId, resumed: true };
        return { ok: false, reason: 'persist_failed', detail: error instanceof Error ? error.message : String(error) };
      }
      if (!recorded) {
        // Lost to a concurrent adopt. If that winner recorded OUR exact instance
        // the VM is referenced and live (resume); otherwise ours is unreferenced
        // and must not be left billing untracked.
        const outcome = await reconcileBeforeKill({ deps, holderId: row.holderId, handle });
        if (outcome.kind === 'resumed') return { ok: true, sandboxId: outcome.sandboxId, resumed: true };
        return { ok: false, reason: 'race_lost' };
      }
      return { ok: true, sandboxId: plan.sandboxId, resumed: true };
    }

    case 'create': {
      // Both gates sit HERE, where a VM is actually minted — a resume/adopt
      // inherits an allocation that is already counted and a lockdown already
      // proven for its Sprite.
      const quota = await deps.checkQuota({
        // MUST match the store's live-count predicate exactly
        // (`sandboxId IS NOT NULL AND spriteTornDownAt IS NULL`). Teardown
        // stamps `spriteTornDownAt` and deliberately LEAVES `sandboxId` in
        // place, so a `sandboxId !== null` test alone would treat every ENDED
        // holder as already-counted and exempt it — letting an owner end N
        // sessions, re-provision them all, and hold N live sandboxes past their
        // ceiling. The exemption is only sound for an allocation the count can
        // actually see.
        alreadyProvisioned: row.sandboxId !== null && row.spriteTornDownAt === null,
      });
      if (!quota.allowed) {
        return { ok: false, reason: 'denied', denial: quota.denial, detail: quota.reason };
      }

      const enablement = await deps.checkFullEgressEnablement();
      if (!enablement.ok) return { ok: false, reason: 'egress_denied', detail: enablement.reason };

      const spriteKey = row.spriteKey ?? deps.deriveSpriteKey(row.holderId);

      let handle: SandboxHandle;
      try {
        handle = await deps.host.provision({
          name: spriteKey,
          substrate: deps.substrate,
          options: deps.options,
          // The egress-lockdown proof round-trip: hand back what was confirmed
          // for this holder's VM so a warm resume skips the redundant push, and
          // record whatever the host confirms this time below.
          appliedEgressToken: row.egressPolicyToken ?? null,
        });
      } catch (error) {
        return { ok: false, reason: 'provision_failed', detail: error instanceof Error ? error.message : String(error) };
      }

      // Persist the identity under a CAS on the row's CURRENT pointer, so two
      // concurrent provisions of the same holder cannot both win. The sandbox
      // starts empty at $HOME — there is nothing to clone, so this is the first
      // thing that happens after the VM exists.
      let recorded: boolean;
      try {
        recorded = await deps.store.updateSpriteIdentity({
          holderId: row.holderId,
          previousSandboxId: plan.previousSandboxId,
          spriteKey,
          sandboxId: handle.sandboxId,
          spriteInstanceId: handle.spriteInstanceId ?? null,
          egressPolicyToken: handle.egressPolicyToken ?? null,
          stamps: plan.stamps,
          now,
        });
      } catch (error) {
        // A transient DB error here would otherwise leave the Sprite ALIVE with a
        // NULL row pointer — billing forever, invisible to the reclaim trigger
        // (which needs a non-null sandboxId). But a blind kill has the shared-
        // winner hazard, so reconcile first.
        const outcome = await reconcileBeforeKill({ deps, holderId: row.holderId, handle });
        if (outcome.kind === 'resumed') return { ok: true, sandboxId: outcome.sandboxId, resumed: true };
        return { ok: false, reason: 'persist_failed', detail: error instanceof Error ? error.message : String(error) };
      }
      if (!recorded) {
        // Our CAS lost — another provisioner recorded a Sprite for this holder
        // first, and may hold our EXACT name-keyed physical VM.
        const outcome = await reconcileBeforeKill({ deps, holderId: row.holderId, handle });
        if (outcome.kind === 'resumed') return { ok: true, sandboxId: outcome.sandboxId, resumed: true };
        return { ok: false, reason: 'race_lost' };
      }

      // Measure while the Sprite is still awake right after provisioning — the
      // one moment its bytes are free to read. Fire-and-forget: a billing concern
      // must never be awaited by, or fail, a provision.
      if (deps.measureStorage) {
        void deps
          .measureStorage({ holderId: row.holderId, handle })
          .catch(() => {
            /* Best-effort: the seam already logs; provisioning must never fail on it. */
          });
      }

      return { ok: true, sandboxId: handle.sandboxId, resumed: false };
    }

    default:
      // `teardown` and `noop` are only ever produced by the `end` intent, which
      // this function's parameter type excludes — teardown is `endAgentSession`'s
      // job, because it must run unconditional on authorization.
      return { ok: false, reason: 'provision_failed', detail: `unexpected_lifecycle_verdict:${plan.action}` };
  }
}

/** What a refused live-session ceiling says when the quota module offers no wording of its own. */
const SESSION_LIMIT_DETAIL =
  'live agent-session limit reached for your plan — end an existing session before starting another';

/**
 * How a SESSION's intent reads when the holder being provisioned is its ENV
 * (pure).
 *
 * Two of the three pass straight through. The third does not, and it is the
 * reason this is a function rather than a forwarded argument:
 *
 * **`reprovision` becomes `attach`.** For an ordinary session, reprovision means
 * "this VM is unusable, replace it under the same key" — the caller owns the
 * filesystem it is discarding. For an env-bound session the filesystem is not
 * the caller's to discard: it is SHARED with every other session in that env,
 * and with every future one. Forwarding the intent would let one session's retry
 * — a wedged shell, a failed tool call, a client that retries on a timeout —
 * silently delete a team's environment out from under everyone working in it.
 * So it degrades to attach: the env's machine is handed back if it is there, and
 * the planner denies (`sandbox_not_provisioned` — an env has no ended state to
 * report) if it is not. Replacing an env's Sprite is `rebuildDriveEnv` and
 * nothing else — an
 * explicit, admin-aimed verb on the env itself, which is where the person
 * pressing it can see whose files they are destroying.
 *
 * Note what "attach-or-deny" costs and does not cost: a lazily-unprovisioned env
 * denies rather than minting, which is correct, because `reprovision` is never
 * the FIRST touch — `ensure` is, and it provisions.
 */
function envIntentForSessionIntent(intent: SpriteHolderProvisionIntent): SpriteHolderProvisionIntent {
  return intent === 'reprovision' ? 'attach' : intent;
}

/**
 * Stamp an env-bound session's row as live, after its ENVIRONMENT has been
 * provisioned.
 *
 * The env arm returns a sandbox without going anywhere near
 * `ensureSpriteHolderSandbox`, which is correct — the machine belongs to the
 * env's row — but it meant the SESSION's row was never written at all, and the
 * row carries lifecycle facts the env's cannot:
 *
 *  - **`endedAt`.** A torn-down ordinary session revives on `ensure` (that is
 *    what `reviveStamps` is for, and why the row is kept). Without this, an
 *    ended env session would be handed a working sandbox while still reading as
 *    ended — absent from every listing, reported as `'ended'` by the API, and
 *    refused the filesystem by `resolveSessionSandboxHandle`, all while its
 *    tools worked. A session that is usable and invisible is worse than one
 *    that is simply refused.
 *  - **`lastActiveAt`.** The listing orders on it, so an env session that never
 *    stamped it sorts below every ephemeral one forever, however recently it
 *    was used.
 *  - **`teardownRequestedAt`.** Cleared for the same reason the shared planner
 *    clears it: a row that is live again must not keep an intent to kill.
 *
 * What it deliberately does NOT write is any Sprite or storage column. Those
 * are CHECK-forbidden on this row (`agent_workspaces_env_no_sprite_check`) and
 * belong to the env, so this stamps the session's own lifecycle and nothing
 * else.
 *
 * **The CAS mirrors the ordinary session's two arms rather than inventing a
 * third rule.** Which guard applies is decided by the row we read:
 *
 *  - **It was NOT ended** — the ordinary `resume` case. Guarded on `endedAt`
 *    still being null, because these stamps were computed assuming the session
 *    was live and a concurrent `end` that landed in between must not be
 *    silently erased (review #2261/1, which is the same hazard on the session
 *    arm). A refusal is not a failure: the sandbox handed back is unaffected,
 *    only the freshness touch is skipped.
 *  - **It WAS ended** — the ordinary `create` case, a deliberate revive. Ending
 *    is what the user last asked for, but ensuring is what they are asking for
 *    now, and the session is retained precisely so it can come back. Unguarded,
 *    exactly as the create arm's identity write is.
 */
async function reviveEnvBoundSession({
  row,
  deps,
  now,
}: {
  row: AgentSessionSpriteRow;
  deps: Pick<AgentSessionSpriteDeps, 'store'>;
  now: Date;
}): Promise<void> {
  await deps.store.applyStamps({
    workspaceId: row.workspaceId,
    stamps: { lastActiveAt: now, endedAt: null, teardownRequestedAt: null },
    ...(row.endedAt === null ? { cas: { endedAt: null } } : {}),
  });
}

/**
 * Ensure THIS SESSION's sandbox exists — the entry point web and realtime call.
 *
 * A wrapper, not an implementation: it names the session's flavor of each seam
 * (its Sprite keyspace, its code-execution gate, its per-owner live-session
 * ceiling, its store's `workspaceId` column name) and hands them to the one
 * provisioning core. Adding a holder kind means adding a sibling wrapper, never a
 * second copy of the CAS.
 *
 * **An ENV-BOUND session is provisioned at its ENV, and the routing is here —
 * inside the shared entry point — on purpose.** Every surface that gives a
 * session a sandbox comes through this function (the web tool path, the shells
 * route, the realtime PTY bridge), so a session that borrows a machine borrows
 * it identically on all of them. Routing at a call site instead would mean each
 * caller remembering; the one that forgot would mint a second, billed VM under
 * the session keyspace and then fail the identity CAS on
 * `agent_workspaces_env_no_sprite_check`, orphaning it.
 *
 * Three consequences worth stating, because they are what the epic rests on:
 *
 *  - **The env's Sprite is created LAZILY, on the first ensure of any session
 *    inside it** — never at env-create time. Concurrent first-ensures are
 *    serialized by the identity CAS on the ENV row (the same CAS a session's own
 *    provision runs), so N sessions opening at once yield ONE VM and N callers
 *    holding its id; the losers reconcile rather than kill, exactly as they do
 *    for a session.
 *  - **Every session in an env resolves the SAME `sandboxId`**, because the env's
 *    Sprite name folds the ENV's id. Nothing threads a "shared" handle around —
 *    the shells, the fs and diff tools, the git runners and the realtime bridge
 *    are all sandbox-handle-keyed, so they share a filesystem by construction and
 *    needed no change to do it.
 *  - **`checkConcurrency` is never reached for an env session**, structurally
 *    rather than by a flag: the per-owner live-SESSION ceiling belongs to the
 *    session arm below, and an env session never enters it. The env is the billed
 *    unit, its allowance is metered where the commitment is made (env create),
 *    and the per-run code-execution semaphore still applies to every tool call
 *    either way.
 */
export async function ensureAgentSessionSandbox({
  row,
  intent,
  actor,
  deps,
}: {
  row: AgentSessionSpriteRow;
  intent: SpriteHolderProvisionIntent;
  actor: AgentSessionActorContext;
  deps: AgentSessionSpriteDeps;
}): Promise<EnsureAgentSessionSandboxResult> {
  if (row.envId !== null) {
    const provisioned = await deps.ensureEnvSandbox({
      envId: row.envId,
      intent: envIntentForSessionIntent(intent),
    });
    if (provisioned.ok) await reviveEnvBoundSession({ row, deps, now: deps.now() });
    return provisioned;
  }
  const { measureSessionStorage } = deps;
  return ensureSpriteHolderSandbox({
    row: { ...row, holderId: row.workspaceId },
    intent,
    deps: {
      store: {
        updateSpriteIdentity: ({ holderId, ...identity }) =>
          deps.store.updateSpriteIdentity({ workspaceId: holderId, ...identity }),
        applyStamps: ({ holderId, stamps, cas }) => deps.store.applyStamps({ workspaceId: holderId, stamps, cas }),
        reloadSpritePointer: (holderId) => deps.store.reloadSpritePointer(holderId),
        enqueueReclaim: (input) => deps.store.enqueueReclaim(input),
      },
      host: deps.host,
      substrate: deps.substrate,
      options: deps.options,
      deriveSpriteKey: (holderId) =>
        deriveAgentSessionSpriteKey({ tenantId: actor.tenantId, workspaceId: holderId, secret: deps.secret }),
      // Resolved with `requestOrigin: 'user'` to match the realtime attach path's
      // check. The drive is a fact of the ROW (a session is drive-scoped; null =
      // a user-scoped global-assistant session), so there is nothing to resolve
      // through an agent page any more.
      // `CanRunCodeResult` is already the shape the dep asks for, so this binds
      // the arguments and nothing else — no re-wrap to drift out of sync with.
      authorize: () =>
        deps.authorize({
          userId: actor.userId,
          driveId: row.driveId ?? undefined,
          ownerId: row.ownerId,
          requestOrigin: 'user',
        }),
      checkFullEgressEnablement: deps.checkFullEgressEnablement,
      checkQuota: async ({ alreadyProvisioned }) => {
        const quota = await deps.checkConcurrency({ ownerId: row.ownerId, alreadyProvisioned });
        if (quota.allowed) return { allowed: true };
        return { allowed: false, denial: 'session_limit_reached', reason: quota.reason ?? SESSION_LIMIT_DETAIL };
      },
      measureStorage: measureSessionStorage
        ? ({ holderId, handle }) => measureSessionStorage({ workspaceId: holderId, handle })
        : undefined,
      now: deps.now,
    },
  });
}
