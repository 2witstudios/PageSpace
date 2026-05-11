import { z } from 'zod';
import type { Tool, ToolSet } from 'ai';

export function createToolSearchTool(fullTools: ToolSet): Tool {
  return {
    description:
      'Get full parameter schemas for any PageSpace tool before calling it. Use "select:name1,name2" for specific tools by name, or a keyword like "calendar", "agent", "task", "channel", "drive" to find all tools in that area.',
    inputSchema: z.object({
      query: z.string().describe(
        'Either "select:name1,name2" for specific tools or a search keyword'
      ),
    }),
    execute: async ({ query }: { query: string }) => {
      const matches = resolveMatches(fullTools, query);
      const result = Object.entries(matches).map(([name, t]) => ({
        name,
        description: t.description,
        inputSchema: z.toJSONSchema(t.inputSchema as z.ZodType),
      }));
      return { tools: result };
    },
  };
}

function resolveMatches(tools: ToolSet, query: string): ToolSet {
  if (query.startsWith('select:')) {
    const names = query.slice(7).split(',').map((s) => s.trim());
    return Object.fromEntries(names.filter((n) => tools[n]).map((n) => [n, tools[n]]));
  }
  const kw = query.toLowerCase();
  return Object.fromEntries(
    Object.entries(tools).filter(
      ([name, t]) => name.includes(kw) || (t.description ?? '').toLowerCase().includes(kw)
    )
  );
}
