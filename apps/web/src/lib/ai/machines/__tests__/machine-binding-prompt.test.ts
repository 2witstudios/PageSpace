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
  it('given a project self with no branches at all beneath it, should warn and defer to the reachable list', () => {
    const binding: MachineNodeHandleSet = { self: PROJECT_SELF, handles: [PROJECT_SELF] };
    const prompt = buildMachineBindingPrompt(binding);
    expect(prompt).toContain('"branch" here is NOT "whatever git branch a project happens to be on"');
    expect(prompt).toContain('only add branch: "main"/"master" if that exact project+branch pairing is listed above');
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

  it('given a project self with a LIVE branch actually named "main", should still warn — the warning is conditional advice, not a false claim', () => {
    // The warning says "only use branch: main if it's listed above" — which
    // remains TRUE and safe to show even when "main" genuinely is listed:
    // following it correctly leads the reader to use it, since it IS listed.
    const binding: MachineNodeHandleSet = {
      self: PROJECT_SELF,
      handles: [
        PROJECT_SELF,
        { kind: 'branch', machineId: 'm1', project: 'my-repo', branch: 'main', cwd: '/workspace/branches/main' },
      ],
    };
    const prompt = buildMachineBindingPrompt(binding);
    expect(prompt).toContain('"branch" here is NOT "whatever git branch a project happens to be on"');
    expect(prompt).toContain('branch: "main"'); // reachable list names it — the source of truth
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
