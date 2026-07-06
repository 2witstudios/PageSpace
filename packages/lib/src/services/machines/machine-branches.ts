/**
 * Machine Branches: spawn / attach / kill / list branch-terminals of a
 * Project (IO, dependency-injected where it touches the sandbox/DB).
 *
 * "A terminal IS a worktree — an isolated checked-out branch — and each runs
 * in its OWN isolated container" (tasks/terminal.md). On Sprites the
 * container IS the Sprite, so a branch-terminal is a SEPARATE Sprite from the
 * one its owning Machine (`terminalId`) or any other branch of the same
 * Project uses — never a shared filesystem, never a git worktree on a shared
 * checkout. `spawnBranch` provisions that Sprite directly through the
 * `MachineHost` seam (`../sandbox/machine-host.ts`), under a name derived by
 * `deriveBranchSessionKey` — distinct per (tenant, machine, project, branch),
 * so two branches of one project always resolve to two distinct Sprites.
 *
 * Cloning reuses `runGitInSandbox` (the same hardened git execution path the
 * agent's `git_clone` tool and the Projects tier's `addProject` use): the
 * acting user's GitHub token is fetched per-call and injected into the child
 * process env for that one command only, via the existing one-shot
 * credential helper — never written to argv, disk, or persisted git config.
 * Unlike Projects (which acquires the OWNING Machine's persistent session),
 * a branch-terminal's git commands run against the Sprite THIS call just
 * provisioned/attached — `acquireSandbox`/`reconnect` below are bound
 * directly to that handle, never to a page-keyed Machine lookup.
 */

import type { SubscriptionTier } from '../subscription-utils';
import { runGitInSandbox, type GitSandboxRunDeps } from '../sandbox/git-tool-runners';
import type { SandboxActorContext, SandboxQuotaDeps } from '../sandbox/tool-runners';
import { SANDBOX_ROOT } from '../sandbox/sandbox-paths';
import type { MachineHost, MachineHandle, MachineSubstrateSpec } from '../sandbox/machine-host';
import { adaptMachineHandleToExecutableSandbox } from '../sandbox/sandbox-client/machine-host-adapter';
import type { SandboxCreateOptions } from '../sandbox/sandbox-options';
import type { FullEgressEnablement, FullEgressDenialReason } from '../sandbox/containment';
import type { CodeExecutionAuditInput } from '../sandbox/audit';
import { deriveBranchSessionKey, isValidBranchName } from './branch-session';
import { isUniqueViolation, type MachineBranchStore, type MachineBranchRecord } from './machine-branches-store';

/** The directory on a branch-terminal's OWN Sprite the project is cloned into. */
export const BRANCH_REPO_PATH = `${SANDBOX_ROOT}/repo`;

export type SpawnBranchDenialReason =
  | 'invalid_branch_name'
  | 'kill_switch_off'
  | 'project_not_found'
  | 'provision_failed'
  | 'clone_failed'
  | 'checkout_failed'
  | 'error';

/** Pure decision: is this branch name safe to use as a git ref / Sprite name component? */
export function planSpawnBranch(input: { branchName: string }): { ok: true } | { ok: false; reason: 'invalid_branch_name' } {
  if (!isValidBranchName(input.branchName)) return { ok: false, reason: 'invalid_branch_name' };
  return { ok: true };
}

export interface MachineActorContext {
  userId: string;
  tenantId: string;
  actorEmail: string;
  actorDisplayName?: string;
  tier: SubscriptionTier;
}

/** The minimal slice of the Projects store Branches needs — just enough to resolve a project's `repoUrl`. */
export interface MachineBranchProjectLookup {
  findByName(terminalId: string, name: string): Promise<{ repoUrl: string } | null>;
}

export interface MachineBranchesDeps {
  store: MachineBranchStore;
  projectStore: MachineBranchProjectLookup;
  isEnabled: () => boolean;
  now: () => Date;
  /** The provider-neutral Sprite lifecycle seam — see `../sandbox/machine-host.ts`. */
  host: MachineHost;
  substrate: MachineSubstrateSpec;
  options: SandboxCreateOptions;
  /** Server-held secret for session-key derivation (same secret as terminal-session-manager.ts). */
  secret: string;
  /** REQUIRED full-egress enablement gate — a branch-terminal's Sprite runs open egress, same as a human Terminal. */
  checkFullEgressEnablement: () => Promise<FullEgressEnablement>;
  resolveGitHubToken: (userId: string) => Promise<string | null>;
  quota: SandboxQuotaDeps;
  buildEnv: () => Record<string, string>;
  audit: (input: CodeExecutionAuditInput) => Promise<void>;
  screenOutput?: (text: string) => Promise<string>;
}

