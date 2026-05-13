import { z } from 'zod';
import type { Tool, ToolSet } from 'ai';
import type { ToolExecutionContext } from '../core';

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
      if (enabledTools != null && !enabledTools.includes(tool_name)) {
        return { error: `Tool "${tool_name}" is not permitted for this agent.` };
      }

      const t = allowedTools[tool_name];
      if (!t) {
        return {
          error: `Unknown tool "${tool_name}". Call tool_search("keyword") to discover available tools.`,
        };
      }
      if (!t.execute) {
        return { error: `Tool "${tool_name}" has no execute implementation.` };
      }
      const realSchema = t.inputSchema as z.ZodType;
      const parsed = realSchema.safeParse(parameters);
      if (!parsed.success) {
        return {
          error: `Invalid parameters for "${tool_name}". Call tool_search("select:${tool_name}") to get the correct parameter schema. Validation errors: ${parsed.error.message}`,
        };
      }
      return (t.execute as (args: unknown, opts: unknown) => unknown)(parsed.data, options);
    },
  };
}
