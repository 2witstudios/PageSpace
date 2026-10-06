import { describe, it, expect } from 'vitest';
import {
  BUILTIN_AGENTS,
  BUILTIN_AGENT_KEYS,
  RETIRED_BUILTIN_AGENT_KEYS,
  getBuiltinAgent,
  isBuiltinAgentKey,
} from '../builtin-agents';

describe('built-in agent registry', () => {
  it('given owner decision 2026-10-06, should define exactly one agent: imago', () => {
    expect([...BUILTIN_AGENT_KEYS]).toEqual(['imago']);
    expect(BUILTIN_AGENTS.map((agent) => agent.key)).toEqual([...BUILTIN_AGENT_KEYS]);
  });

  it('given the retired Planner and Researcher, should list their keys as retired and never as live', () => {
    expect([...RETIRED_BUILTIN_AGENT_KEYS]).toEqual(['imago-planner', 'imago-researcher']);
    for (const key of RETIRED_BUILTIN_AGENT_KEYS) expect(isBuiltinAgentKey(key)).toBe(false);
  });

  it('given imago replaces the global assistant, should act with the user\'s own reach (userScopedAccess)', () => {
    expect(getBuiltinAgent('imago').userScopedAccess).toBe(true);
  });

  it('given the registry, should never repeat a key (one pointer row per user and key)', () => {
    const keys = BUILTIN_AGENTS.map((agent) => agent.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('given the registry, should never repeat a title (the agents are told apart by name in one folder)', () => {
    const titles = BUILTIN_AGENTS.map((agent) => agent.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  describe.each(BUILTIN_AGENTS.map((agent) => [agent.key, agent] as const))('%s', (_key, agent) => {
    it('should carry a non-empty title, agent definition and system prompt', () => {
      expect(agent.title.trim()).not.toBe('');
      expect(agent.agentDefinition.trim()).not.toBe('');
      expect(agent.systemPrompt.trim()).not.toBe('');
    });

    it('should carry a non-empty, duplicate-free enabled-tools allowlist of snake_case tool names', () => {
      expect(agent.enabledTools.length).toBeGreaterThan(0);
      expect(new Set(agent.enabledTools).size).toBe(agent.enabledTools.length);
      for (const tool of agent.enabledTools) expect(tool).toMatch(/^[a-z][a-z0-9_]*$/);
    });

    it('should state includePageTree as a boolean', () => {
      expect(typeof agent.includePageTree).toBe('boolean');
    });

    it('should name itself in its system prompt', () => {
      expect(agent.systemPrompt).toContain(agent.title);
    });
  });

  it('given the imago persona, should describe the user\'s reach and the drives kept out, never grants or the retired agents', () => {
    const imago = getBuiltinAgent('imago');
    expect(imago.systemPrompt).toMatch(/their own reach/);
    expect(imago.systemPrompt).toMatch(/kept you out of/);
    expect(imago.systemPrompt).not.toMatch(/grant|Planner|Researcher/);
  });

  it('given stored tools for runs outside its own chat, the imago agent should still search across drives', () => {
    expect(getBuiltinAgent('imago').enabledTools).toEqual(
      expect.arrayContaining(['multi_drive_search', 'glob_search', 'regex_search', 'read_page']),
    );
  });

  it('given a key, getBuiltinAgent should return that key\'s definition', () => {
    for (const agent of BUILTIN_AGENTS) expect(getBuiltinAgent(agent.key)).toBe(agent);
  });

  it('given an arbitrary string, isBuiltinAgentKey should accept only registry keys', () => {
    expect(isBuiltinAgentKey('imago')).toBe(true);
    expect(isBuiltinAgentKey('Imago')).toBe(false);
    expect(isBuiltinAgentKey('global')).toBe(false);
    expect(isBuiltinAgentKey('')).toBe(false);
  });

  it('given the registry, should be frozen so a caller cannot mutate the shared definitions', () => {
    expect(Object.isFrozen(BUILTIN_AGENTS)).toBe(true);
    for (const agent of BUILTIN_AGENTS) {
      expect(Object.isFrozen(agent)).toBe(true);
      expect(Object.isFrozen(agent.enabledTools)).toBe(true);
    }
  });
});
