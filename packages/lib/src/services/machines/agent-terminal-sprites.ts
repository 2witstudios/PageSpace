/**
 * Per-session Sprite provisioning for agent terminals (IO, dependency-injected).
 *
 * Every spawned agent-terminal session (`machine_agent_terminals` row) gets its
 * OWN, SEPARATE Sprite — exactly the way a branch-terminal (`machine-branches.ts`)
 * always has, and a promoted project (`machine-project-promotion.ts`) does. This
 * is `spawnBranch`'s provisioning template applied per session: same `MachineHost`
 * seam, same HMAC-named provision (`deriveAgentTerminalSessionSpriteKey`, its own
 * namespace keyed on the terminal ROW id), same hardened `runGitInSandbox` clone
 * (reusing `cloneAndCheckoutBranch`/`cloneRepoInto` lifted from
 * machine-branches.ts), same `propagateClaudeCredential` copy FROM the owning
 * Machine's root Sprite (the login anchor — never changed here), and the same
 * identity columns to CAS against (`updateSpriteIdentity`).
 *
 * Per scope:
 *  - `machine`: no clone — the session runs at the Sprite's home (SANDBOX_ROOT).
 *  - `project`: clone the project's repo into PROJECT_REPO_PATH.
 *  - `branch`: clone + checkout the branch into BRANCH_REPO_PATH.
 *
 * This is invoked from `spawnAgentTerminal` after the row is reserved (the row's
 * id is the Sprite-key fold, so the row must exist first). It is BEST-EFFORT to
 * the spawn: a provisioning failure leaves the row with a NULL `sandboxId`,
 * which `resolveLocationForRow` resolves via the pre-per-session shared-Sprite
 * fallback and a later spawn re-provisions — the session is never left broken,
 * and no billing VM is ever left unreferenced: every failure after a successful
 * provision routes through `reconcileBeforeKill`, which waits (bounded) for a
 * concurrent winner before killing, and rescues the Sprite into the reclaim
 * outbox when its cleanup kill cannot be confirmed.
 */

import type { MachineHandle, MachineHost, MachineSubstrateSpec } from '../sandbox/machine-host';
import { MachineSpriteReplacedError } from '../sandbox/machine-host';
import type { SandboxCreateOptions } from '../sandbox/sandbox-options';
import type { FullEgressEnablement } from '../sandbox/containment';
import type { CanRunCodeInput, CanRunCodeResult } from '../sandbox/can-run-code';
import { PROJECT_REPO_PATH } from '../sandbox/sandbox-paths';
import {
  cloneAndCheckoutBranch,
  cloneRepoInto,
  propagateClaudeCredential,
  type MachineActorContext,
  type SpriteCloneDeps,
} from './machine-branches';
import { deriveAgentTerminalSessionSpriteKey } from './agent-terminal-sprite-session';
import type { MachineAgentTerminalRecord, MachineAgentTerminalStore } from './agent-terminals-store';

export type { MachineActorContext };

