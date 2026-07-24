import { describe, it, expect } from 'vitest';
import { scopeArgs } from '../session-tools-runtime';

/**
 * `scopeArgs` converts a resolved `MachineNodeHandle` into the
 * `{projectName?, branchName?}` pair `agent-terminals.ts`'s `resolveScopeKey`
 * looks a REAL `machine_branches` row up by. A branch-shaped handle with no
 * `branchSandbox` is `machine-pane-binding.ts`'s observed-branch synthesis —
 * the project's own checkout under an extra name, with no row to find — so
 * `branchName` must be omitted, routing the session family at the underlying
 * project scope instead (Codex review, PR #2233).
 */
describe('scopeArgs', () => {
  it('given a REAL branch handle (branchSandbox present), should include branchName', () => {
    expect(
      scopeArgs({ project: 'repo', branch: 'feature', branchSandbox: { machineBranchId: 'b1', sandboxId: 'sbx-1' } }),
    ).toEqual({ projectName: 'repo', branchName: 'feature' });
  });

  it('given a SYNTHESIZED branch handle (branch set, no branchSandbox), should omit branchName and keep only projectName', () => {
    expect(scopeArgs({ project: 'repo', branch: 'main', branchSandbox: undefined })).toEqual({ projectName: 'repo' });
  });

  it('given a project handle (no branch at all), should include only projectName', () => {
    expect(scopeArgs({ project: 'repo' })).toEqual({ projectName: 'repo' });
  });

  it('given a machine handle (no project, no branch), should return an empty scope', () => {
    expect(scopeArgs({})).toEqual({});
  });
});
