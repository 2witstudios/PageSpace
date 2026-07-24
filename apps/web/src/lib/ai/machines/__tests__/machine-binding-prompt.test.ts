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
  // The code-execution tools (bash/readFile/writeFile/editFile/git/gh) no
  // longer accept a `target` node address — they always run at the
  // conversation's OWN node. The prompt must NOT advertise target addressing
  // (nor the old branch-worktree warning that only made sense for it), while
  // still stating where this node is and how to discover the rest of the
  // family (list_sessions) and that switch_machine/list_machines are gone.
  it('states the own-node working directory and never advertises target addressing', () => {
    const binding: MachineNodeHandleSet = { self: PROJECT_SELF, handles: [PROJECT_SELF] };
    const prompt = buildMachineBindingPrompt(binding);
    expect(prompt).toContain('operate from working directory: /workspace/projects/my-repo');
    // The removed target/branch guidance must be gone entirely.
    expect(prompt).not.toContain('target');
    expect(prompt).not.toContain('"branch" here is NOT');
    expect(prompt).toContain('Nothing else lies beneath this node.');
  });

  it('lists other nodes beneath as discovery context without telling the model to aim tools at them', () => {
    const binding: MachineNodeHandleSet = {
      self: PROJECT_SELF,
      handles: [
        PROJECT_SELF,
        { kind: 'branch', machineId: 'm1', project: 'my-repo', branch: 'feature-x', cwd: '/workspace/branches/x' },
      ],
    };
    const prompt = buildMachineBindingPrompt(binding);
    expect(prompt).toContain('Other nodes exist beneath this one');
    expect(prompt).toContain('branch: "feature-x"');
    expect(prompt).toContain('Your code-execution tools always run at YOUR node');
    expect(prompt).not.toContain('target');
  });

  it('a branch-bound conversation (nothing beneath it) reports its own node with no target guidance', () => {
    const branchSelf: MachineNodeHandleSet['self'] = {
      kind: 'branch',
      machineId: 'm1',
      project: 'my-repo',
      branch: 'main',
      cwd: '/workspace/branches/main',
    };
    const binding: MachineNodeHandleSet = { self: branchSelf, handles: [branchSelf] };
    const prompt = buildMachineBindingPrompt(binding);
    expect(prompt).toContain('branch "main" of project "my-repo"');
    expect(prompt).toContain('Nothing else lies beneath this node.');
    expect(prompt).not.toContain('target');
  });

  it('retains the list_sessions discovery pointer and the switch_machine/list_machines unavailability note', () => {
    const binding: MachineNodeHandleSet = { self: PROJECT_SELF, handles: [PROJECT_SELF] };
    const prompt = buildMachineBindingPrompt(binding);
    expect(prompt).toContain('Call list_sessions to see the nodes in this scope');
    expect(prompt).toContain('switch_machine and list_machines are unavailable');
  });
});
