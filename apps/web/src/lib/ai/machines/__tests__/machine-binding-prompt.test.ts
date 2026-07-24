import { describe, it, expect } from 'vitest';
import { buildMachineBindingPrompt } from '../machine-binding-prompt';
import type { MachineNodeHandleSet } from '@pagespace/lib/services/machines/machine-pane-binding';

const PROJECT_SELF: MachineNodeHandleSet['self'] = {
  kind: 'project',
  machineId: 'm1',
  project: 'my-repo',
  cwd: '/workspace/projects/my-repo',
};

describe('buildMachineBindingPrompt', () => {
  // PR #2232 history: earlier versions tried to assert whether a live
  // main/master branch worktree existed, and suppress or word the warning
  // based on that single yes/no answer. Four rounds of review each found a
  // case where that answer was wrong for SOME part of the reachable set —
  // most fundamentally, a machine-root binding can reach many projects, and
  // one project having a live "main" branch says nothing about a different,
  // also-reachable project that doesn't. Rather than track this per project,
  // the warning is now unconditional (for any non-branch self) and makes no
  // claim about the set's contents — it just tells the reader to check the
  // "Currently reachable" list, which is always itemized and accurate.
  it('given a project self with no branches at all beneath it, should warn and instruct omitting branch for default-checkout intent', () => {
    const binding: MachineNodeHandleSet = { self: PROJECT_SELF, handles: [PROJECT_SELF] };
    const prompt = buildMachineBindingPrompt(binding);
    expect(prompt).toContain('"branch" here is NOT "whatever git branch a project happens to be on"');
    expect(prompt).toContain('pass target: { project } alone and omit branch');
  });

  it('given a project self with a non-default branch listed (e.g. feature-x), should still warn without claiming no branch is listed', () => {
    const binding: MachineNodeHandleSet = {
      self: PROJECT_SELF,
      handles: [
        PROJECT_SELF,
        { kind: 'branch', machineId: 'm1', project: 'my-repo', branch: 'feature-x', cwd: '/workspace/branches/x' },
      ],
    };
    const prompt = buildMachineBindingPrompt(binding);
    expect(prompt).toContain('"branch" here is NOT "whatever git branch a project happens to be on"');
    expect(prompt).toContain('branch: "feature-x"'); // the reachable list still names it — untouched by the warning
  });

  // Codex review (PR #2232, fifth pass): a separately created worktree named
  // "main"/"master" is still a DIFFERENT Sprite from the project's own
  // default checkout. Telling the model "add branch: main if it's listed" is
  // wrong when the model's actual intent is its own default checkout —
  // following that advice would route the call to the wrong worktree, the
  // exact risk this warning exists to prevent. The fix: default-checkout
  // intent always means target: { project } alone, regardless of what's
  // listed; the warning must say so unconditionally, not "if listed".
  it('given a project self with a LIVE branch actually named "main", should still instruct omitting branch for default-checkout intent — not "add branch: main since it is listed"', () => {
    const binding: MachineNodeHandleSet = {
      self: PROJECT_SELF,
      handles: [
        PROJECT_SELF,
        { kind: 'branch', machineId: 'm1', project: 'my-repo', branch: 'main', cwd: '/workspace/branches/main' },
      ],
    };
    const prompt = buildMachineBindingPrompt(binding);
    expect(prompt).toContain('"branch" here is NOT "whatever git branch a project happens to be on"');
    expect(prompt).toContain('pass target: { project } alone and omit branch');
    expect(prompt).toContain('even if a branch named "main"/"master" is listed above');
    expect(prompt).toContain('branch: "main"'); // reachable list still names the separate worktree — untouched by the warning
  });

  // Codex review (PR #2232, fifth pass): a machine-root binding can reach
  // MULTIPLE projects. One having a live "main" branch must not silence the
  // warning for a DIFFERENT, also-reachable project that has none — the
  // unconditional wording (deferring to the per-project reachable list)
  // is what actually fixes this, rather than any global yes/no tracking.
  it('given a machine-root self reaching one project WITH a live main branch and another WITHOUT one, should still warn (not globally suppressed)', () => {
    const machineSelf: MachineNodeHandleSet['self'] = { kind: 'machine', machineId: 'm1', cwd: '/workspace' };
    const binding: MachineNodeHandleSet = {
      self: machineSelf,
      handles: [
        machineSelf,
        { kind: 'project', machineId: 'm1', project: 'has-main', cwd: '/workspace/projects/has-main' },
        { kind: 'branch', machineId: 'm1', project: 'has-main', branch: 'main', cwd: '/workspace/branches/main' },
        { kind: 'project', machineId: 'm1', project: 'no-main', cwd: '/workspace/projects/no-main' },
      ],
    };
    const prompt = buildMachineBindingPrompt(binding);
    expect(prompt).toContain('"branch" here is NOT "whatever git branch a project happens to be on"');
  });

  // A conversation bound DIRECTLY to a branch has handles: [self] only — no
  // project handle is EVER in scope from there, regardless of what this
  // branch is named. The warning's own advice ("pass target: { project }")
  // is unreachable in that case, so it's skipped entirely for a branch self.
  it('given self IS a branch (branch-bound conversation, nothing beneath it), should NOT warn regardless of the branch\'s name', () => {
    const branchSelf: MachineNodeHandleSet['self'] = {
      kind: 'branch',
      machineId: 'm1',
      project: 'my-repo',
      branch: 'main',
      cwd: '/workspace/branches/main',
    };
    const binding: MachineNodeHandleSet = { self: branchSelf, handles: [branchSelf] };
    const prompt = buildMachineBindingPrompt(binding);
    expect(prompt).not.toContain('"branch" here is NOT "whatever git branch a project happens to be on"');
  });

  it('given self is a branch with a non-default name, should ALSO not warn — the advice is unreachable regardless of this branch\'s name', () => {
    const branchSelf: MachineNodeHandleSet['self'] = {
      kind: 'branch',
      machineId: 'm1',
      project: 'my-repo',
      branch: 'feature-x',
      cwd: '/workspace/branches/feature-x',
    };
    const binding: MachineNodeHandleSet = { self: branchSelf, handles: [branchSelf] };
    const prompt = buildMachineBindingPrompt(binding);
    expect(prompt).not.toContain('"branch" here is NOT "whatever git branch a project happens to be on"');
  });
});
