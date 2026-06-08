import { tool } from 'ai';
import { z } from 'zod';
import { buildModelCatalog } from '../core/model-catalog';
import type { ToolExecutionContext } from '../core/types';

/**
 * Read-only tool exposing the real AI model catalog so an agent uses a valid
 * model id when configuring another agent (via `update_agent_config`) instead of
 * inventing one. Not a write tool — must never appear in `WRITE_TOOLS`.
 */
export const modelTools = {
  list_models: tool({
    description:
      'List the AI providers and models that can be assigned to an agent via update_agent_config. ALWAYS call this before setting aiProvider/aiModel so you use a real model id and never invent one. Returns model id, display name, provider, free-tier flag, and context window.',
    inputSchema: z.object({
      provider: z
        .string()
        .optional()
        .describe('Filter to one provider key, e.g. "openai", "anthropic".'),
      freeOnly: z
        .boolean()
        .optional()
        .describe('If true, only return free-tier models.'),
    }),
    execute: async ({ provider, freeOnly }, { experimental_context: context }) => {
      const userId = (context as ToolExecutionContext)?.userId;
      if (!userId) {
        throw new Error('User authentication required');
      }

      let providers = buildModelCatalog();
      if (provider) {
        providers = providers.filter((p) => p.provider === provider);
      }
      if (freeOnly) {
        providers = providers
          .map((p) => ({ ...p, models: p.models.filter((m) => m.free) }))
          .filter((p) => p.models.length > 0 || p.dynamic);
      }

      return { providers };
    },
  }),
};