/** The Sprite-provisioning slice of the agent-terminals deps — mirrors the Sprite fields of `MachineBranchesDeps`. */
export interface AgentTerminalSpriteProvisionDeps extends SpriteCloneDeps {
  /** CAS the provisioned Sprite identity onto the terminal row. */
  updateSpriteIdentity: (input: {
    id: string;
    previousSandboxId: string | null;
    sessionKey: string;
    sandboxId: string;
    spriteInstanceId: string | null;
    egressPolicyToken: string | null;
    now: Date;
  }) => Promise<boolean>;
  /**
   * Re-read the row's persisted Sprite pointer AND INSTANCE, to RECONCILE a lost
   * provisioning race against the winner BEFORE killing — the agent-terminal twin
   * of `reconcileProvisionCollision` (machine-branches.ts). `MachineHost.provision`
   * is name-keyed, so two concurrent provisions of the same unprovisioned row
   * (same derived key) can hold the SAME physical Sprite; the CAS loser must not
   * kill the very VM the winner just recorded. `spriteInstanceId` is load-bearing:
   * a genuine winner recorded OUR generation (same instance), whereas a
   * vanished-heal reprovision that failed leaves the OLD stale instance behind —
   * see `reconcileBeforeKill`.
   */
  reloadRow: (id: string) => Promise<{ sandboxId: string | null; spriteInstanceId: string | null } | null>;
  /**
   * Enqueue a Sprite pointer into the reclaim outbox (`machine_sprite_reclaims`).
   * The provisioning failure path uses it when a cleanup kill CANNOT be confirmed:
   * the row still has a NULL `sandboxId` (the identity was never persisted), so
   * neither the AFTER-DELETE trigger nor the tracking-row reconciler could ever
   * discover the live, billed VM — the outbox is its only reclaim path.
   */
  enqueueReclaim: (input: { sandboxId: string; spriteInstanceId: string | null }) => Promise<void>;
  /** The provider-neutral Sprite lifecycle seam. */
  host: MachineHost;
  substrate: MachineSubstrateSpec;
  options: SandboxCreateOptions;
  /** Server-held secret for Sprite-key derivation (same secret as machine-session-manager.ts). */
  secret: string;
  /**
   * Centralized code-execution authorization for the CURRENT actor, applied
   * BEFORE any Sprite is provisioned (finding P — SECURITY). Same shape and
   * fail-closed contract the session managers use (`authorize: canRunCode`,
   * `machine-session.ts` / `tool-gate.ts`): it is the STRONGER check the realtime
   * attach path enforces (app-admin + owner/admin drive role), whereas the spawn
   * route only checked edit-level page access. Without it an editor correctly
   * denied code execution could still create billable, full-egress Sprites by
   * spawning terminals under distinct names. Must never throw.
   */
  authorize: (input: CanRunCodeInput) => Promise<CanRunCodeResult>;
  /** Resolve the machine page's owning drive id — needed to run the drive-role arm of `authorize`. `null` when the page/drive can't be resolved (then authorization fails closed). */
  resolveDriveId: (machineId: string) => Promise<string | null>;
  /** REQUIRED full-egress enablement gate — a session Sprite runs open egress, same as a branch's. */
  checkFullEgressEnablement: () => Promise<FullEgressEnablement>;
  /** Live handle to the OWNING Machine's own persistent Sprite — the source the Claude Code credential is copied from. `null` = graceful no-op. */
  resolveRootMachineHandle: (machineId: string) => Promise<MachineHandle | null>;
  /** A project's clone URL by (machineId, projectName). Needed for project- and branch-scope clones; unused for machine scope. */
  resolveProjectRepoUrl: (machineId: string, projectName: string) => Promise<string | null>;
  /** A branch's checked-out name by its `machine_branches` row id. Needed only for branch-scope clones. */
  resolveBranchName: (machineBranchId: string) => Promise<string | null>;
  /**
   * Optional opportunistic storage-measurement seam (mirrors
   * `MachineBranchesDeps.measureBranchStorage`). While this session's Sprite is
   * ALREADY awake right after provision/clone, capture its used bytes onto its
   * own `machine_agent_terminals` row so the storage reconcile bills them to the
   * OWNING Machine page — without ever waking a hibernating Sprite. Best-effort
   * and fire-and-forget; omitting it disables measurement (the reconcile then
   * bills the conservative never-measured 0 floor).
   */
  measureAgentTerminalStorage?: (input: {
    machineAgentTerminalId: string;
    machinePageId: string;
    handle: MachineHandle;
  }) => Promise<void>;
}

export type ProvisionAgentTerminalSpriteResult =
  | { ok: true; sandboxId: string; resumed: boolean }
  | {
      ok: false;
      reason:
        | 'unauthorized'
        | 'egress_denied'
        | 'project_not_found'
        | 'branch_not_found'
        | 'provision_failed'
        | 'clone_failed'
        | 'persist_failed'
        | 'race_lost';
      detail?: string;
    };

/**
 * Destroy a Sprite we hold that is genuinely unreferenced (no winner recorded it)
 * — and, when the kill CANNOT be confirmed, RESCUE its pointer into the reclaim
 * outbox (finding Y).
 *
 * The provisioning row still has a NULL `sandboxId` at every call site here (the
 * identity was never persisted, or a re-provision cleared it), so unlike a killed
 * branch/project row there is NO AFTER-DELETE trigger and NO tracking-row
 * reconciler that could ever find this VM. A fire-and-forget kill that swallows
 * its error would therefore leak a billed VM forever on any provider hiccup. So:
 * kill and check the outcome; a genuine failure enqueues the handle for the
 * orphan reconciler's tier-A to retry. A confirmed kill (or a `MachineSpriteReplacedError`,
 * meaning a replacement already took the name — our target is already gone) needs
 * no enqueue.
 */
