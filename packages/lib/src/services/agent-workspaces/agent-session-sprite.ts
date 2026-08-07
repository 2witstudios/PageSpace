/**
 * Per-session Sprite provisioning (IO, dependency-injected) — the ONE code path
 * both the web app and the realtime bridge use to give an agent session its
 * sandbox.
 *
 * That "one path" is not a style preference: the CAS below only serializes
 * concurrent provisioners if every provisioner runs it. Two surfaces with two
 * copies of this logic would race each other into two live VMs under one
 * session, and only one of them would ever be pointed at.
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
 * What is kept, deliberately and unchanged in substance: provisioning under
 * `deriveAgentSessionSpriteKey`, the egress-enablement gate and the
 * `egressPolicyToken` proof round-trip, the identity CAS with its ABA guard, and
 * the reconcile-before-kill that stops a lost race from destroying the winner's
 * live VM (rescuing the pointer to the reclaim outbox when a cleanup kill cannot
 * be confirmed).
 *
 * **No lifecycle branches live here.** Whether a session creates, resumes,
 * adopts or is denied is decided by `planAgentSessionLifecycle`
 * (`agent-workspaces/plan-session-lifecycle.ts`); this module observes, asks, and
 * executes the verdict — including which columns the verdict says to stamp.
 */

import type { SandboxHandle, SandboxHost, SandboxSubstrateSpec } from '../sandbox/sandbox-host';
import { SandboxSpriteReplacedError } from '../sandbox/sandbox-host';
import type { SandboxCreateOptions } from '../sandbox/sandbox-options';
import type { FullEgressEnablement } from '../sandbox/containment';
import type { CanRunCodeInput, CanRunCodeResult } from '../sandbox/can-run-code';
import { deriveAgentSessionSpriteKey } from '../../agent-workspaces/session-sprite-key';
import {
  planAgentSessionLifecycle,
  type AgentSessionDenyReason,
  type AgentSessionLifecycleRow,
  type LiveSpriteInstance,
} from '../../agent-workspaces/plan-session-lifecycle';
import type { AgentSessionRecord, AgentSessionStore } from './agent-sessions-store';
import { loggers } from '../../logging/logger-config';

/** The actor a provision runs as. Only what the Sprite key and the authorization gate need — a session has no clone to audit and no git token to resolve. */
export interface AgentSessionActorContext {
  userId: string;
  tenantId: string;
}

/** The intents that can hand back a sandbox. `'end'` is not one of them — teardown lives in `agent-sessions.ts`, and its verdict is unconditional on authorization. */
export type AgentSessionProvisionIntent = 'ensure' | 'attach' | 'reprovision';

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
   * Centralized code-execution authorization for the CURRENT actor, applied
   * BEFORE any Sprite is provisioned OR handed back. Must never throw (the
   * centralized checker is fail-closed by construction). Its answer is passed to
   * the planner as `canRun` rather than acted on here, so that "re-authorize
   * before returning a warm session" is a property of the planner, not a habit
   * each call site has to remember.
   */
  authorize: (input: CanRunCodeInput) => Promise<CanRunCodeResult>;
  /** REQUIRED full-egress enablement gate — a session Sprite runs open egress. */
  checkFullEgressEnablement: () => Promise<FullEgressEnablement>;
  /**
   * REQUIRED per-owner live-session ceiling, applied where a VM is actually
   * MINTED. Required for the same reason as the egress gate above: this is the
   * one function every first touch funnels through — web routes, the sandbox and
   * session tools, AND the realtime shell bridge, which calls this module
   * directly rather than through the web app's wrapper. A gate placed at any
   * single call site would leave the others free to provision past the tier
   * ceiling, so it is a dep of the shared provisioner and not optional: a future
   * caller cannot forget what it cannot omit.
   *
   * Returning `{ allowed: false }` refuses the provision; a resume is exempt
   * (the row's sandbox is already counted), which the quota module itself
   * decides from `alreadyProvisioned`.
   */
  checkConcurrency: (input: {
    ownerId: string;
    alreadyProvisioned: boolean;
  }) => Promise<{ allowed: boolean; reason?: string }>;
  /**
   * Optional opportunistic storage measurement. While the Sprite is ALREADY
   * awake right after a provision, capture its used bytes onto the session row so
   * the storage reconcile can bill them — without ever waking a hibernating
   * Sprite. Best-effort and fire-and-forget; omitting it disables measurement.
   */
  measureSessionStorage?: (input: {
    workspaceId: string;
    handle: SandboxHandle;
  }) => Promise<void>;
  now: () => Date;
}

export type EnsureAgentSessionSandboxResult =
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
      denial?: AgentSessionDenyReason;
      detail?: string;
    };

