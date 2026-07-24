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
import type { MachineAgentTerminalRecord } from './agent-terminals-store';

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
}

export type ProvisionAgentTerminalSpriteResult =
  | { ok: true; sandboxId: string; resumed: boolean }
  | { ok: false; reason: 'egress_denied' | 'project_not_found' | 'branch_not_found' | 'provision_failed' | 'clone_failed' | 'race_lost'; detail?: string };

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

  // Clone per scope. On failure, kill the VM we just provisioned — a Sprite with
  // no live sandboxId on its row is an unreferenced billing orphan.
  if (row.machineBranchId && repoUrl && branchName) {
    const cloned = await cloneAndCheckoutBranch({ handle, repoUrl, branchName, scopeKey, actor, deps });
    if (!cloned.ok) {
      await safeKillSprite(deps.host, handle);
      return { ok: false, reason: 'clone_failed', detail: cloned.detail };
    }
  } else if (row.projectName && repoUrl) {
    const cloned = await cloneRepoInto({ handle, repoUrl, targetPath: PROJECT_REPO_PATH, scopeKey, actor, deps });
    if (!cloned.ok) {
      await safeKillSprite(deps.host, handle);
      return { ok: false, reason: 'clone_failed', detail: cloned.detail };
    }
  }
  // machine scope: no clone — cwd is the Sprite home (SANDBOX_ROOT).

  // Persist the identity FIRST (before the credential copy), under a CAS on the
  // row's CURRENT sandboxId — so a concurrent provision of the same
  // unprovisioned row cannot both win. The loser kills its now-redundant Sprite.
  const recorded = await deps.updateSpriteIdentity({
    id: row.id,
    previousSandboxId: row.sandboxId,
    sessionKey,
    sandboxId: handle.machineId,
    spriteInstanceId: handle.spriteInstanceId ?? null,
    egressPolicyToken: handle.egressPolicyToken ?? null,
    now: deps.now(),
  });
  if (!recorded) {
    // Another provision recorded a Sprite for this row first. Ours is redundant.
    // If the winner shares our exact (name-keyed) Sprite, killing by instance id
    // would be a no-op guard; if it is a different VM, ours must die.
    await safeKillSprite(deps.host, handle);
    return { ok: false, reason: 'race_lost' };
  }

  // Copy the Claude Code credential FROM the owning Machine's root Sprite — the
  // login anchor — exactly as spawnBranch does. Best-effort inside.
  await propagateClaudeCredential({
    machineId: row.machineId,
    branchHandle: handle,
    resolveRootMachineHandle: deps.resolveRootMachineHandle,
  });

  return { ok: true, sandboxId: handle.machineId, resumed: false };
}
