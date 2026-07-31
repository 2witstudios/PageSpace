import { z } from 'zod';
import { pageSpaceTools } from './ai-tools';
import type { SchemaLike } from '@/lib/workflows/core/step-validation';

/**
 * Tools deterministic workflow steps may invoke directly (no LLM).
 *
 * Explicit allowlist, not exclude-known-bad: a new registry tool is NOT
 * deterministically invocable until deliberately added here. Excluded by
 * construction: ask_user (no execute), sandbox/terminal tools (need
 * machineBinding), image generation (consumes AI), agent-communication,
 * meta-tools (execute_tool / tool_search).
 *
 * The registry-sync test (deterministic-tools.test.ts) fails the build if an
 * allowlisted name disappears from pageSpaceTools or loses its execute — that
 * test is the drift guard, keep it in lockstep with this list.
 */
export const DETERMINISTIC_TOOL_ALLOWLIST = [
  'insert_content',
  'replace_lines',
  'create_page',
  'send_channel_message',
  'create_task',
  'update_task',
] as const;

export type DeterministicToolName = (typeof DETERMINISTIC_TOOL_ALLOWLIST)[number];

type RegistryTool = {
  inputSchema?: unknown;
  execute?: (args: never, options: never) => unknown;
};

/** The allowlisted subset of pageSpaceTools, keyed by tool name. */
export function getDeterministicTools(): Record<string, RegistryTool> {
  const registry = pageSpaceTools as Record<string, RegistryTool>;
  return Object.fromEntries(
    DETERMINISTIC_TOOL_ALLOWLIST.filter((name) => name in registry).map((name) => [
      name,
      registry[name],
    ])
  );
}

/**
 * Zod input schemas for the allowlisted tools, in the injected shape the pure
 * step-validation core expects (the core must never import this module or the
 * registry — tool modules perform I/O at import time).
 */
export function getDeterministicToolSchemas(): Record<string, SchemaLike> {
  const entries = Object.entries(getDeterministicTools()).flatMap(([name, tool]) => {
    const schema = tool.inputSchema;
    return schema instanceof z.ZodType ? [[name, schema as SchemaLike] as const] : [];
  });
  return Object.fromEntries(entries);
}
