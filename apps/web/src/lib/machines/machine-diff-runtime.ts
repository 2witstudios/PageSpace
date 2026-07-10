/**
 * Production wiring for the Machine Diff API (Machine page rebuild, Diff tab
 * — 3-way scope service).
 *
 * The Diff route needs EXACTLY the deps the git-blob route needs — a branch
 * terminal's live `MachineHandle`, `runGitInSandbox` deps bound to it, the
 * canonical access check, and the shared actor-context builders — so this
 * module is pure re-export aliasing over `./machine-git-blob-runtime` (see
 * that module's docstring for how each binding is assembled and why access
 * goes through `machine-access-runtime`, not the older inline copies). One
 * file to touch if the Diff route's wiring ever needs to diverge.
 */

export {
  canViewMachine,
  resolveBranchMachineHandle,
  resolveMachineActorContext,
  buildGitBlobActorContext as buildDiffActorContext,
  buildGitBlobDepsForHandle as buildDiffGitDepsForHandle,
} from './machine-git-blob-runtime';