async function killUnreferencedOrEnqueue(
  deps: Pick<AgentTerminalSpriteProvisionDeps, 'host' | 'enqueueReclaim'>,
  handle: MachineHandle,
): Promise<void> {
  try {
    await deps.host.kill({ machineId: handle.machineId, expectedInstanceId: handle.spriteInstanceId });
    return; // confirmed dead
  } catch (error) {
    // A different VM holds this name now → our target is already gone; the
    // newcomer has its OWN row and must not be enqueued.
    if (error instanceof MachineSpriteReplacedError) return;
    // Unconfirmed kill: the VM may still be alive and billing, and nothing else
    // points at it. Enqueue it so the reconciler retries. Best-effort itself —
    // if even the enqueue fails there is nothing more we can do here.
    await deps
      .enqueueReclaim({ sandboxId: handle.machineId, spriteInstanceId: handle.spriteInstanceId ?? null })
      .catch(() => {
        /* best-effort: the outbox insert failed too; the provisioning failure is still reported. */
      });
  }
}

/**
 * Reconcile against the persisted row BEFORE killing a Sprite we hold, at ANY
 * post-provision failure site (a failed clone, a failed/lost persist).
 *
 * A SINGLE immediate reload — no polling, no wait — exactly like the proven
 * branch path (`reconcileProvisionCollision`, machine-branches.ts). This runs
 * INSIDE the awaited spawn (`maybeProvisionSprite` ← `spawnAgentTerminal` ← the
 * POST request), so it MUST stay request-cheap: a bounded wait for a
 * still-cloning winner would hold the request for clone-scale time and blow the
 * HTTP budget. The rare concurrent-identical-spawn race — where a winner sharing
 * our name-keyed Sprite has not yet recorded its identity when we read — is
 * accepted, and is strictly safer here than for branches: an unconfirmed kill of
 * a shared Sprite is rescued to the reclaim outbox (finding Y), and a
 * subsequently-vanished pointer self-heals on the next spawn.
 *
 * `MachineHost.provision` is name-keyed on the row's deterministic session key,
 * so a concurrent provision of the SAME row can hand BOTH callers the SAME
 * physical Sprite. A row is a WINNER only when its `spriteInstanceId` MATCHES the
 * instance of the handle WE hold (both non-null — finding Q): the true race
 * shares one physical VM ⇒ same instance ⇒ resume, do NOT kill. A different or
 * absent instance — including a vanished-heal row still carrying its OLD, STALE
 * instance under the reused name — is NOT our generation, so ours is unreferenced
 * and is killed via `killUnreferencedOrEnqueue` (which enqueues it to the outbox
 * on an unconfirmed kill).
 *
 * The single reconcile-before-kill the CAS-loss path introduced, lifted so every
 * kill site shares it (branch clone-fail, project clone-fail, persist-throw).
 */
async function reconcileBeforeKill({
  deps,
  row,
  handle,
}: {
  deps: Pick<AgentTerminalSpriteProvisionDeps, 'reloadRow' | 'host' | 'enqueueReclaim'>;
  row: Pick<MachineAgentTerminalRecord, 'id'>;
  handle: MachineHandle;
}): Promise<{ kind: 'resumed'; sandboxId: string } | { kind: 'killed' }> {
  const winner = await deps.reloadRow(row.id).catch(() => null);
  const ourInstance = handle.spriteInstanceId ?? null;
  if (winner?.sandboxId && ourInstance !== null && winner.spriteInstanceId === ourInstance) {
    // The row records OUR instance — the live, referenced VM we hold (a genuine
    // shared winner). Must NOT kill; resume against it.
    return { kind: 'resumed', sandboxId: winner.sandboxId };
  }
  // No row records our generation — no winner, or only a STALE pre-reprovision
  // instance (a vanished-heal whose replacement never landed). Ours is
  // unreferenced: kill it (or rescue it to the outbox) rather than leak a VM.
  await killUnreferencedOrEnqueue(deps, handle);
  return { kind: 'killed' };
}

/**
 * Provision (or resume) this session's OWN Sprite and record it on the row.
 * Idempotent by the row's own id: the Sprite key folds the row id, so a
 * re-provision of a vanished Sprite lands on the same name. Caller passes a row
 * whose `sandboxId` is currently NULL (a fresh reservation, or a legacy/failed
 * row being healed); a row that already has a live `sandboxId` should never
 * reach here (the spawn/resolve paths reattach to it directly).
 */
