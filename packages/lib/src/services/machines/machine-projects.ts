/**
 * Machine Projects: add / list / remove git repos on a Machine's persistent
 * filesystem (IO, dependency-injected where it touches the sandbox/DB).
 *
 * A Machine's identity is its backing page (`machineId`) — the SAME page
 * whose persistent Sprite session (`machine_sessions`, see
 * services/sandbox/machine-session-manager.ts) a live Terminal shell, or a
 * page-agent's "own machine" tool calls (services/sandbox/machine-session.ts),
 * already reconnects to. `addProject` acquires and execs against that exact
 * session (via the injected `acquireMachineSandbox`/`reconnect`, which
 * production wiring binds through the MachineHost seam — see
 * sandbox-client/sprite-machine-host.ts / machine-host-adapter.ts) so a
 * cloned repo shows up in the same filesystem the human/agent already sees.
 *
 * `addProject` clones through `runGitInSandbox` — the SAME hardened git
 * execution path the agent's `git_clone` tool uses (packages/lib/src/
 * services/sandbox/git-tool-runners.ts): the acting user's GitHub token is
 * fetched per-call and injected into the child process's env only for that
 * one command, via a one-shot credential helper — never written to argv,
 * never persisted to the machine's disk or git config. `runGitInSandbox`
 * itself is unmodified; only its `acquireSandbox`/`reconnect` deps are bound
 * here to the target machine.
 *
 * `SandboxActorContext.conversationId` is a required field designed around
 * conversation-scoped sandboxes; a Machine op has no conversation, so it is
 * repurposed here as an opaque scope key (the machineId) that the injected
 * `acquireSandbox` closure ignores in favor of the actual bound machine —
 * documented at the call site below.
 */

import type { SubscriptionTier } from '../subscription-utils';
import { runGitInSandbox, type GitSandboxRunDeps } from '../sandbox/git-tool-runners';
import type { SandboxActorContext, SandboxQuotaDeps } from '../sandbox/tool-runners';
import { SANDBOX_TIMEOUT_MS, SANDBOX_MAX_OUTPUT_BYTES } from '../sandbox/execution-policy';
import type { ExecutableSandbox } from '../sandbox/sandbox-client/types';
import type { CodeExecutionAuditInput } from '../sandbox/audit';
import { resolveProjectPath, isValidRepoUrl, normalizeProjectName } from './project-paths';
import { isUniqueViolation, type MachineProjectStore, type MachineProjectRecord } from './machine-projects-store';

export type AddProjectDenialReason = 'invalid_name' | 'invalid_repo_url' | 'duplicate_name';

/**
 * Pure decision: is this (name, repoUrl) addable to a machine with these
 * existing project names? The name is free text — it is NORMALIZED into a
 * directory-safe slug rather than rejected (`normalizeProjectName`), and the
 * normalized form is what the duplicate check, the clone path, and the
 * persisted row all use. The repo URL still rejects, since there is no
 * meaningful way to normalize a non-HTTPS remote into an HTTPS one.
 */
export function planAddProject({
  name,
  repoUrl,
  existingNames,
}: {
  name: string;
  repoUrl: string;
  existingNames: string[];
}): { ok: true; name: string; path: string } | { ok: false; reason: AddProjectDenialReason } {
  if (!isValidRepoUrl(repoUrl)) return { ok: false, reason: 'invalid_repo_url' };

  const normalized = normalizeProjectName(name);
  // Unreachable given the normalizer's invariant (its output always satisfies
  // `isValidProjectName`); kept as the second confinement gate, so a regression
  // in either the normalizer or `resolvePathWithinSync` fails closed here
  // rather than escaping PROJECTS_ROOT.
  const path = resolveProjectPath(normalized);
  if (!path) return { ok: false, reason: 'invalid_name' };

  if (existingNames.includes(normalized)) return { ok: false, reason: 'duplicate_name' };
  return { ok: true, name: normalized, path };
}

