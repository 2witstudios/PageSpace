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
  // Codex review (PR #2232): a project can have a genuinely LIVE branch
  // worktree named "main"/"master" (spawnBranch doesn't reserve these names).
  // A blanket "never use branch: main" instruction would be actively wrong
  // advice for that case — it would make the model omit a branch qualifier
  // it should have used, running tool calls in the project's checkout
  // instead of the correctly separate branch Sprite.
  it('given no live branch named main/master, should warn that "branch" never means the project\'s own default checkout', () => {
    const binding: MachineNodeHandleSet = {
      self: PROJECT_SELF,
      handles: [
        PROJECT_SELF,
        { kind: 'branch', machineId: 'm1', project: 'my-repo', branch: 'feature-x', cwd: '/workspace/branches/x' },
      ],
    };
    const prompt = buildMachineBindingPrompt(binding);
    expect(prompt).toContain('"branch" here is NOT "whatever git branch a project happens to be on"');
    expect(prompt).toContain('there is no such branch here');
    // Codex review (PR #2232, fourth pass): "feature-x" IS a real, listed
    // branch here — the warning must not claim no branch at all is listed
    // (only that no main/master one is), or it contradicts the "Currently
    // reachable" line directly above it and could make the model ignore a
    // genuinely valid target.
    expect(prompt).toContain('branch: "feature-x"');
    expect(prompt).not.toContain('(none is currently listed above)');
  });

  it('given a LIVE branch actually named "main", should NOT warn against using branch: "main"', () => {
    const binding: MachineNodeHandleSet = {
      self: PROJECT_SELF,
      handles: [
        PROJECT_SELF,
        { kind: 'branch', machineId: 'm1', project: 'my-repo', branch: 'main', cwd: '/workspace/branches/main' },
      ],
    };
    const prompt = buildMachineBindingPrompt(binding);
    expect(prompt).not.toContain('"branch" here is NOT "whatever git branch a project happens to be on"');
    // The reachable listing itself still names it — that's the real source of truth.
    expect(prompt).toContain('branch: "main"');
  });

  it('given a LIVE branch named "master" (the other alias), should also NOT warn', () => {
    const binding: MachineNodeHandleSet = {
      self: PROJECT_SELF,
      handles: [
        PROJECT_SELF,
        { kind: 'branch', machineId: 'm1', project: 'my-repo', branch: 'master', cwd: '/workspace/branches/master' },
      ],
    };
    const prompt = buildMachineBindingPrompt(binding);
    expect(prompt).not.toContain('"branch" here is NOT "whatever git branch a project happens to be on"');
  });

  it('given a live "main" branch under ANY reachable project, should suppress the warning globally rather than assert something false', () => {
    // The warning is a blanket statement ("there is no such branch here") —
    // if it's false for even one reachable project, asserting it anyway would
    // be actively wrong advice for that project. Safer to omit the statement
    // entirely and let the always-accurate "Currently reachable" list (which
    // names every real branch by its own project) carry the information,
    // than to risk telling the model something false.
    const machineSelf: MachineNodeHandleSet['self'] = { kind: 'machine', machineId: 'm1', cwd: '/workspace' };
    const binding: MachineNodeHandleSet = {
      self: machineSelf,
      handles: [
        machineSelf,
        { kind: 'project', machineId: 'm1', project: 'other-repo', cwd: '/workspace/projects/other-repo' },
        { kind: 'branch', machineId: 'm1', project: 'other-repo', branch: 'main', cwd: '/workspace/branches/main' },
      ],
    };
    const prompt = buildMachineBindingPrompt(binding);
    expect(prompt).not.toContain('"branch" here is NOT "whatever git branch a project happens to be on"');
  });

  // Codex review (PR #2232, third pass): the warning's OWN advice — "to run
  // at a project, pass target: { project }" — is unreachable from ANY
  // branch-scoped self, not just one named main/master. deriveMachinePaneBinding
  // gives a branch pane handles: [self] only — no project handle is EVER in
  // scope from there, regardless of what this branch is named. Recommending
  // it would just trade one target_not_in_set for another, so the whole
  // warning is skipped for a branch self unconditionally.
  it('given self IS a live branch named "main" (branch-bound conversation, nothing beneath it), should NOT warn', () => {
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

  it('given self is a branch NOT named main/master (branch-bound, nothing beneath it), should ALSO not warn — recommending target: { project } would be unreachable advice regardless of this branch\'s name', () => {
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

  it('given a project-scoped self with no live default branch beneath it, should still warn (the project handle IS reachable, so the advice is valid here)', () => {
    // Regression guard: the branch-self suppression above must not
    // accidentally widen to suppress the warning for project/machine selfs
    // too, where the recommended target: { project } genuinely does resolve.
    const binding: MachineNodeHandleSet = { self: PROJECT_SELF, handles: [PROJECT_SELF] };
    const prompt = buildMachineBindingPrompt(binding);
    expect(prompt).toContain('"branch" here is NOT "whatever git branch a project happens to be on"');
  });
});
