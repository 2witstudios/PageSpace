import { describe, it, expect } from 'vitest';
import {
  AGENT_LAUNCH_SPECS,
  PICKABLE_AGENT_TYPES,
  isAgentRuntimeType,
  resolveAgentLaunchSpec,
  isValidAgentTerminalName,
  isValidAgentTerminalCommand,
  isPtyAgentType,
  agentSurfaceOf,
} from '../agent-terminal-types';

describe('isAgentRuntimeType', () => {
  it('given each first-party agent type, should recognize it', () => {
    expect(isAgentRuntimeType('pagespace')).toBe(true);
    expect(isAgentRuntimeType('shell')).toBe(true);
  });

  it('given an unknown type, should reject it', () => {
    expect(isAgentRuntimeType('gemini')).toBe(false);
    expect(isAgentRuntimeType('')).toBe(false);
    expect(isAgentRuntimeType('constructor')).toBe(false);
  });

  it('given a retired agent type, should reject it as unrecognized (not crash)', () => {
    // Retired types' DB rows degrade to remove-only sidebar listings — the
    // registry must NOT resurrect them as launchable.
    expect(isAgentRuntimeType('pagespace-cli')).toBe(false);
    expect(isAgentRuntimeType('claude')).toBe(false);
    expect(isAgentRuntimeType('codex')).toBe(false);
  });
});

describe('resolveAgentLaunchSpec', () => {
  it('given shell, should resolve the "shell" sentinel command (resolved to $SHELL by the launching layer)', () => {
    expect(resolveAgentLaunchSpec('shell')).toEqual({ command: 'shell', args: [] });
  });

  it('given two resolutions, should return independent arrays (no shared mutable state)', () => {
    const a = resolveAgentLaunchSpec('shell');
    a.args.push('--danger');
    const b = resolveAgentLaunchSpec('shell');
    expect(b.args).toEqual([]);
  });

  it('should expose a registry entry for every AgentRuntimeType, Agent first', () => {
    expect(Object.keys(AGENT_LAUNCH_SPECS)).toEqual(['pagespace', 'shell']);
  });

  it('should not expose registry entries for retired agent types', () => {
    expect(Object.keys(AGENT_LAUNCH_SPECS)).not.toContain('pagespace-cli');
    expect(Object.keys(AGENT_LAUNCH_SPECS)).not.toContain('claude');
    expect(Object.keys(AGENT_LAUNCH_SPECS)).not.toContain('codex');
  });
});

describe('PICKABLE_AGENT_TYPES', () => {
  it('should be exactly pagespace and shell — claude/codex are retired alongside pagespace-cli', () => {
    expect(PICKABLE_AGENT_TYPES).toEqual(['pagespace', 'shell']);
  });

  it('should list pagespace FIRST — the Agent is the default, primary way to work on a Machine', () => {
    expect(PICKABLE_AGENT_TYPES[0]).toBe('pagespace');
  });
});

describe('agentSurfaceOf', () => {
  it('given pagespace, should return chat', () => {
    expect(agentSurfaceOf('pagespace')).toBe('chat');
  });

  it('given shell, should return pty', () => {
    expect(agentSurfaceOf('shell')).toBe('pty');
  });
});

describe('isPtyAgentType', () => {
  it('given pagespace, should return false', () => {
    expect(isPtyAgentType('pagespace')).toBe(false);
  });

  it('given shell, should return true', () => {
    expect(isPtyAgentType('shell')).toBe(true);
  });
});

describe('agent type identifiers stay compatible with autoSessionName', () => {
  // autoSessionName (apps/web/src/stores/machine-workspace/workspace-reducer.ts) builds
  // `${agentType}-${suffix}` or bare `agentType` for the split-and-pick spawn name — this
  // guards that every registry key, including the new `pagespace` type, still produces a
  // name isValidAgentTerminalName accepts.
  it('given every pickable agent type, should produce identifiers that satisfy isValidAgentTerminalName', () => {
    for (const type of PICKABLE_AGENT_TYPES) {
      expect(isValidAgentTerminalName(type)).toBe(true);
      expect(isValidAgentTerminalName(`${type}-a1b2c3`)).toBe(true);
    }
  });
});

describe('isValidAgentTerminalName', () => {
  it('given a simple alphanumeric name, should accept it', () => {
    expect(isValidAgentTerminalName('reviewer')).toBe(true);
    expect(isValidAgentTerminalName('agent-1')).toBe(true);
    expect(isValidAgentTerminalName('agent_2')).toBe(true);
  });

  it('given an empty name, should reject it', () => {
    expect(isValidAgentTerminalName('')).toBe(false);
  });

  it('given a name starting with a symbol, should reject it', () => {
    expect(isValidAgentTerminalName('-agent')).toBe(false);
    expect(isValidAgentTerminalName('_agent')).toBe(false);
  });

  it('given a name with path-like or shell-meaningful characters, should reject it', () => {
    expect(isValidAgentTerminalName('../etc')).toBe(false);
    expect(isValidAgentTerminalName('a/b')).toBe(false);
    expect(isValidAgentTerminalName('a b')).toBe(false);
    expect(isValidAgentTerminalName('a;b')).toBe(false);
  });

  it('given a name longer than 100 chars, should reject it', () => {
    expect(isValidAgentTerminalName('a'.repeat(101))).toBe(false);
    expect(isValidAgentTerminalName('a'.repeat(100))).toBe(true);
  });
});

describe('isValidAgentTerminalCommand', () => {
  it('given a normal command string, should accept it', () => {
    expect(isValidAgentTerminalCommand('htop')).toBe(true);
    expect(isValidAgentTerminalCommand('npm run dev')).toBe(true);
  });

  it('given an empty or whitespace-only command, should reject it', () => {
    expect(isValidAgentTerminalCommand('')).toBe(false);
    expect(isValidAgentTerminalCommand('   ')).toBe(false);
  });

  it('given a command longer than 500 chars, should reject it', () => {
    expect(isValidAgentTerminalCommand('a'.repeat(501))).toBe(false);
    expect(isValidAgentTerminalCommand('a'.repeat(500))).toBe(true);
  });
});
