import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  DETERMINISTIC_TOOL_ALLOWLIST,
  getDeterministicTools,
  getDeterministicToolSchemas,
} from '../deterministic-tools';
import { pageSpaceTools } from '../ai-tools';

describe('deterministic tool allowlist ↔ registry sync', () => {
  it.each([...DETERMINISTIC_TOOL_ALLOWLIST])(
    '%s exists in pageSpaceTools with an execute and a zod inputSchema',
    (name) => {
      const tool = (pageSpaceTools as Record<string, { execute?: unknown; inputSchema?: unknown }>)[
        name
      ];
      expect(tool, `"${name}" missing from the registry — update the allowlist`).toBeDefined();
      expect(typeof tool.execute, `"${name}" has no execute`).toBe('function');
      expect(tool.inputSchema instanceof z.ZodType, `"${name}" inputSchema is not zod`).toBe(true);
    }
  );

  it('getDeterministicTools returns exactly the allowlist', () => {
    expect(Object.keys(getDeterministicTools()).sort()).toEqual(
      [...DETERMINISTIC_TOOL_ALLOWLIST].sort()
    );
  });

  it('getDeterministicToolSchemas covers every allowlisted tool', () => {
    expect(Object.keys(getDeterministicToolSchemas()).sort()).toEqual(
      [...DETERMINISTIC_TOOL_ALLOWLIST].sort()
    );
  });

  it('never exposes structurally unsafe tools', () => {
    const names: readonly string[] = DETERMINISTIC_TOOL_ALLOWLIST;
    for (const banned of ['ask_user', 'execute_tool', 'generate_image', 'trash_drive']) {
      expect(names).not.toContain(banned);
    }
  });
});