export interface MachineActorContext {
  userId: string;
  tenantId: string;
  actorEmail: string;
  actorDisplayName?: string;
  tier: SubscriptionTier;
}

export type MachineAcquireResult =
  | { ok: true; sandboxId: string; resumed: boolean }
  | { ok: false; reason: string; cause?: unknown };

export interface MachineProjectsDeps {
  store: MachineProjectStore;
  isEnabled: () => boolean;
  now: () => Date;
  /** Acquire a live, authorized sandbox for this machine's backing page — pre-bound to tenant/owner/canRun by the caller. */
  acquireMachineSandbox: (machineId: string) => Promise<MachineAcquireResult>;
  reconnect: (sandboxId: string) => Promise<ExecutableSandbox | null>;
  resolveGitHubToken: (userId: string) => Promise<string | null>;
  quota: SandboxQuotaDeps;
  buildEnv: () => Record<string, string>;
  audit: (input: CodeExecutionAuditInput) => Promise<void>;
  screenOutput?: (text: string) => Promise<string>;
}

function buildGitRunDeps(machineId: string, deps: MachineProjectsDeps): GitSandboxRunDeps {
  return {
    isEnabled: deps.isEnabled,
    resolveGitHubToken: deps.resolveGitHubToken,
    acquireSandbox: async () => {
      const result = await deps.acquireMachineSandbox(machineId);
      if (!result.ok) return { ok: false, reason: 'provision_failed' };
      return { ok: true, sandboxId: result.sandboxId, resumed: result.resumed };
    },
    reconnect: deps.reconnect,
    quota: deps.quota,
    buildEnv: deps.buildEnv,
    audit: deps.audit,
    screenOutput: deps.screenOutput,
    now: deps.now,
  };
}

function buildCtx(machineId: string, actor: MachineActorContext): SandboxActorContext {
  return {
    userId: actor.userId,
    tenantId: actor.tenantId,
    driveId: undefined,
    // See module doc: a Machine op has no conversation, so this opaque scope
    // key (ignored by the acquireSandbox closure above) just satisfies the field.
    conversationId: machineId,
    actorEmail: actor.actorEmail,
    actorDisplayName: actor.actorDisplayName,
    tier: actor.tier,
  };
}

// Best-effort: remove a directory from the machine's filesystem. Never
// throws — used both to clean up a failed/partial clone and to remove a
// project's checkout on `removeProject`.
async function safeRemoveDirectory(
  machineId: string,
  path: string,
  deps: MachineProjectsDeps,
): Promise<void> {
  try {
    const acquired = await deps.acquireMachineSandbox(machineId);
    if (!acquired.ok) return;
    const sandbox = await deps.reconnect(acquired.sandboxId);
    if (!sandbox) return;
    await sandbox.runCommand({
      cmd: 'rm',
      args: ['-rf', path],
      timeoutMs: SANDBOX_TIMEOUT_MS,
      maxBytes: SANDBOX_MAX_OUTPUT_BYTES,
    });
  } catch {
    // best-effort
  }
}

export type AddProjectResult =
  | { ok: true; project: MachineProjectRecord }
  | { ok: false; reason: AddProjectDenialReason | 'kill_switch_off' | 'clone_failed' | 'error'; detail?: string };

