import { z } from 'zod';
import type { Tool } from 'ai';
import { TOOL_DOC_CATEGORIES, getToolDoc } from '../docs/index';

export function createToolDocsTool(): Tool {
  return {
    description:
      `Get usage guidance for a PageSpace tool category before calling unfamiliar tools. Returns concept overview, data model, example workflows, and common mistakes. Categories: ${TOOL_DOC_CATEGORIES.join(', ')}`,
    inputSchema: z.object({
      category: z.enum(TOOL_DOC_CATEGORIES).describe(
        'Tool category to get guidance for: pages | task-lists | sheets | calendar | agents | channels | drives'
      ),
    }),
    execute: async ({ category }: { category: string }) => {
      const content = getToolDoc(category);
      if (!content) {
        return { error: `No documentation found for category "${category}". Valid categories: ${TOOL_DOC_CATEGORIES.join(', ')}` };
      }
      return { category, content };
    },
  };
}