export async function provisionAgentTerminalSprite({
  row,
  actor,
  deps,
}: {
  row: Pick<MachineAgentTerminalRecord, 'id' | 'machineId' | 'projectName' | 'machineBranchId' | 'sessionKey' | 'sandboxId' | 'egressPolicyToken'>;
  actor: MachineActorContext;
  deps: AgentTerminalSpriteProvisionDeps;
}): Promise<ProvisionAgentTerminalSpriteResult> {
  // SECURITY (finding P): apply the centralized code-execution authorization for
  // the CURRENT actor BEFORE anything is provisioned — the same STRONGER check
  // the realtime attach path enforces (app-admin + owner/admin drive role), not
  // the weaker edit-level page access the spawn route already checked. Denied →
  // skip provisioning entirely; the row keeps a NULL sandboxId and the
  // resolve/attach path (which independently re-runs this check) governs from
  // there. Resolved with `requestOrigin: 'user'` to match that attach path.
  const driveId = await deps.resolveDriveId(row.machineId);
  const authorized = await deps.authorize({
    userId: actor.userId,
    driveId: driveId ?? undefined,
    requestOrigin: 'user',
  });
  if (!authorized.ok) return { ok: false, reason: 'unauthorized', detail: authorized.reason };

  const enablement = await deps.checkFullEgressEnablement();
  if (!enablement.ok) return { ok: false, reason: 'egress_denied', detail: enablement.reason };

  const scopeKey = `agent-terminal:${row.id}`;

  // Resolve what the clone needs BEFORE provisioning a VM, so a missing
  // project/branch never leaks a Sprite. Machine scope needs nothing.
  let repoUrl: string | null = null;
  let branchName: string | null = null;
  if (row.machineBranchId) {
    branchName = await deps.resolveBranchName(row.machineBranchId);
    if (!branchName) return { ok: false, reason: 'branch_not_found' };
    if (!row.projectName) return { ok: false, reason: 'project_not_found' };
    repoUrl = await deps.resolveProjectRepoUrl(row.machineId, row.projectName);
    if (!repoUrl) return { ok: false, reason: 'project_not_found' };
  } else if (row.projectName) {
    repoUrl = await deps.resolveProjectRepoUrl(row.machineId, row.projectName);
    if (!repoUrl) return { ok: false, reason: 'project_not_found' };
  }

  const sessionKey =
    row.sessionKey ??
    deriveAgentTerminalSessionSpriteKey({
      tenantId: actor.tenantId,
      machineId: row.machineId,
      terminalId: row.id,
      secret: deps.secret,
    });

  let handle: MachineHandle;
  try {
    handle = await deps.host.provision({
      name: sessionKey,
      substrate: deps.substrate,
      options: deps.options,
      appliedEgressToken: row.egressPolicyToken ?? null,
    });
  } catch (error) {
    return { ok: false, reason: 'provision_failed', detail: error instanceof Error ? error.message : String(error) };
  }

  // Clone per scope. On failure, DON'T blindly kill: a concurrent winner sharing
  // our name-keyed Sprite may have created the checkout dir (which is exactly why
  // our redundant clone failed) and already persisted/returned it — killing it
  // would destroy the winner's live VM. Reconcile first (see `reconcileBeforeKill`).
  if (row.machineBranchId && repoUrl && branchName) {
    const cloned = await cloneAndCheckoutBranch({ handle, repoUrl, branchName, scopeKey, actor, deps });
    if (!cloned.ok) {
      const outcome = await reconcileBeforeKill({ deps, row, handle });
      if (outcome.kind === 'resumed') return { ok: true, sandboxId: outcome.sandboxId, resumed: true };
      return { ok: false, reason: 'clone_failed', detail: cloned.detail };
    }
  } else if (row.projectName && repoUrl) {
    const cloned = await cloneRepoInto({ handle, repoUrl, targetPath: PROJECT_REPO_PATH, scopeKey, actor, deps });
    if (!cloned.ok) {
      const outcome = await reconcileBeforeKill({ deps, row, handle });
      if (outcome.kind === 'resumed') return { ok: true, sandboxId: outcome.sandboxId, resumed: true };
      return { ok: false, reason: 'clone_failed', detail: cloned.detail };
    }
  }
  // machine scope: no clone — cwd is the Sprite home (SANDBOX_ROOT).

  // Persist the identity FIRST (before the credential copy), under a CAS on the
  // row's CURRENT sandboxId — so a concurrent provision of the same
  // unprovisioned row cannot both win.
  let recorded: boolean;
  try {
    recorded = await deps.updateSpriteIdentity({
      id: row.id,
      previousSandboxId: row.sandboxId,
      sessionKey,
      sandboxId: handle.machineId,
      spriteInstanceId: handle.spriteInstanceId ?? null,
      egressPolicyToken: handle.egressPolicyToken ?? null,
      now: deps.now(),
    });
  } catch (error) {
    // FINDING 2: a transient DB error here would otherwise escape (swallowed by
    // `maybeProvisionSprite`) leaving the Sprite ALIVE with a NULL row pointer —
    // billing forever, and invisible to the reclaim trigger (which needs a
    // non-null sandboxId). But a blind kill has the SAME shared-winner hazard as
    // the clone sites: if our `updateSpriteIdentity` threw while a concurrent
    // winner's CAS on the same name-keyed Sprite succeeded (or ours committed and
    // only the response threw), killing "ours" destroys the winner's — or our
    // own now-referenced — live VM. Reconcile before killing.
    const outcome = await reconcileBeforeKill({ deps, row, handle });
    if (outcome.kind === 'resumed') return { ok: true, sandboxId: outcome.sandboxId, resumed: true };
    return { ok: false, reason: 'persist_failed', detail: error instanceof Error ? error.message : String(error) };
  }
  if (!recorded) {
    // FINDING 1: our CAS lost — another provision recorded a Sprite for this row
    // first. The winner may hold our EXACT name-keyed physical Sprite, so
    // reconcile before killing (the shared reconcile-before-kill).
    const outcome = await reconcileBeforeKill({ deps, row, handle });
    if (outcome.kind === 'resumed') return { ok: true, sandboxId: outcome.sandboxId, resumed: true };
    return { ok: false, reason: 'race_lost' };
  }

  // Copy the Claude Code credential FROM the owning Machine's root Sprite — the
  // login anchor — exactly as spawnBranch does. Best-effort inside.
  await propagateClaudeCredential({
    machineId: row.machineId,
    branchHandle: handle,
    resolveRootMachineHandle: deps.resolveRootMachineHandle,
  });

  // Measure this session Sprite's footprint while it is still awake right after
  // the provision/clone — the one moment its bytes are guaranteed non-trivial,
  // exactly as spawnBranch measures a branch. Fire-and-forget: a billing concern
  // must never be awaited by (or fail) the spawn.
  if (deps.measureAgentTerminalStorage) {
    void deps
      .measureAgentTerminalStorage({ machineAgentTerminalId: row.id, machinePageId: row.machineId, handle })
      .catch(() => {
        /* Best-effort: the seam already logs; a spawn must never fail on it. */
      });
  }

  return { ok: true, sandboxId: handle.machineId, resumed: false };
}

