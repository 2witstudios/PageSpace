/**
 * Production wiring for the Machine git-blob read API (Machine page rebuild,
 * Diff tab — git-versioned 'before' content).
 *
 * Resolves a branch-terminal's LIVE `MachineHandle` (reusing
 * `resolveBranchMachineHandle` from `./machine-files-runtime`) and binds
 * `runGitInSandbox`'s `GitSandboxRunDeps` directly to it — the same DI shape
 * `machine-branches.ts`'s (private) `buildGitDepsForHandle` uses for
 * clone/checkout, since a branch-terminal already holds its own live handle
 * rather than going through a page-keyed acquire/reconnect lookup. The
 * individual bindings (kill-switch, GitHub token, quota, env, audit) are NOT
 * re-derived here — they're pulled straight off `buildMachineBranchesDeps()`
 * (`./machine-branches-runtime`), the one place those real-service bindings
 * are already assembled, so a future change to that wiring (e.g. the audit
 * input shape) only needs fixing in one spot. Likewise `buildActorCtx` is
 * imported from `machine-branches.ts` (exported for this reuse) rather than
 * re-typed here, so a future required field on `SandboxActorContext` can't
 * drift between the two Machine-scope call sites.
 *
 * Access is gated through the shared `machine-access.ts` module (Phase 0, PR
 * #1962, already on master when this branch forked) via
 * `./machine-access-runtime` — NOT the older inline `canViewMachine` copies in
 * `machine-branches-runtime.ts` / `machine-files-runtime.ts`, per that
 * module's own "new code going forward" docstring.
 */

import { adaptMachineHandleToExecutableSandbox } from '@pagespace/lib/services/sandbox/sandbox-client/machine-host-adapter';
import type { GitSandboxRunDeps } from '@pagespace/lib/services/sandbox/git-tool-runners';
import type { MachineHandle } from '@pagespace/lib/services/sandbox/machine-host';
import { buildActorCtx } from '@pagespace/lib/services/machines/machine-branches';
import { canViewMachine } from './machine-access-runtime';
import { resolveBranchMachineHandle } from './machine-files-runtime';
import { resolveMachineActorContext, buildMachineBranchesDeps } from './machine-branches-runtime';

export { canViewMachine, resolveBranchMachineHandle, resolveMachineActorContext, buildActorCtx as buildGitBlobActorContext };

/**
 * Build `runGitInSandbox` deps bound directly to an already-resolved branch
 * `MachineHandle` — no page-keyed acquire/reconnect lookup (the branch already
 * holds its own live handle) — while reusing `buildMachineBranchesDeps()` for
 * every binding that ISN'T handle-specific (kill-switch, GitHub token, quota,
 * env, audit, clock).
 */
export function buildGitBlobDepsForHandle(handle: MachineHandle): GitSandboxRunDeps {
  const branchDeps = buildMachineBranchesDeps();
  const sandbox = adaptMachineHandleToExecutableSandbox(handle);
  return {
    isEnabled: branchDeps.isEnabled,
    resolveGitHubToken: branchDeps.resolveGitHubToken,
    quota: branchDeps.quota,
    buildEnv: branchDeps.buildEnv,
    audit: branchDeps.audit,
    now: branchDeps.now,
    acquireSandbox: async () => ({ ok: true, sandboxId: handle.machineId, resumed: false }),
    reconnect: async () => sandbox,
  };
}
