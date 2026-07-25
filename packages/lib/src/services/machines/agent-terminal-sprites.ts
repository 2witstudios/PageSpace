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
 * and no billing VM is ever left unreferenced (every failure after a successful
 * provision kills the Sprite via `safeKillSprite`).
 */

import type { MachineHandle, MachineHost, MachineSubstrateSpec } from '../sandbox/machine-host';
import type { SandboxCreateOptions } from '../sandbox/sandbox-options';
import type { FullEgressEnablement } from '../sandbox/containment';
import { PROJECT_REPO_PATH } from '../sandbox/sandbox-paths';
import {
  cloneAndCheckoutBranch,
  cloneRepoInto,
  propagateClaudeCredential,
  safeKillSprite,
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
   * Re-read the row's persisted Sprite pointer, to RECONCILE a lost provisioning
   * race against the winner BEFORE killing — the agent-terminal twin of
   * `reconcileProvisionCollision` (machine-branches.ts). `MachineHost.provision`
   * is name-keyed, so two concurrent provisions of the same unprovisioned row
   * (same derived key) can hold the SAME physical Sprite; the CAS loser must not
   * kill the very VM the winner just recorded.
   */
  reloadRow: (id: string) => Promise<{ sandboxId: string | null } | null>;
  /** The provider-neutral Sprite lifecycle seam. */
  host: MachineHost;
  substrate: MachineSubstrateSpec;
  options: SandboxCreateOptions;
  /** Server-held secret for Sprite-key derivation (same secret as machine-session-manager.ts). */
  secret: string;
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
 * Reconcile against the persisted row BEFORE killing a Sprite we hold, at ANY
 * post-provision failure site (a failed clone, a failed/lost persist).
 *
 * `MachineHost.provision` is name-keyed on the row's deterministic session key,
 * so a concurrent provision of the SAME row can hand BOTH callers the SAME
 * physical Sprite. Every `safeKillSprite(handle)` that fires after a successful
 * provision is therefore unsafe on its own: if a concurrent WINNER already
 * recorded that shared Sprite on the row, `safeKillSprite` — which passes our
 * `spriteInstanceId`, the SAME instance the winner recorded — would DESTROY the
 * winner's live, referenced VM, leaving the row pointing at a dead Sprite.
 *
 * So: reload the persisted winner first. If the row now points at a live Sprite,
 * the session is usable and ours must NOT be destroyed — the caller resumes
 * against it (`kind: 'resumed'`). Only a genuinely unreferenced Sprite — no
 * winner pointer at all, or a different-named VM recorded under this row (a
 * theoretical case, since the name is deterministic per row) — is killed
 * (`kind: 'killed'`), after which the caller reports its own specific failure.
 *
 * This is the single reconcile-before-kill the CAS-loss path introduced (finding
 * 1), lifted so every kill site shares it (the whole class Codex flagged: branch
 * clone-fail, project clone-fail, and the persist-throw path all had the same
 * bug).
 */
async function reconcileBeforeKill({
  deps,
  row,
  handle,
}: {
  deps: Pick<AgentTerminalSpriteProvisionDeps, 'reloadRow' | 'host'>;
  row: Pick<MachineAgentTerminalRecord, 'id'>;
  handle: MachineHandle;
}): Promise<{ kind: 'resumed'; sandboxId: string } | { kind: 'killed' }> {
  const winner = await deps.reloadRow(row.id);
  if (winner?.sandboxId) {
    if (winner.sandboxId !== handle.machineId) {
      // A genuinely distinct VM is recorded under this row — ours is redundant
      // and unreferenced, so it is safe to destroy.
      await safeKillSprite(deps.host, handle);
    }
    // else: the winner recorded the very (shared, name-keyed) Sprite we hold —
    // it is LIVE and REFERENCED; must NOT kill. Either way the row points at a
    // live Sprite, so the session is usable — resume against it.
    return { kind: 'resumed', sandboxId: winner.sandboxId };
  }
  // No winner pointer to reconcile against — ours is the only (unreferenced)
  // candidate, and it failed. Kill it rather than leak a billing VM.
  await safeKillSprite(deps.host, handle);
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

/** The store slice `teardownProjectAgentTerminalSprites` needs — enumerate a scope's rows and CAS-delete one. */
export interface TeardownProjectAgentTerminalsDeps {
  store: Pick<MachineAgentTerminalStore, 'list' | 'removeIfSandbox'>;
  /**
   * Identity-guarded kill of a session's OWN Sprite. `ok: true` means the target
   * is CONFIRMED gone (killed, or a replacement already took its name); `ok:
   * false` means a genuine failure where it may still be alive. Same shape/
   * contract as `removeProject`'s `killSprite` (machine-projects.ts).
   */
  killSprite: (input: { sandboxId: string; spriteInstanceId: string | null }) => Promise<{ ok: boolean }>;
}

/**
 * Tear down the OWN Sprites of a project's PROJECT-SCOPED agent terminals when
 * the project is removed.
 *
 * A project-scoped `machine_agent_terminals` row links to its project only by
 * `projectName` TEXT (no FK), so — unlike a BRANCH-scoped row, whose
 * `machineBranchId` FK cascades on branch deletion and whose Sprite pointer the
 * AFTER-DELETE reclaim trigger then rescues — it does NOT cascade when the
 * `machine_projects` row is deleted. Without this, removing a project strands its
 * sessions' live, billed Sprites, and a recreated same-name project could resume
 * a stale terminal row against its old checkout.
 *
 * Mirrors `removeProject`'s own-Sprite teardown and `killOwnSprite`: an
 * identity-guarded kill (via `killSprite`, best-effort), then a CAS delete
 * (`removeIfSandbox`) that BOTH prevents a stale resume (the row is gone) AND is
 * generation-safe — a row whose Sprite was re-provisioned since we listed it
 * fails the CAS, so its live replacement is left untouched. A genuine kill
 * failure leaves the row for a later machine teardown/purge to reclaim
 * (`teardownOneMachine` enumerates every live-Sprite session), the same contract
 * as `killOwnSprite`. Per-row isolated: one unreachable Sprite never skips the rest.
 */
export async function teardownProjectAgentTerminalSprites({
  machineId,
  projectName,
  deps,
}: {
  machineId: string;
  projectName: string;
  deps: TeardownProjectAgentTerminalsDeps;
}): Promise<void> {
  const rows = await deps.store.list({ machineId, projectName, machineBranchId: null });
  for (const row of rows) {
    // Only rows with a live Sprite of their OWN: a legacy/unprovisioned row has
    // nothing to kill, a torn-down one is already gone.
    if (!row.sandboxId || row.spriteTornDownAt) continue;
    try {
      const killed = await deps.killSprite({ sandboxId: row.sandboxId, spriteInstanceId: row.spriteInstanceId });
      if (killed.ok) {
        await deps.store.removeIfSandbox({
          id: row.id,
          sandboxId: row.sandboxId,
          spriteInstanceId: row.spriteInstanceId,
        });
      }
      // else: genuine kill failure — leave the row (its Sprite may still be alive);
      // a later machine teardown/purge reclaims it.
    } catch {
      // Per-row best-effort — one unreachable Sprite must not skip the rest.
    }
  }
}