/** A snapshotted agent-terminal Sprite to tear down — the row id plus its exact generation, so the teardown CAS acts only on THIS row's THIS Sprite. */
export interface AgentTerminalSpriteRef {
  id: string;
  sandboxId: string;
  spriteInstanceId: string | null;
}

/** The store slice `snapshotProjectAgentTerminalSprites` needs — enumerate a scope's rows. */
export interface SnapshotProjectAgentTerminalsDeps {
  store: Pick<MachineAgentTerminalStore, 'list'>;
  /**
   * The `machine_branches` row ids belonging to (machineId, projectName) —
   * needed because a removed project's branch rows do NOT cascade-delete (the
   * project link is only `projectName` TEXT), so their branch-scoped terminal
   * Sprites must be reclaimed as part of project removal too (finding DD).
   */
  listProjectBranchIds: (machineId: string, projectName: string) => Promise<string[]>;
}

/**
 * SNAPSHOT the agent-terminal rows with a live OWN Sprite under a project —
 * PROJECT-scoped AND BRANCH-scoped (findings DD/EE) — capturing each row's id and
 * exact generation (`sandboxId`/`spriteInstanceId`) so a later teardown can act
 * on THESE SPECIFIC rows by id.
 *
 * Taken BEFORE the `machine_projects` row is deleted, which pins the teardown to
 * THIS project generation: a same-name replacement project can only be re-added
 * AFTER the delete, so its later terminals are never in this snapshot and are
 * never touched (finding EE — the ABA a post-delete name re-query would hit).
 *
 * DD: neither a project-scoped row (linked to the project only by `projectName`
 * TEXT) nor a branch-scoped row (whose branch links to the project only by
 * `projectName` TEXT, so the project delete never cascades to `machine_branches`,
 * so its `machineBranchId` FK cascade never fires) is reclaimed by the project
 * delete. Both are captured here.
 */