/**
 * Destroy a Sprite we hold that is genuinely unreferenced — and, when the kill
 * CANNOT be confirmed, RESCUE its pointer into the reclaim outbox.
 *
 * At every call site here the session row does NOT point at this Sprite (the
 * identity was never persisted, or a re-provision cleared it), so no AFTER-DELETE
 * trigger and no row-based cross-check could ever discover the VM. A
 * fire-and-forget kill that swallowed its error would leak a billed VM forever on
 * any provider hiccup. So: kill, check the outcome, and enqueue on failure. A
 * confirmed kill needs no enqueue — nor does a `SandboxSpriteReplacedError`,
 * which means a replacement already took the name and our target is already gone.
 */
async function killUnreferencedOrEnqueue(
  deps: Pick<AgentSessionSpriteDeps, 'host' | 'store'>,
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
 * Has a concurrent provisioner of the SAME session already recorded the Sprite WE
 * hold?
 *
 * `SandboxHost.provision` is NAME-keyed on the session's deterministic key, so
 * two concurrent provisions of one unprovisioned session can hold the SAME
 * physical VM. A row is a genuine shared winner ONLY when its `spriteInstanceId`
 * MATCHES our handle's instance (both non-null): the true race shares one VM ⇒
 * same instance ⇒ resume against it. A different or absent instance — including a
 * vanished-heal row still carrying its OLD, STALE instance under the reused name
 * — is NOT our generation. Pure reload + compare; kills nothing.
 */
async function findPersistedWinner(
  deps: Pick<AgentSessionSpriteDeps, 'store'>,
  workspaceId: string,
  handle: SandboxHandle,
): Promise<{ sandboxId: string } | null> {
  const winner = await deps.store.reloadSpritePointer(workspaceId).catch(() => null);
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
  workspaceId,
  handle,
}: {
  deps: Pick<AgentSessionSpriteDeps, 'store' | 'host'>;
  workspaceId: string;
  handle: SandboxHandle;
}): Promise<{ kind: 'resumed'; sandboxId: string } | { kind: 'killed' }> {
  const winner = await findPersistedWinner(deps, workspaceId, handle);
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
  intent: AgentSessionProvisionIntent,
  probe: SpriteProbeOutcome,
): AgentSessionProvisionIntent {
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
  row: AgentSessionLifecycleRow,
  deps: Pick<AgentSessionSpriteDeps, 'host'>,
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

/** The row slice this module needs — the lifecycle columns, plus who to authorize against. */
export type AgentSessionSpriteRow = AgentSessionLifecycleRow &
  // `ownerId` is here for the concurrency ceiling: the quota counts an OWNER's
  // live sessions, and the owner is a fact of the row, never of the actor
  // (a drive member provisioning inside someone else's agent still consumes the
  // session owner's allocation, not their own).
  Pick<AgentSessionRecord, 'driveId' | 'egressPolicyToken' | 'ownerId'>;

/**
 * Ensure this session's sandbox exists (or resume/adopt the one it has), and
 * record the result on its row.
 *
 * Idempotent by the session's own id: the Sprite key folds it, so a re-provision
 * of a vanished Sprite lands on the same name — same identity, fresh filesystem.
 * On EVERY failure path the row is left with a NULL `sandboxId` (or its previous
 * pointer untouched) and a typed reason comes back: a session is never left
 * believing it owns a VM it does not.
 */
export async function ensureAgentSessionSandbox({
  row,
  intent,
  actor,
  deps,
}: {
  row: AgentSessionSpriteRow;
  intent: AgentSessionProvisionIntent;
  actor: AgentSessionActorContext;
  deps: AgentSessionSpriteDeps;
}): Promise<EnsureAgentSessionSandboxResult> {
  // Authorization is computed for THIS request and handed to the planner, which
  // applies it before any warm session is returned. Resolved with
  // `requestOrigin: 'user'` to match the realtime attach path's check. The
  // drive is a fact of the ROW now (a session is drive-scoped; null = a
  // user-scoped global-assistant session), so there is nothing to resolve
  // through an agent page any more.
  const authorized = await deps.authorize({
    userId: actor.userId,
    driveId: row.driveId ?? undefined,
    ownerId: row.ownerId,
    requestOrigin: 'user',
  });

  const probe = await probeRecordedSprite(row, deps);
  const now = deps.now();
  const plan = planAgentSessionLifecycle({
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
      // session that needs re-provisioning. Say so here instead.
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
      await deps.store.applyStamps({ workspaceId: row.workspaceId, stamps: plan.stamps, cas: { endedAt: null } });
      return { ok: true, sandboxId: plan.sandboxId, resumed: true };

    case 'adopt': {
      // A DIFFERENT VM answers to this session's name. CAS the live identity onto
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
      const spriteKey =
        row.spriteKey ??
        deriveAgentSessionSpriteKey({ tenantId: actor.tenantId, workspaceId: row.workspaceId, secret: deps.secret });
      let recorded: boolean;
      try {
        recorded = await deps.store.updateSpriteIdentity({
          workspaceId: row.workspaceId,
          previousSandboxId: plan.previousSandboxId,
          spriteKey,
          sandboxId: plan.sandboxId,
          spriteInstanceId: plan.spriteInstanceId,
          egressPolicyToken: handle.egressPolicyToken ?? row.egressPolicyToken ?? null,
          stamps: plan.stamps,
          now,
        });
      } catch (error) {
        const outcome = await reconcileBeforeKill({ deps, workspaceId: row.workspaceId, handle });
        if (outcome.kind === 'resumed') return { ok: true, sandboxId: outcome.sandboxId, resumed: true };
        return { ok: false, reason: 'persist_failed', detail: error instanceof Error ? error.message : String(error) };
      }
      if (!recorded) {
        // Lost to a concurrent adopt. If that winner recorded OUR exact instance
        // the VM is referenced and live (resume); otherwise ours is unreferenced
        // and must not be left billing untracked.
        const outcome = await reconcileBeforeKill({ deps, workspaceId: row.workspaceId, handle });
        if (outcome.kind === 'resumed') return { ok: true, sandboxId: outcome.sandboxId, resumed: true };
        return { ok: false, reason: 'race_lost' };
      }
      return { ok: true, sandboxId: plan.sandboxId, resumed: true };
    }

    case 'create': {
      // Both gates sit HERE, where a VM is actually minted — a resume/adopt
      // inherits an allocation that is already counted and a lockdown already
      // proven for its Sprite.
      const quota = await deps.checkConcurrency({
        ownerId: row.ownerId,
        // MUST match `AgentSessionStore.countLive`'s predicate exactly
        // (`sandboxId IS NOT NULL AND spriteTornDownAt IS NULL`). Teardown
        // stamps `spriteTornDownAt` and deliberately LEAVES `sandboxId` in
        // place, so a `sandboxId !== null` test alone would treat every ENDED
        // session as already-counted and exempt it — letting an owner end N
        // sessions, re-provision them all, and hold N live sandboxes past their
        // ceiling. The exemption is only sound for an allocation the count can
        // actually see.
        alreadyProvisioned: row.sandboxId !== null && row.spriteTornDownAt === null,
      });
      if (!quota.allowed) {
        return {
          ok: false,
          reason: 'denied',
          denial: 'session_limit_reached',
          detail:
            quota.reason ??
            'live agent-session limit reached for your plan — end an existing session before starting another',
        };
      }

      const enablement = await deps.checkFullEgressEnablement();
      if (!enablement.ok) return { ok: false, reason: 'egress_denied', detail: enablement.reason };

      const spriteKey =
        row.spriteKey ??
        deriveAgentSessionSpriteKey({ tenantId: actor.tenantId, workspaceId: row.workspaceId, secret: deps.secret });

      let handle: SandboxHandle;
      try {
        handle = await deps.host.provision({
          name: spriteKey,
          substrate: deps.substrate,
          options: deps.options,
          // The egress-lockdown proof round-trip: hand back what was confirmed
          // for this session's VM so a warm resume skips the redundant push, and
          // record whatever the host confirms this time below.
          appliedEgressToken: row.egressPolicyToken ?? null,
        });
      } catch (error) {
        return { ok: false, reason: 'provision_failed', detail: error instanceof Error ? error.message : String(error) };
      }

      // Persist the identity under a CAS on the row's CURRENT pointer, so two
      // concurrent provisions of the same session cannot both win. The sandbox
      // starts empty at $HOME — there is nothing to clone, so this is the first
      // thing that happens after the VM exists.
      let recorded: boolean;
      try {
        recorded = await deps.store.updateSpriteIdentity({
          workspaceId: row.workspaceId,
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
        const outcome = await reconcileBeforeKill({ deps, workspaceId: row.workspaceId, handle });
        if (outcome.kind === 'resumed') return { ok: true, sandboxId: outcome.sandboxId, resumed: true };
        return { ok: false, reason: 'persist_failed', detail: error instanceof Error ? error.message : String(error) };
      }
      if (!recorded) {
        // Our CAS lost — another provisioner recorded a Sprite for this session
        // first, and may hold our EXACT name-keyed physical VM.
        const outcome = await reconcileBeforeKill({ deps, workspaceId: row.workspaceId, handle });
        if (outcome.kind === 'resumed') return { ok: true, sandboxId: outcome.sandboxId, resumed: true };
        return { ok: false, reason: 'race_lost' };
      }

      // Measure while the Sprite is still awake right after provisioning — the
      // one moment its bytes are free to read. Fire-and-forget: a billing concern
      // must never be awaited by, or fail, a provision.
      if (deps.measureSessionStorage) {
        void deps
          .measureSessionStorage({ workspaceId: row.workspaceId, handle })
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
