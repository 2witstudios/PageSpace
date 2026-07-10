/**
 * Production wiring for the Machine git-blob read API (Machine page rebuild,
 * Diff tab — git-versioned 'before' content).
 *
 * Resolves a branch-terminal's LIVE `MachineHandle` (reusing
 * `resolveBranchMachineHandle` from `./machine-files-runtime`) and binds
 * `runGitInSandbox`'s `GitSandboxRunDeps` directly to it — the same DI shape
 * `machine-branches.ts`'s (private) `buildGitDepsForHandle` uses for
 * clone/checkout, since a branch-terminal already holds its own live handle
 * rather than going through a page-keyed acquire/reconnect lookup.
 *
 * Access is gated through the shared `machine-access.ts` module (Phase 0, PR
 * #1962, already on master when this branch forked) via
 * `./machine-access-runtime` — NOT the older inline `canViewMachine` copies in
 * `machine-branches-runtime.ts` / `machine-files-runtime.ts`, per that
 * module's own "new code going forward" docstring.
 */

import { adaptMachineHandleToExecutableSandbox } from '@pagespace/lib/services/sandbox/sandbox-client/machine-host-adapter';
import { isCodeExecutionEnabled } from '@pagespace/lib/services/sandbox/can-run-code';
import { acquireCodeExecutionSlot, releaseCodeExecutionSlot } from '@pagespace/lib/services/sandbox/quota';
import { writeCodeExecutionAudit } from '@pagespace/lib/services/sandbox/audit';
import { defaultBuildEnv } from '@pagespace/lib/services/sandbox/tool-runners';
import type { SandboxActorContext } from '@pagespace/lib/services/sandbox/tool-runners';
import { resolveGitHubTokenForSandbox } from '@pagespace/lib/services/sandbox/github-token';
import type { GitSandboxRunDeps } from '@pagespace/lib/services/sandbox/git-tool-runners';
import type { MachineHandle } from '@pagespace/lib/services/sandbox/machine-host';
import type { MachineActorContext } from '@pagespace/lib/services/machines/machine-branches';
import { db } from '@pagespace/db/db';
import { canViewMachine } from './machine-access-runtime';
import { resolveBranchMachineHandle } from './machine-files-runtime';
import { resolveMachineActorContext } from './machine-branches-runtime';

export { canViewMachine, resolveBranchMachineHandle, resolveMachineActorContext };

/** Build the `SandboxActorContext` a git-blob read runs under — no conversation, so `scopeKey` is an opaque label. */
export function buildGitBlobActorContext(scopeKey: string, actor: MachineActorContext): SandboxActorContext {
  return {
    userId: actor.userId,
    tenantId: actor.tenantId,
    driveId: undefined,
    conversationId: scopeKey,
    actorEmail: actor.actorEmail,
    actorDisplayName: actor.actorDisplayName,
    tier: actor.tier,
  };
}

/**
 * Build `runGitInSandbox` deps bound directly to an already-resolved branch
 * `MachineHandle` — no page-keyed acquire/reconnect lookup, mirroring
 * `machine-branches.ts`'s `buildGitDepsForHandle` (the Branches DI shape this
 * task was told to mirror).
 */
export function buildGitBlobDepsForHandle(handle: MachineHandle): GitSandboxRunDeps {
  const sandbox = adaptMachineHandleToExecutableSandbox(handle);
  return {
    isEnabled: isCodeExecutionEnabled,
    resolveGitHubToken: (userId) => resolveGitHubTokenForSandbox({ userId, db }),
    acquireSandbox: async () => ({ ok: true, sandboxId: handle.machineId, resumed: false }),
    reconnect: async () => sandbox,
    quota: { acquireSlot: acquireCodeExecutionSlot, releaseSlot: releaseCodeExecutionSlot },
    buildEnv: defaultBuildEnv,
    audit: (input) => writeCodeExecutionAudit({ input }),
    now: () => new Date(),
  };
}
