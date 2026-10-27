/**
 * The built-in agent registry lives in @pagespace/lib, which cannot import the
 * web-owned tool registry. This is the one place that sees both, so it is where
 * "every tool a built-in agent is configured with actually exists" is enforced:
 * a renamed or removed tool turns this red instead of silently dropping out of
 * the agent's allowlist (`agent-tool-surface.ts` would report it not_registered).
 */
import { describe, it, expect } from 'vitest';
import { BUILTIN_AGENTS } from '@pagespace/lib/agents/builtin-agents';
import { WORKSPACE_TOOL_NAMES } from '../../tools';
import { RUNTIME_TOGGLE_TOOL_NAMES } from '../agent-tool-surface';

const registered = new Set(WORKSPACE_TOOL_NAMES);

describe.each(BUILTIN_AGENTS.map((agent) => [agent.key, agent] as const))('built-in agent %s', (_key, agent) => {
  it('should only enable tools that exist in the workspace tool registry', () => {
    expect(agent.enabledTools.filter((tool) => !registered.has(tool))).toEqual([]);
  });

  it('should not list a runtime-toggle tool, which an allowlist cannot grant', () => {
    expect(agent.enabledTools.filter((tool) => RUNTIME_TOGGLE_TOOL_NAMES.has(tool))).toEqual([]);
  });
});