export type SpawnBranchResult =
  | { ok: true; sandboxId: string; resumed: boolean }
  | { ok: false; reason: SpawnBranchDenialReason | FullEgressDenialReason; detail?: string };

function buildActorCtx(scopeKey: string, actor: MachineActorContext): SandboxActorContext {
  return {
    userId: actor.userId,
    tenantId: actor.tenantId,
    driveId: undefined,
    // See module doc: a branch-terminal op has no conversation, so this
    // opaque scope key (ignored by the acquireSandbox closure below) just
    // satisfies the field.
    conversationId: scopeKey,
    actorEmail: actor.actorEmail,
    actorDisplayName: actor.actorDisplayName,
    tier: actor.tier,
  };
}

/**
 * Build `runGitInSandbox` deps bound directly to an already-provisioned
 * `MachineHandle` — no page-keyed acquire/reconnect lookup, because Branches
 * (unlike Projects) hold the live handle from the moment they provision it.
 */
function buildGitDepsForHandle(handle: MachineHandle, deps: MachineBranchesDeps): GitSandboxRunDeps {
  const sandbox = adaptMachineHandleToExecutableSandbox(handle);
  return {
    isEnabled: deps.isEnabled,
    resolveGitHubToken: deps.resolveGitHubToken,
    acquireSandbox: async () => ({ ok: true, sandboxId: handle.machineId, resumed: false }),
    reconnect: async () => sandbox,
    quota: deps.quota,
    buildEnv: deps.buildEnv,
    audit: deps.audit,
    screenOutput: deps.screenOutput,
    now: deps.now,
  };
}

type CloneResult = { ok: true } | { ok: false; reason: 'clone_failed' | 'checkout_failed'; detail?: string };

async function cloneAndCheckoutBranch({
  handle,
  repoUrl,
  branchName,
  scopeKey,
  actor,
  deps,
}: {
  handle: MachineHandle;
  repoUrl: string;
  branchName: string;
  scopeKey: string;
  actor: MachineActorContext;
  deps: MachineBranchesDeps;
}): Promise<CloneResult> {
  const ctx = buildActorCtx(scopeKey, actor);
  const gitDeps = buildGitDepsForHandle(handle, deps);

  const clone = await runGitInSandbox({ cmd: 'git', args: ['clone', repoUrl, BRANCH_REPO_PATH], ctx, deps: gitDeps });
  if (!clone.success) return { ok: false, reason: 'clone_failed', detail: clone.error };
  if (clone.exitCode !== 0) return { ok: false, reason: 'clone_failed', detail: clone.stderr || clone.stdout };

  // Prefer an existing remote branch; fall back to a fresh local branch off
  // the clone's default HEAD when it doesn't exist upstream yet.
  const checkoutExisting = await runGitInSandbox({
    cmd: 'git',
    args: ['checkout', '-b', branchName, `origin/${branchName}`],
    cwd: BRANCH_REPO_PATH,
    ctx,
    deps: gitDeps,
  });
  if (checkoutExisting.success && checkoutExisting.exitCode === 0) return { ok: true };

  const checkoutNew = await runGitInSandbox({
    cmd: 'git',
    args: ['checkout', '-b', branchName],
    cwd: BRANCH_REPO_PATH,
    ctx,
    deps: gitDeps,
  });
  if (!checkoutNew.success) return { ok: false, reason: 'checkout_failed', detail: checkoutNew.error };
  if (checkoutNew.exitCode !== 0) {
    return { ok: false, reason: 'checkout_failed', detail: checkoutNew.stderr || checkoutNew.stdout };
  }
  return { ok: true };
}

async function safeKillSprite(host: MachineHost, machineId: string): Promise<void> {
  try {
    await host.kill({ machineId });
  } catch {
    // best-effort — a partially-provisioned Sprite that fails to clone is
    // still torn down on a best-effort basis rather than left orphaned.
  }
}

/**
 * Spawn (or resume) a branch-terminal: an isolated Sprite with `branchName`
 * checked out from the named Project. Idempotent by (terminalId,
 * projectName, branchName) — a second call reattaches to the same Sprite
 * (or transparently re-provisions under the same name if it has since
 * vanished) instead of creating a duplicate.
 */