export async function addProject({
  machineId,
  actor,
  name,
  repoUrl,
  deps,
}: {
  machineId: string;
  actor: MachineActorContext;
  name: string;
  repoUrl: string;
  deps: MachineProjectsDeps;
}): Promise<AddProjectResult> {
  if (!deps.isEnabled()) return { ok: false, reason: 'kill_switch_off' };

  const existing = await deps.store.list(machineId);
  const plan = planAddProject({ name, repoUrl, existingNames: existing.map((p) => p.name) });
  if (!plan.ok) return plan;

  // RESERVE THE NAME BEFORE CLONING. The unique constraint on (machineId, name)
  // is what makes two concurrent adds safe: the loser fails right here, instantly,
  // and never touches the filesystem — so it cannot delete the winner's checkout.
  //
  // Reserving AFTER the clone (as this used to) could not be made safe by any
  // amount of checking: the winner's row only lands once its clone finishes,
  // while the loser's clone fails the moment the directory appears, so the loser
  // looked for a winner's row that did not exist yet, saw none, and `rm -rf`'d the
  // winner's freshly cloned files out from under them — leaving a project row
  // pointing at an empty directory. Normalization widens that race from "same
  // text" to "same slug", so it is no longer only reachable by two callers typing
  // byte-identical names.
  //
  // The cost is a row that exists for the duration of the clone. That is the
  // right trade: a row with no directory is visible and deletable, whereas a
  // directory with no row is an orphan nobody can reach.
  let project: MachineProjectRecord;
  try {
    project = await deps.store.create({
      ownerId: actor.userId,
      machineId,
      // The normalized name — never the raw text the caller typed. Persisting
      // anything else would desync the row from the directory we are about to clone.
      name: plan.name,
      repoUrl,
      path: plan.path,
      now: deps.now(),
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: 'duplicate_name' };
    return { ok: false, reason: 'error', detail: error instanceof Error ? error.message : String(error) };
  }

  const ctx = buildCtx(machineId, actor);
  const gitDeps = buildGitRunDeps(machineId, deps);

  const result = await runGitInSandbox({
    cmd: 'git',
    args: ['clone', repoUrl, plan.path],
    ctx,
    deps: gitDeps,
  });

  if (!result.success || result.exitCode !== 0) {
    const detail = result.success ? result.stderr || result.stdout : result.error;

    // Roll back only what is STILL OURS. Reserving the name made the row visible
    // for the whole clone, which means the user can now delete the project
    // mid-clone (clones take seconds to minutes — an impatient click is plausible)
    // and immediately re-add it. The row and directory under this name would then
    // belong to that NEW add, and cleaning up by name — as `removeProject` and
    // `safeRemoveDirectory` both do — would `rm -rf` a checkout we do not own and
    // delete a row we did not write. So compare row identity first, and if the
    // reservation is no longer ours, touch nothing.
    const current = await deps.store.findByName(machineId, plan.name);
    if (!current || current.id !== project.id) {
      return { ok: false, reason: 'clone_failed', detail };
    }

    await safeRemoveDirectory(machineId, plan.path, deps);
    try {
      await deps.store.remove(machineId, plan.name);
    } catch {
      // Best-effort: a stranded row is recoverable (the user can delete it); a
      // failure to report the clone error is not.
    }
    return { ok: false, reason: 'clone_failed', detail };
  }

  return { ok: true, project };
}

export async function listProjects({
  machineId,
  store,
}: {
  machineId: string;
  store: MachineProjectStore;
}): Promise<MachineProjectRecord[]> {
  return store.list(machineId);
}

export type RemoveProjectResult = { ok: true } | { ok: false; reason: 'not_found' | 'error' };

/**
 * Remove a project. Normalizes its lookup key for the same reason
 * `attachBranch`/`killBranch` do: `addProject` persists the CANONICAL name, so
 * whatever free text created a project must also be able to delete it. A name
 * read back from `listProjects` is already canonical and passes through
 * unchanged, because normalization is idempotent.
 */
export async function removeProject({
  machineId,
  name,
  deps,
}: {
  machineId: string;
  name: string;
  deps: MachineProjectsDeps;
}): Promise<RemoveProjectResult> {
  const normalized = normalizeProjectName(name);
  const existing = await deps.store.findByName(machineId, normalized);
  if (!existing) return { ok: false, reason: 'not_found' };

  // Best-effort filesystem cleanup — the tracking row is removed regardless of
  // whether `rm -rf` succeeds, since the user asked for the project gone from
  // their list; a lingering directory is far less surprising than a project
  // the user can never remove because the machine is briefly unreachable.
  await safeRemoveDirectory(machineId, existing.path, deps);

  try {
    await deps.store.remove(machineId, normalized);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'error' };
  }
}
