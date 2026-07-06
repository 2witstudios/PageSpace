/**
 * Machine Projects: add / list / remove git repos on a Machine's persistent
 * filesystem (IO, dependency-injected where it touches the sandbox/DB).
 *
 * A Machine's identity is its backing page (`terminalId`) — the SAME page
 * whose persistent Sprite session (`terminal_sessions`, see
 * services/sandbox/terminal-session-manager.ts) a live Terminal shell, or a
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
 * repurposed here as an opaque scope key (the terminalId) that the injected
 * `acquireSandbox` closure ignores in favor of the actual bound machine —
 * documented at the call site below.
 */

import type { SubscriptionTier } from '../subscription-utils';
import { runGitInSandbox, type GitSandboxRunDeps } from '../sandbox/git-tool-runners';
import type { SandboxActorContext, SandboxQuotaDeps } from '../sandbox/tool-runners';
import { SANDBOX_TIMEOUT_MS, SANDBOX_MAX_OUTPUT_BYTES } from '../sandbox/execution-policy';
import type { ExecutableSandbox } from '../sandbox/sandbox-client/types';
import type { CodeExecutionAuditInput } from '../sandbox/audit';
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

export type MachineAcquireResult =
  | { ok: true; sandboxId: string; resumed: boolean }
  | { ok: false; reason: string; cause?: unknown };

export interface MachineProjectsDeps {
  store: MachineProjectStore;
  isEnabled: () => boolean;
  now: () => Date;
  /** Acquire a live, authorized sandbox for this machine's backing page — pre-bound to tenant/owner/canRun by the caller. */
  acquireMachineSandbox: (terminalId: string) => Promise<MachineAcquireResult>;
  reconnect: (sandboxId: string) => Promise<ExecutableSandbox | null>;
  resolveGitHubToken: (userId: string) => Promise<string | null>;
  quota: SandboxQuotaDeps;
  buildEnv: () => Record<string, string>;
  audit: (input: CodeExecutionAuditInput) => Promise<void>;
  screenOutput?: (text: string) => Promise<string>;
}

function buildGitRunDeps(terminalId: string, deps: MachineProjectsDeps): GitSandboxRunDeps {
  return {
    isEnabled: deps.isEnabled,
    resolveGitHubToken: deps.resolveGitHubToken,
    acquireSandbox: async () => {
      const result = await deps.acquireMachineSandbox(terminalId);
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

function buildCtx(terminalId: string, actor: MachineActorContext): SandboxActorContext {
  return {
    userId: actor.userId,
    tenantId: actor.tenantId,
    driveId: undefined,
    // See module doc: a Machine op has no conversation, so this opaque scope
    // key (ignored by the acquireSandbox closure above) just satisfies the field.
    conversationId: terminalId,
    actorEmail: actor.actorEmail,
    actorDisplayName: actor.actorDisplayName,
    tier: actor.tier,
  };
}

// Best-effort: remove a directory from the machine's filesystem. Never
// throws — used both to clean up a failed/partial clone and to remove a
// project's checkout on `removeProject`.
async function safeRemoveDirectory(
  terminalId: string,
  path: string,
  deps: MachineProjectsDeps,
): Promise<void> {
  try {
    const acquired = await deps.acquireMachineSandbox(terminalId);
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
  terminalId,
  actor,
  name,
  repoUrl,
  deps,
}: {
  terminalId: string;
  actor: MachineActorContext;
  name: string;
  repoUrl: string;
  deps: MachineProjectsDeps;
}): Promise<AddProjectResult> {
  if (!deps.isEnabled()) return { ok: false, reason: 'kill_switch_off' };

  const existing = await deps.store.list(terminalId);
  const plan = planAddProject({ name, repoUrl, existingNames: existing.map((p) => p.name) });
  if (!plan.ok) return plan;

  const ctx = buildCtx(terminalId, actor);
  const gitDeps = buildGitRunDeps(terminalId, deps);

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
    await safeRemoveDirectory(terminalId, plan.path, deps);
    return { ok: false, reason: 'clone_failed', detail: result.stderr || result.stdout };
  }

  try {
    const project = await deps.store.create({
      ownerId: actor.userId,
      terminalId,
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
  terminalId,
  store,
}: {
  terminalId: string;
  store: MachineProjectStore;
}): Promise<MachineProjectRecord[]> {
  return store.list(terminalId);
}

export type RemoveProjectResult = { ok: true } | { ok: false; reason: 'not_found' | 'error' };

export async function removeProject({
  terminalId,
  name,
  deps,
}: {
  terminalId: string;
  name: string;
  deps: MachineProjectsDeps;
}): Promise<RemoveProjectResult> {
  const existing = await deps.store.findByName(terminalId, name);
  if (!existing) return { ok: false, reason: 'not_found' };

  // Best-effort filesystem cleanup — the tracking row is removed regardless of
  // whether `rm -rf` succeeds, since the user asked for the project gone from
  // their list; a lingering directory is far less surprising than a project
  // the user can never remove because the machine is briefly unreachable.
  await safeRemoveDirectory(terminalId, existing.path, deps);

  try {
    await deps.store.remove(terminalId, name);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'error' };
  }
}
