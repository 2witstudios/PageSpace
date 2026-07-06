/**
 * Machine Projects: add / list / remove git repos on a Machine's persistent
 * filesystem (IO, dependency-injected where it touches the sandbox/DB).
 *
 * `addProject` clones through `runGitInSandbox` — the SAME hardened git
 * execution path the agent's `git_clone` tool uses (packages/lib/src/
 * services/sandbox/git-tool-runners.ts): the acting user's GitHub token is
 * fetched per-call and injected into the child process's env only for that
 * one command, via a one-shot credential helper — never written to argv,
 * never persisted to the machine's disk or git config. `runGitInSandbox`
 * itself is unmodified; only its `acquireSandbox`/`reconnect` deps are bound
 * here to a MACHINE (via machine-session-manager.ts) instead of a
 * conversation.
 *
 * `SandboxActorContext.conversationId` is a required field designed around
 * conversation-scoped sandboxes; Machines have no conversation, so it is
 * repurposed here as an opaque scope key (the machine key) that the injected
 * `acquireSandbox` closure ignores in favor of the actual target machine —
 * documented at the call site below.
 */

import type { SubscriptionTier } from '../subscription-utils';
import { runGitInSandbox, type GitSandboxRunDeps } from '../sandbox/git-tool-runners';
import type { SandboxActorContext, SandboxQuotaDeps } from '../sandbox/tool-runners';
import { SANDBOX_TIMEOUT_MS, SANDBOX_MAX_OUTPUT_BYTES } from '../sandbox/execution-policy';
import type { ExecutableSandbox } from '../sandbox/sandbox-client/types';
import type { CodeExecutionAuditInput } from '../sandbox/audit';
import type { AcquireMachineSandboxResult } from './machine-session-manager';
import { deriveMachineKey, type MachineIdentity } from './machine-identity';
import { resolveProjectPath, isValidRepoUrl } from './project-paths';
import { isUniqueViolation, type MachineProjectStore, type MachineProjectRecord } from './machine-projects-store';

export type AddProjectDenialReason = 'invalid_name' | 'invalid_repo_url' | 'duplicate_name';

/** Pure decision: is this (name, repoUrl) addable to a machine with these existing project names? */
export function planAddProject({
  name,
  repoUrl,
  existingNames,
}: {
  name: string;
  repoUrl: string;
  existingNames: string[];
}): { ok: true; path: string } | { ok: false; reason: AddProjectDenialReason } {
  if (!isValidRepoUrl(repoUrl)) return { ok: false, reason: 'invalid_repo_url' };
  const path = resolveProjectPath(name);
  if (!path) return { ok: false, reason: 'invalid_name' };
  if (existingNames.includes(name)) return { ok: false, reason: 'duplicate_name' };
  return { ok: true, path };
}

export interface MachineActorContext {
  userId: string;
  tenantId: string;
  actorEmail: string;
  actorDisplayName?: string;
  tier: SubscriptionTier;
}

export interface MachineProjectsDeps {
  store: MachineProjectStore;
  isEnabled: () => boolean;
  now: () => Date;
  /** Acquire a live, authorized sandbox for this machine (see machine-session-manager.ts#acquireMachineSandbox), pre-bound to tenant/owner/canRun by the caller. */
  acquireMachineSandbox: (machine: MachineIdentity) => Promise<AcquireMachineSandboxResult>;
  reconnect: (sandboxId: string) => Promise<ExecutableSandbox | null>;
  resolveGitHubToken: (userId: string) => Promise<string | null>;
  quota: SandboxQuotaDeps;
  buildEnv: () => Record<string, string>;
  audit: (input: CodeExecutionAuditInput) => Promise<void>;
  screenOutput?: (text: string) => Promise<string>;
}

function buildGitRunDeps(machine: MachineIdentity, deps: MachineProjectsDeps): GitSandboxRunDeps {
  return {
    isEnabled: deps.isEnabled,
    resolveGitHubToken: deps.resolveGitHubToken,
    acquireSandbox: async () => {
      const result = await deps.acquireMachineSandbox(machine);
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

function buildCtx(machine: MachineIdentity, actor: MachineActorContext): SandboxActorContext {
  return {
    userId: actor.userId,
    tenantId: actor.tenantId,
    driveId: undefined,
    // See module doc: Machines have no conversation, so this opaque scope key
    // (ignored by the acquireSandbox closure above) just satisfies the field.
    conversationId: deriveMachineKey(machine),
    actorEmail: actor.actorEmail,
    actorDisplayName: actor.actorDisplayName,
    tier: actor.tier,
  };
}

// Best-effort: remove a directory from the machine's filesystem. Never
// throws — used both to clean up a failed/partial clone and to remove a
// project's checkout on `removeProject`.
async function safeRemoveDirectory(
  machine: MachineIdentity,
  path: string,
  deps: MachineProjectsDeps,
): Promise<void> {
  try {
    const acquired = await deps.acquireMachineSandbox(machine);
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
  machine,
  actor,
  name,
  repoUrl,
  deps,
}: {
  machine: MachineIdentity;
  actor: MachineActorContext;
  name: string;
  repoUrl: string;
  deps: MachineProjectsDeps;
}): Promise<AddProjectResult> {
  if (!deps.isEnabled()) return { ok: false, reason: 'kill_switch_off' };

  const machineKey = deriveMachineKey(machine);
  const existing = await deps.store.list(machineKey);
  const plan = planAddProject({ name, repoUrl, existingNames: existing.map((p) => p.name) });
  if (!plan.ok) return plan;

  const ctx = buildCtx(machine, actor);
  const gitDeps = buildGitRunDeps(machine, deps);

  const result = await runGitInSandbox({
    cmd: 'git',
    args: ['clone', repoUrl, plan.path],
    ctx,
    deps: gitDeps,
  });

  if (!result.success) {
    return { ok: false, reason: 'clone_failed', detail: result.error };
  }
  if (result.exitCode !== 0) {
    await safeRemoveDirectory(machine, plan.path, deps);
    return { ok: false, reason: 'clone_failed', detail: result.stderr || result.stdout };
  }

  try {
    const project = await deps.store.create({
      ownerId: actor.userId,
      machineKind: machine.kind,
      terminalId: machine.kind === 'existing' ? machine.terminalId : null,
      machineKey,
      name,
      repoUrl,
      path: plan.path,
      now: deps.now(),
    });
    return { ok: true, project };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, reason: 'duplicate_name' };
    return { ok: false, reason: 'error', detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function listProjects({
  machine,
  store,
}: {
  machine: MachineIdentity;
  store: MachineProjectStore;
}): Promise<MachineProjectRecord[]> {
  return store.list(deriveMachineKey(machine));
}

export type RemoveProjectResult = { ok: true } | { ok: false; reason: 'not_found' | 'error' };

export async function removeProject({
  machine,
  name,
  deps,
}: {
  machine: MachineIdentity;
  name: string;
  deps: MachineProjectsDeps;
}): Promise<RemoveProjectResult> {
  const machineKey = deriveMachineKey(machine);
  const existing = await deps.store.findByName(machineKey, name);
  if (!existing) return { ok: false, reason: 'not_found' };

  // Best-effort filesystem cleanup — the tracking row is removed regardless of
  // whether `rm -rf` succeeds, since the user asked for the project gone from
  // their list; a lingering directory is far less surprising than a project
  // the user can never remove because the machine is briefly unreachable.
  await safeRemoveDirectory(machine, existing.path, deps);

  try {
    await deps.store.remove(machineKey, name);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'error' };
  }
}
