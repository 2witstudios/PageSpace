import { describe, it, expect } from 'vitest';
import {
  BUILTIN_AGENTS,
  BUILTIN_AGENT_KEYS,
  getBuiltinAgent,
  isBuiltinAgentKey,
} from '../builtin-agents';

describe('built-in agent registry', () => {
  it('given the registry, should define exactly the imago, imago-planner and imago-researcher keys', () => {
    expect([...BUILTIN_AGENT_KEYS]).toEqual(['imago', 'imago-planner', 'imago-researcher']);
    expect(BUILTIN_AGENTS.map((agent) => agent.key)).toEqual([...BUILTIN_AGENT_KEYS]);
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

  it('given D2, the default imago agent should search across the drives it can reach', () => {
    const imago = getBuiltinAgent('imago');
    expect(imago.enabledTools).toEqual(expect.arrayContaining(['multi_drive_search', 'glob_search', 'regex_search', 'read_page']));
    expect(imago.systemPrompt).toMatch(/permission/i);
  });

  it('given D2, the planner should manage tasks and the researcher should not write', () => {
    expect(getBuiltinAgent('imago-planner').enabledTools).toEqual(
      expect.arrayContaining(['create_task', 'update_task', 'get_assigned_tasks']),
    );
    const researcher = getBuiltinAgent('imago-researcher').enabledTools;
    expect(researcher).toEqual(expect.arrayContaining(['multi_drive_search', 'read_page']));
    for (const write of ['create_page', 'replace_lines', 'insert_content', 'create_task', 'update_task', 'trash_page']) {
      expect(researcher).not.toContain(write);
    }
  });

  it('given a key, getBuiltinAgent should return that key\'s definition', () => {
    for (const agent of BUILTIN_AGENTS) expect(getBuiltinAgent(agent.key)).toBe(agent);
  });

  it('given an arbitrary string, isBuiltinAgentKey should accept only registry keys', () => {
    expect(isBuiltinAgentKey('imago')).toBe(true);
    expect(isBuiltinAgentKey('imago-researcher')).toBe(true);
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
