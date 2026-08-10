import { describe, it, expect } from 'vitest';
import {
  AGENT_LAUNCH_SPECS,
  PICKABLE_SHELL_AGENT_TYPES,
  isShellAgentType,
  resolveShellLaunchSpec,
  isValidShellCommand,
} from '../shell-types';
import { SHELL_AGENT_TYPES } from '../../../agent-workspaces/shells-contract';
import { isValidShellName } from '../../../agent-workspaces/plan-spawn-worker';

describe('isShellAgentType', () => {
  it('given the shell type, should recognize it', () => {
    expect(isShellAgentType('shell')).toBe(true);
  });

  it('given an unknown type, should reject it', () => {
    expect(isShellAgentType('gemini')).toBe(false);
    expect(isShellAgentType('')).toBe(false);
    expect(isShellAgentType('constructor')).toBe(false);
  });

  it('given the deleted chat-surface type, should reject it — a session\'s chat surface is its conversation', () => {
    // `'pagespace'` has NO successor here: it rendered a chat UI in a pane
    // rather than launching a PTY, and it is what forced every caller to ask
    // `isPtyAgentType` before touching a Sprite. Every shell is a PTY now.
    expect(isShellAgentType('pagespace')).toBe(false);
  });

  it('given a legacy retired type, should reject it as unrecognized (not crash)', () => {
    expect(isShellAgentType('pagespace-cli')).toBe(false);
    expect(isShellAgentType('claude')).toBe(false);
    expect(isShellAgentType('codex')).toBe(false);
  });
});

describe('AGENT_LAUNCH_SPECS', () => {
  it('should be PTY-only — exactly the contract\'s shell agent types, no chat surface', () => {
    expect(Object.keys(AGENT_LAUNCH_SPECS)).toEqual(['shell']);
    // The registry and the wire contract are one list, not two: this is the
    // runtime half of the `satisfies Record<ShellAgentType, …>` type check.
    expect(Object.keys(AGENT_LAUNCH_SPECS)).toEqual([...SHELL_AGENT_TYPES]);
  });

  it('should carry NO surface discriminator — there is nothing left to discriminate', () => {
    for (const spec of Object.values(AGENT_LAUNCH_SPECS)) {
      expect(spec).not.toHaveProperty('surface');
    }
  });
});

describe('resolveShellLaunchSpec', () => {
  it('given shell, should resolve the "shell" sentinel command (resolved to $SHELL by the launching layer)', () => {
    expect(resolveShellLaunchSpec('shell')).toEqual({ command: 'shell', args: [] });
  });

  it('given two resolutions, should return independent arrays (no shared mutable state)', () => {
    const a = resolveShellLaunchSpec('shell');
    a.args.push('--danger');
    const b = resolveShellLaunchSpec('shell');
    expect(b.args).toEqual([]);
  });
});

describe('PICKABLE_SHELL_AGENT_TYPES', () => {
  it('should expose the shell type as pickable', () => {
    expect(PICKABLE_SHELL_AGENT_TYPES).toEqual(['shell']);
  });
});

describe('agent type identifiers stay usable as shell labels', () => {
  it('given every pickable agent type, should produce identifiers a shell name accepts', () => {
    for (const type of PICKABLE_SHELL_AGENT_TYPES) {
      expect(isValidShellName(type)).toBe(true);
      expect(isValidShellName(`${type}-a1b2c3`)).toBe(true);
    }
  });
});

describe('isValidShellCommand', () => {
  it('given a normal command string, should accept it', () => {
    expect(isValidShellCommand('htop')).toBe(true);
    expect(isValidShellCommand('npm run dev')).toBe(true);
  });

  it('given an empty or whitespace-only command, should reject it', () => {
    expect(isValidShellCommand('')).toBe(false);
    expect(isValidShellCommand('   ')).toBe(false);
  });

  it('given a command longer than 500 chars, should reject it', () => {
    expect(isValidShellCommand('a'.repeat(501))).toBe(false);
    expect(isValidShellCommand('a'.repeat(500))).toBe(true);
  });
});
