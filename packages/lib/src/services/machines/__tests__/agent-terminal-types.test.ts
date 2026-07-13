import { describe, it, expect } from 'vitest';
import {
  AGENT_LAUNCH_SPECS,
  PICKABLE_AGENT_TYPES,
  isAgentRuntimeType,
  resolveAgentLaunchSpec,
  isValidAgentTerminalName,
  isValidAgentTerminalCommand,
} from '../agent-terminal-types';

describe('isAgentRuntimeType', () => {
  it('given each first-party agent type, should recognize it', () => {
    expect(isAgentRuntimeType('claude')).toBe(true);
    expect(isAgentRuntimeType('codex')).toBe(true);
    expect(isAgentRuntimeType('shell')).toBe(true);
  });

  it('given an unknown type, should reject it', () => {
    expect(isAgentRuntimeType('gemini')).toBe(false);
    expect(isAgentRuntimeType('')).toBe(false);
    expect(isAgentRuntimeType('constructor')).toBe(false);
  });

  it('given the retired pagespace-cli agent type, should reject it as unrecognized (not crash)', () => {
    expect(isAgentRuntimeType('pagespace-cli')).toBe(false);
  });
});

describe('resolveAgentLaunchSpec', () => {
  it('given claude, should resolve the claude binary', () => {
    expect(resolveAgentLaunchSpec('claude')).toEqual({ command: 'claude', args: [] });
  });

  it('given codex, should resolve the codex binary', () => {
    expect(resolveAgentLaunchSpec('codex')).toEqual({ command: 'codex', args: [] });
  });

  it('given shell, should resolve the "shell" sentinel command (resolved to $SHELL by the launching layer)', () => {
    expect(resolveAgentLaunchSpec('shell')).toEqual({ command: 'shell', args: [] });
  });

  it('given two resolutions, should return independent arrays (no shared mutable state)', () => {
    const a = resolveAgentLaunchSpec('claude');
    a.args.push('--danger');
    const b = resolveAgentLaunchSpec('claude');
    expect(b.args).toEqual([]);
  });

  it('should expose a registry entry for every AgentRuntimeType', () => {
    expect(Object.keys(AGENT_LAUNCH_SPECS)).toEqual(['claude', 'codex', 'shell']);
  });

  it('should not expose a registry entry for the retired pagespace-cli agent type', () => {
    expect(Object.keys(AGENT_LAUNCH_SPECS)).not.toContain('pagespace-cli');
  });
});

describe('PICKABLE_AGENT_TYPES', () => {
  it('should include every AI-agent AgentRuntimeType a user can pick from the empty-pane picker', () => {
    expect(PICKABLE_AGENT_TYPES).toEqual(['claude', 'codex']);
  });

  it('should exclude the shell sentinel — a bare shell is not an AI agent identity to pick', () => {
    expect(PICKABLE_AGENT_TYPES).not.toContain('shell');
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
