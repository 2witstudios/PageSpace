/**
 * Machine Branches: spawn / attach / kill / list branch-terminals of a
 * Project (IO, dependency-injected where it touches the sandbox/DB).
 *
 * "A terminal IS a worktree — an isolated checked-out branch — and each runs
 * in its OWN isolated container" (tasks/terminal.md). On Sprites the
 * container IS the Sprite, so a branch-terminal is a SEPARATE Sprite from the
 * one its owning Machine (`machineId`) or any other branch of the same
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
import { deriveBranchSessionKey, normalizeBranchName } from './branch-session';
import { normalizeProjectName } from './project-paths';
import { isUniqueViolation, type MachineBranchStore, type MachineBranchRecord } from './machine-branches-store';

/** The directory on a branch-terminal's OWN Sprite the project is cloned into. */
export const BRANCH_REPO_PATH = `${SANDBOX_ROOT}/repo`;

export type SpawnBranchDenialReason =
  | 'kill_switch_off'
  | 'project_not_found'
  | 'provision_failed'
  | 'clone_failed'
  | 'checkout_failed'
  | 'error';

export interface MachineActorContext {
  userId: string;
  tenantId: string;
  actorEmail: string;
  actorDisplayName?: string;
  tier: SubscriptionTier;
}

/** The minimal slice of the Projects store Branches needs — just enough to resolve a project's `repoUrl`. */
export interface MachineBranchProjectLookup {
  findByName(machineId: string, name: string): Promise<{ repoUrl: string } | null>;
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
  /** Server-held secret for session-key derivation (same secret as machine-session-manager.ts). */
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
  /** `branchName` is the NORMALIZED name — what was persisted and checked out, which the caller must echo back. */
  | { ok: true; sandboxId: string; branchName: string; resumed: boolean }
  | { ok: false; reason: SpawnBranchDenialReason | FullEgressDenialReason; detail?: string };

/**
 * Exported so other Machine-scope callers that build a `SandboxActorContext`
 * for a branch-terminal op (e.g. `machine-git-blob-runtime.ts`) share this one
 * definition instead of re-typing the same literal — a future required field
 * on `SandboxActorContext` then only needs fixing here.
 */
export function buildActorCtx(scopeKey: string, actor: MachineActorContext): SandboxActorContext {
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
 * Reconcile after losing a provisioning collision (a concurrent `spawnBranch`
 * call for the same branch beat us to persisting a row). `MachineHost.provision`
 * is name-keyed and auto-resumes ("same name, same filesystem" — see
 * `../sandbox/machine-host.ts`), so two concurrent calls deriving the same
 * session key can both end up holding a handle to the SAME physical Sprite —
 * in that case the Sprite must NOT be killed, since it's the one the winner
 * already recorded and is live. Only a genuinely distinct (or absent) tracked
 * Sprite is safe to tear down.
 */
async function reconcileProvisionCollision({
  deps,
  machineId,
  projectName,
  branchName,
  handle,
}: {
  deps: MachineBranchesDeps;
  machineId: string;
  projectName: string;
  branchName: string;
  handle: MachineHandle;
}): Promise<{ ok: true; sandboxId: string; branchName: string; resumed: true } | { row: MachineBranchRecord | null }> {
  const row = await deps.store.findByName(machineId, projectName, branchName);
  if (row && row.sandboxId === handle.machineId) {
    return { ok: true, sandboxId: row.sandboxId, branchName: row.branchName, resumed: true };
  }
  await safeKillSprite(deps.host, handle.machineId);
  return { row };
}

/**
 * Spawn (or resume) a branch-terminal: an isolated Sprite with `branchName`
 * checked out from the named Project. Idempotent by (machineId,
 * projectName, branchName) — a second call reattaches to the same Sprite
 * (or transparently re-provisions under the same name if it has since
 * vanished) instead of creating a duplicate.
 *
 * `branchName` is free text: it is NORMALIZED here (not rejected — see
 * `normalizeBranchName`), and the normalized form is what gets checked out,
 * hashed into the session key, persisted, and returned. This is the
 * authoritative normalization point; any future client-side live preview would
 * be a convenience, never the source of truth.
 */
export async function spawnBranch({
  machineId,
  projectName: requestedProjectName,
  branchName: requestedBranchName,
  actor,
  deps,
}: {
  machineId: string;
  projectName: string;
  branchName: string;
  actor: MachineActorContext;
  deps: MachineBranchesDeps;
}): Promise<SpawnBranchResult> {
  if (!deps.isEnabled()) return { ok: false, reason: 'kill_switch_off' };

  // Both names are free text. `addProject` persists the CANONICAL project name,
  // so the lookup key must be normalized the same way or free text that created
  // a project could never spawn a branch in it. Canonical names (what the UI
  // sends, straight from `listProjects`) pass through unchanged — normalization
  // is idempotent.
  const projectName = normalizeProjectName(requestedProjectName);
  const branchName = normalizeBranchName(requestedBranchName);

  const project = await deps.projectStore.findByName(machineId, projectName);
  if (!project) return { ok: false, reason: 'project_not_found' };

  const enablement = await deps.checkFullEgressEnablement();
  if (!enablement.ok) return enablement;

  const existing = await deps.store.findByName(machineId, projectName, branchName);
  const scopeKey = `${machineId}:${projectName}:${branchName}`;

  if (existing) {
    const handle = await deps.host.attach({ machineId: existing.sandboxId });
    if (handle) return { ok: true, sandboxId: handle.machineId, branchName, resumed: true };
    // Vanished — fall through and re-provision under the SAME session key.
  }

  const sessionKey =
    existing?.sessionKey ??
    deriveBranchSessionKey({ tenantId: actor.tenantId, machineId, projectName, branchName, secret: deps.secret });

  let handle: MachineHandle;
  try {
    handle = await deps.host.provision({ name: sessionKey, substrate: deps.substrate, options: deps.options });
  } catch (error) {
    return { ok: false, reason: 'provision_failed', detail: error instanceof Error ? error.message : String(error) };
  }

  const cloned = await cloneAndCheckoutBranch({ handle, repoUrl: project.repoUrl, branchName, scopeKey, actor, deps });
  if (!cloned.ok) {
    // A concurrent spawnBranch call for this SAME branch may have already won
    // (and may be sharing our exact Sprite — provision is name-keyed/idempotent),
    // in which case our redundant clone/checkout failing (e.g. "dir already
    // exists") doesn't mean the branch-terminal is broken.
    const reconciled = await reconcileProvisionCollision({ deps, machineId, projectName, branchName, handle });
    if ('ok' in reconciled) return reconciled;
    return { ok: false, reason: cloned.reason, detail: cloned.detail };
  }

  if (existing) {
    const updated = await deps.store.updateSandboxId({
      id: existing.id,
      previousSandboxId: existing.sandboxId,
      sandboxId: handle.machineId,
      now: deps.now(),
    });
    if (!updated) {
      // Lost a race against a concurrent re-provision of the same vanished
      // branch — do not silently overwrite; the winner already wrote its own.
      const reconciled = await reconcileProvisionCollision({ deps, machineId, projectName, branchName, handle });
      if ('ok' in reconciled) return reconciled;
      if (reconciled.row) {
        return { ok: true, sandboxId: reconciled.row.sandboxId, branchName: reconciled.row.branchName, resumed: true };
      }
      return { ok: false, reason: 'error', detail: 'lost a concurrent branch-terminal spawn race' };
    }
    return { ok: true, sandboxId: handle.machineId, branchName, resumed: false };
  }

  try {
    await deps.store.create({
      ownerId: actor.userId,
      machineId,
      projectName,
      branchName,
      sessionKey,
      sandboxId: handle.machineId,
      now: deps.now(),
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Lost a race against a concurrent spawn of the same branch.
      const reconciled = await reconcileProvisionCollision({ deps, machineId, projectName, branchName, handle });
      if ('ok' in reconciled) return reconciled;
      if (reconciled.row) {
        return { ok: true, sandboxId: reconciled.row.sandboxId, branchName: reconciled.row.branchName, resumed: true };
      }
    }
    return { ok: false, reason: 'error', detail: error instanceof Error ? error.message : String(error) };
  }

  return { ok: true, sandboxId: handle.machineId, branchName, resumed: false };
}

export type AttachBranchResult =
  | { ok: true; sandboxId: string; branchName: string }
  | { ok: false; reason: 'not_found' | 'vanished' };

/**
 * Reconnect to a branch-terminal's existing Sprite without provisioning a new
 * one. The lookup key is normalized the same way `spawnBranch` normalizes
 * before persisting, so the free text a user typed to create a branch still
 * finds it — and a name read back from `listBranches` (already canonical)
 * passes through untouched, because normalization is idempotent.
 */
export async function attachBranch({
  machineId,
  projectName,
  branchName,
  store,
  host,
}: {
  machineId: string;
  projectName: string;
  branchName: string;
  store: MachineBranchStore;
  host: MachineHost;
}): Promise<AttachBranchResult> {
  const project = normalizeProjectName(projectName);
  const normalized = normalizeBranchName(branchName);
  const existing = await store.findByName(machineId, project, normalized);
  if (!existing) return { ok: false, reason: 'not_found' };

  const handle = await host.attach({ machineId: existing.sandboxId });
  if (!handle) return { ok: false, reason: 'vanished' };
  return { ok: true, sandboxId: handle.machineId, branchName: normalized };
}

/** List a project's branch-terminals. Normalizes the project key like every other name-keyed lookup. */
export async function listBranches({
  machineId,
  projectName,
  store,
}: {
  machineId: string;
  projectName: string;
  store: MachineBranchStore;
}): Promise<MachineBranchRecord[]> {
  return store.list(machineId, normalizeProjectName(projectName));
}

export type KillBranchResult = { ok: true } | { ok: false; reason: 'not_found' | 'error' };

/**
 * Tear down a branch-terminal: DELETE its Sprite through the MachineHost seam
 * and drop the tracking row. Normalizes its lookup key for the same reason
 * `attachBranch` does — whatever text created a branch must also be able to
 * kill it, and a canonical name from `listBranches` passes through unchanged.
 */
export async function killBranch({
  machineId,
  projectName,
  branchName,
  store,
  host,
}: {
  machineId: string;
  projectName: string;
  branchName: string;
  store: MachineBranchStore;
  host: MachineHost;
}): Promise<KillBranchResult> {
  const project = normalizeProjectName(projectName);
  const normalized = normalizeBranchName(branchName);
  const existing = await store.findByName(machineId, project, normalized);
  if (!existing) return { ok: false, reason: 'not_found' };

  try {
    await host.kill({ machineId: existing.sandboxId });
  } catch {
    // Sprite may still be running — keep the tracking row so a retry (or the
    // idle reaper) can still find and reclaim it. An untracked-but-live
    // Sprite would otherwise be an unkillable orphan.
    return { ok: false, reason: 'error' };
  }

  await store.remove(machineId, project, normalized);
  return { ok: true };
}
