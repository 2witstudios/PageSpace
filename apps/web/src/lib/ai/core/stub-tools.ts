import { z } from 'zod';
import type { Tool } from 'ai';

export const CORE_TOOL_NAMES = new Set([
  'list_drives',
  'list_pages',
  'read_page',
  'get_page_details',
  'create_page',
  'replace_lines',
  'regex_search',
  'multi_drive_search',
]);

function wrapWithStub(name: string, t: Tool): Tool {
  const realSchema = t.inputSchema as z.ZodType;
  return {
    ...t,
    inputSchema: z.object({}).passthrough(),
    execute: async (rawArgs: unknown, options: unknown) => {
      const parsed = realSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          error: `Invalid arguments for ${name}. Call tool_search("${name}") to get the correct parameter schema.`,
        };
      }
      return (t.execute as (args: unknown, opts: unknown) => unknown)(parsed.data, options);
    },
  };
}

export function buildStubbedTools<T extends Record<string, Tool>>(tools: T): T {
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => [
      name,
      CORE_TOOL_NAMES.has(name) ? t : wrapWithStub(name, t),
    ])
  ) as T;
}