export async function spawnBranch({
  terminalId,
  projectName,
  branchName,
  actor,
  deps,
}: {
  terminalId: string;
  projectName: string;
  branchName: string;
  actor: MachineActorContext;
  deps: MachineBranchesDeps;
}): Promise<SpawnBranchResult> {
  if (!deps.isEnabled()) return { ok: false, reason: 'kill_switch_off' };

  const plan = planSpawnBranch({ branchName });
  if (!plan.ok) return plan;

  const project = await deps.projectStore.findByName(terminalId, projectName);
  if (!project) return { ok: false, reason: 'project_not_found' };

  const enablement = await deps.checkFullEgressEnablement();
  if (!enablement.ok) return enablement;

  const existing = await deps.store.findByName(terminalId, projectName, branchName);
  const scopeKey = `${terminalId}:${projectName}:${branchName}`;

  if (existing) {
    const handle = await deps.host.attach({ machineId: existing.sandboxId });
    if (handle) return { ok: true, sandboxId: handle.machineId, resumed: true };
    // Vanished — fall through and re-provision under the SAME session key.
  }

  const sessionKey =
    existing?.sessionKey ??
    deriveBranchSessionKey({ tenantId: actor.tenantId, terminalId, projectName, branchName, secret: deps.secret });

  let handle: MachineHandle;
  try {
    handle = await deps.host.provision({ name: sessionKey, substrate: deps.substrate, options: deps.options });
  } catch (error) {
    return { ok: false, reason: 'provision_failed', detail: error instanceof Error ? error.message : String(error) };
  }

  const cloned = await cloneAndCheckoutBranch({ handle, repoUrl: project.repoUrl, branchName, scopeKey, actor, deps });
  if (!cloned.ok) {
    await safeKillSprite(deps.host, handle.machineId);
    return { ok: false, reason: cloned.reason, detail: cloned.detail };
  }

  try {
    if (existing) {
      await deps.store.updateSandboxId({ id: existing.id, sandboxId: handle.machineId, now: deps.now() });
    } else {
      await deps.store.create({
        ownerId: actor.userId,
        terminalId,
        projectName,
        branchName,
        sessionKey,
        sandboxId: handle.machineId,
        now: deps.now(),
      });
    }
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Lost a race against a concurrent spawn of the same branch — the
      // Sprite we just provisioned is redundant, not orphaned state.
      await safeKillSprite(deps.host, handle.machineId);
      const winner = await deps.store.findByName(terminalId, projectName, branchName);
      if (winner) return { ok: true, sandboxId: winner.sandboxId, resumed: true };
    }
    return { ok: false, reason: 'error', detail: error instanceof Error ? error.message : String(error) };
  }

  return { ok: true, sandboxId: handle.machineId, resumed: false };
}

export type AttachBranchResult =
  | { ok: true; sandboxId: string }
  | { ok: false; reason: 'not_found' | 'vanished' };

/** Reconnect to a branch-terminal's existing Sprite without provisioning a new one. */
export async function attachBranch({
  terminalId,
  projectName,
  branchName,
  store,
  host,
}: {
  terminalId: string;
  projectName: string;
  branchName: string;
  store: MachineBranchStore;
  host: MachineHost;
}): Promise<AttachBranchResult> {
  const existing = await store.findByName(terminalId, projectName, branchName);
  if (!existing) return { ok: false, reason: 'not_found' };

  const handle = await host.attach({ machineId: existing.sandboxId });
  if (!handle) return { ok: false, reason: 'vanished' };
  return { ok: true, sandboxId: handle.machineId };
}

export async function listBranches({
  terminalId,
  projectName,
  store,
}: {
  terminalId: string;
  projectName: string;
  store: MachineBranchStore;
}): Promise<MachineBranchRecord[]> {
  return store.list(terminalId, projectName);
}

export type KillBranchResult = { ok: true } | { ok: false; reason: 'not_found' | 'error' };

/** Tear down a branch-terminal: DELETE its Sprite through the MachineHost seam and drop the tracking row. */
export async function killBranch({
  terminalId,
  projectName,
  branchName,
  store,
  host,
}: {
  terminalId: string;
  projectName: string;
  branchName: string;
  store: MachineBranchStore;
  host: MachineHost;
}): Promise<KillBranchResult> {
  const existing = await store.findByName(terminalId, projectName, branchName);
  if (!existing) return { ok: false, reason: 'not_found' };

  try {
    await host.kill({ machineId: existing.sandboxId });
  } catch {
    // Sprite may still be running — keep the tracking row so a retry (or the
    // idle reaper) can still find and reclaim it. An untracked-but-live
    // Sprite would otherwise be an unkillable orphan.
    return { ok: false, reason: 'error' };
  }

  await store.remove(terminalId, projectName, branchName);
  return { ok: true };
}
