import { describe, it } from 'vitest';
import { assert } from './riteway';
import {
  deriveAgentTerminalSessionKey,
  agentTerminalScopeFromNames,
  type AgentTerminalScope,
} from '../agent-terminal-session-key';

describe('agentTerminalScopeFromNames', () => {
  it('maps absent project/branch to a machine scope', () => {
    assert({
      given: 'no project and no branch name',
      should: 'derive a machine scope',
      actual: agentTerminalScopeFromNames({}),
      expected: { kind: 'machine' } satisfies AgentTerminalScope,
    });
  });

  it('maps a project name alone to a project scope', () => {
    assert({
      given: 'a project name without a branch',
      should: 'derive a project scope',
      actual: agentTerminalScopeFromNames({ projectName: 'my-proj' }),
      expected: { kind: 'project', projectName: 'my-proj' } satisfies AgentTerminalScope,
    });
  });

  it('maps a project + branch name to a branch scope', () => {
    assert({
      given: 'a project name and a branch name',
      should: 'derive a branch scope',
      actual: agentTerminalScopeFromNames({ projectName: 'my-proj', branchName: 'feat/x' }),
      expected: { kind: 'branch', projectName: 'my-proj', branchName: 'feat/x' } satisfies AgentTerminalScope,
    });
  });

  it('ignores a branch name with no project name (cannot form a branch scope)', () => {
    assert({
      given: 'a branch name but no project name',
      should: 'fall back to a machine scope',
      actual: agentTerminalScopeFromNames({ branchName: 'feat/x' }),
      expected: { kind: 'machine' } satisfies AgentTerminalScope,
    });
  });
});

describe('deriveAgentTerminalSessionKey', () => {
  it('derives a stable key with zero I/O from machineId, scope and name', () => {
    assert({
      given: 'a machine-scope terminal',
      should: 'encode machineId, scope and name into the key',
      actual: deriveAgentTerminalSessionKey({
        machineId: 'term-1',
        scope: { kind: 'machine' },
        name: 'shell',
      }),
      expected: 'term-1:agent:machine:shell',
    });
  });

  it('is deterministic across repeated derivation (warm reattach)', () => {
    const params = {
      machineId: 'term-1',
      scope: { kind: 'branch', projectName: 'proj', branchName: 'main' } as const,
      name: 'cli',
    };
    assert({
      given: 'the same terminal reopened across connects',
      should: 'produce an identical key each time',
      actual: deriveAgentTerminalSessionKey(params) === deriveAgentTerminalSessionKey(params),
      expected: true,
    });
  });

  it('produces distinct keys for terminals differing only by scope', () => {
    const machine = deriveAgentTerminalSessionKey({ machineId: 't', scope: { kind: 'machine' }, name: 'cli' });
    const project = deriveAgentTerminalSessionKey({ machineId: 't', scope: { kind: 'project', projectName: 'p' }, name: 'cli' });
    assert({
      given: 'two terminals differing only by scope',
      should: 'produce distinct keys',
      actual: machine !== project,
      expected: true,
    });
  });

  it('produces distinct keys for terminals differing only by name', () => {
    const a = deriveAgentTerminalSessionKey({ machineId: 't', scope: { kind: 'machine' }, name: 'shell' });
    const b = deriveAgentTerminalSessionKey({ machineId: 't', scope: { kind: 'machine' }, name: 'cli' });
    assert({
      given: 'two terminals differing only by name',
      should: 'produce distinct keys',
      actual: a !== b,
      expected: true,
    });
  });

  it('produces distinct keys for terminals differing only by machineId', () => {
    const a = deriveAgentTerminalSessionKey({ machineId: 't1', scope: { kind: 'machine' }, name: 'cli' });
    const b = deriveAgentTerminalSessionKey({ machineId: 't2', scope: { kind: 'machine' }, name: 'cli' });
    assert({
      given: 'two terminals differing only by machineId',
      should: 'produce distinct keys',
      actual: a !== b,
      expected: true,
    });
  });

  it('avoids collisions when a separator character appears inside a component', () => {
    // Naive `${a}:${b}` joins collide when a colon lands inside a component:
    // project "a", branch "b:c" would join identically to project "a:b", branch "c".
    const left = deriveAgentTerminalSessionKey({
      machineId: 't',
      scope: { kind: 'branch', projectName: 'a', branchName: 'b:c' },
      name: 'cli',
    });
    const right = deriveAgentTerminalSessionKey({
      machineId: 't',
      scope: { kind: 'branch', projectName: 'a:b', branchName: 'c' },
      name: 'cli',
    });
    assert({
      given: 'branch scopes whose colon falls at a different component boundary',
      should: 'produce distinct keys via unambiguous encoding',
      actual: left !== right,
      expected: true,
    });
  });

  it('avoids collisions when a machineId contains a separator', () => {
    const a = deriveAgentTerminalSessionKey({ machineId: 'a:agent:machine', scope: { kind: 'machine' }, name: 'x' });
    const b = deriveAgentTerminalSessionKey({ machineId: 'a', scope: { kind: 'machine' }, name: 'x' });
    assert({
      given: 'a machineId containing the structural separators',
      should: 'not collide with a shorter machineId',
      actual: a !== b,
      expected: true,
    });
  });

  it('avoids collisions between a project named "machine" and a real machine scope', () => {
    const machine = deriveAgentTerminalSessionKey({ machineId: 't', scope: { kind: 'machine' }, name: 'cli' });
    const projMachine = deriveAgentTerminalSessionKey({ machineId: 't', scope: { kind: 'project', projectName: 'machine' }, name: 'cli' });
    assert({
      given: 'a project literally named "machine"',
      should: 'not collide with the machine scope',
      actual: machine !== projMachine,
      expected: true,
    });
  });
});