export async function snapshotProjectAgentTerminalSprites({
  machineId,
  projectName,
  deps,
}: {
  machineId: string;
  projectName: string;
  deps: SnapshotProjectAgentTerminalsDeps;
}): Promise<AgentTerminalSpriteRef[]> {
  const refs: AgentTerminalSpriteRef[] = [];
  const collect = (rows: Awaited<ReturnType<MachineAgentTerminalStore['list']>>): void => {
    for (const row of rows) {
      // Only rows with a live Sprite of their OWN: a legacy/unprovisioned row has
      // nothing to kill, a torn-down one is already gone.
      if (!row.sandboxId || row.spriteTornDownAt) continue;
      refs.push({ id: row.id, sandboxId: row.sandboxId, spriteInstanceId: row.spriteInstanceId });
    }
  };
  // Project-scoped sessions.
  collect(await deps.store.list({ machineId, projectName, machineBranchId: null }));
  // Branch-scoped sessions of EACH of the project's branches (finding DD).
  const branchIds = await deps.listProjectBranchIds(machineId, projectName);
  for (const machineBranchId of branchIds) {
    collect(await deps.store.list({ machineId, projectName, machineBranchId }));
  }
  return refs;
}

/** The store slice `teardownAgentTerminalSpriteSnapshot` needs — CAS-delete a snapshotted row (dropping or rescuing the reclaim pointer). */
export interface TeardownAgentTerminalSnapshotDeps {
  store: Pick<MachineAgentTerminalStore, 'removeIfSandbox' | 'removeIfSandboxToReclaim'>;
  /**
   * Identity-guarded kill of a session's OWN Sprite. `ok: true` means the target
   * is CONFIRMED gone (killed, or a replacement already took its name); `ok:
   * false` means a genuine failure where it may still be alive. Same shape/
   * contract as `removeProject`'s `killSprite` (machine-projects.ts).
   */
  killSprite: (input: { sandboxId: string; spriteInstanceId: string | null }) => Promise<{ ok: boolean }>;
}

/**
 * Tear down a SNAPSHOT of agent-terminal Sprites BY ID — kill each and CAS-delete
 * its row. Run AFTER the `machine_projects` row is deleted (so the project is
 * non-spawnable), targeting the pre-delete snapshot rather than a post-delete
 * name re-query (finding EE).
 *
 * The CAS delete is generation-guarded on (id, sandboxId, instance): a
 * snapshotted row that was re-provisioned since the snapshot fails the CAS, so
 * its live replacement is left untouched. And a same-name replacement project's
 * terminals are DIFFERENT rows never present in the snapshot, so they are never
 * killed.
 *
 * The row is deleted whether the kill SUCCEEDED or FAILED (finding Z): the project
 * delete sets no `teardownRequestedAt`, so the reconciler's tracking-row arm would
 * not retry a survivor. Deleting routes reclaim through the outbox — on a CONFIRMED
 * kill `removeIfSandbox` drops the redundant pointer; on an UNCONFIRMED kill
 * `removeIfSandboxToReclaim` leaves the pointer the AFTER-DELETE trigger enqueues,
 * so tier-A of the reconciler retries. Per-row isolated: one unreachable Sprite
 * never skips the rest (a THROW leaves the row for a later machine teardown/purge).
 */
export async function teardownAgentTerminalSpriteSnapshot({
  snapshot,
  deps,
}: {
  snapshot: readonly AgentTerminalSpriteRef[];
  deps: TeardownAgentTerminalSnapshotDeps;
}): Promise<void> {
  for (const { id, sandboxId, spriteInstanceId } of snapshot) {
    try {
      const killed = await deps.killSprite({ sandboxId, spriteInstanceId });
      if (killed.ok) {
        await deps.store.removeIfSandbox({ id, sandboxId, spriteInstanceId });
      } else {
        await deps.store.removeIfSandboxToReclaim({ id, sandboxId, spriteInstanceId });
      }
    } catch {
      // Per-row best-effort — one unreachable Sprite must not skip the rest.
    }
  }
}
