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
});
