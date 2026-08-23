import { z } from 'zod';
import type { Tool, ToolSet } from 'ai';
import type { ToolExecutionContext } from '../core/types';
import { formatInvalidParametersError, formatUnknownToolError } from './tool-error-schema';

export function createExecuteTool(allowedTools: ToolSet): Tool {
  return {
    description:
      'Execute any PageSpace tool by name. Call tool_search first to discover available tools and get their parameter schemas.',
    inputSchema: z.object({
      tool_name: z.string(),
      parameters: z.record(z.string(), z.unknown()).default({}),
    }),
    execute: async (
      { tool_name, parameters }: { tool_name: string; parameters: Record<string, unknown> },
      options: unknown
    ) => {
      const enabledTools = (options as { experimental_context?: ToolExecutionContext })
        ?.experimental_context?.enabledTools;

      const t = allowedTools[tool_name];
      if (!t) {
        // A name that is in no registry at all is a MISTAKE, not a permission
        // outcome, and answering it with "not permitted" (as this did while the
        // allowlist check ran first) sent an agent looking for a setting to
        // change instead of a typo to fix. The allowlist still gates below;
        // nothing reaches `execute` without passing it.
        //
        // Suggestions come from what THIS caller may actually run, not from the
        // whole registry — naming a tool the agent's owner switched off would
        // trade an unknown-tool error for a not-permitted one.
        const reachable = Object.keys(allowedTools).filter(
          (name) => enabledTools == null || enabledTools.includes(name)
        );
        return { error: formatUnknownToolError(tool_name, reachable) };
      }
      if (enabledTools != null && !enabledTools.includes(tool_name)) {
        return { error: `Tool "${tool_name}" is not permitted for this agent.` };
      }
      if (!t.execute) {
        return { error: `Tool "${tool_name}" has no execute implementation.` };
      }
      const realSchema = t.inputSchema as z.ZodType;
      const parsed = realSchema.safeParse(parameters);
      if (!parsed.success) {
        // The schema goes in the error rather than a pointer to `tool_search`:
        // it is right here, and the pointer cost a round trip on every
        // first-use parameter mistake. See `tool-error-schema.ts`.
        return { error: formatInvalidParametersError(tool_name, realSchema, parsed.error.message) };
      }
      return (t.execute as (args: unknown, opts: unknown) => unknown)(parsed.data, options);
    },
  };
}
