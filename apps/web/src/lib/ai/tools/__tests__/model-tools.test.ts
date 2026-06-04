import { describe, it, expect, vi } from 'vitest';

vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  MODEL_CONTEXT_WINDOWS: {
    'openai/gpt-5.3-chat': 400000,
  },
}));

import { modelTools } from '../model-tools';
import type { ToolExecutionContext } from '../../core';

type ListModelsResult = {
  providers: Array<{ provider: string; dynamic: boolean; models: Array<{ id: string; free: boolean }> }>;
};

const run = async (
  args: { provider?: string; freeOnly?: boolean },
  experimentalContext: Partial<ToolExecutionContext>,
): Promise<ListModelsResult> => {
  const result = await modelTools.list_models.execute!(args, {
    toolCallId: '1',
    messages: [],
    experimental_context: experimentalContext as ToolExecutionContext,
  });
  return result as unknown as ListModelsResult;
};

const ctx: Partial<ToolExecutionContext> = { userId: 'user-1' };

describe('list_models tool', () => {
  it('returns the full provider catalog', async () => {
    const result = await run({}, ctx);
    expect(result.providers.some((p) => p.provider === 'openai')).toBe(true);
    expect(result.providers.some((p) => p.provider === 'anthropic')).toBe(true);
  });

  it('filters to a single provider', async () => {
    const result = await run({ provider: 'anthropic' }, ctx);
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].provider).toBe('anthropic');
  });

  it('freeOnly strips non-free models and empty static providers', async () => {
    const result = await run({ freeOnly: true }, ctx);
    for (const p of result.providers) {
      if (!p.dynamic) {
        expect(p.models.length).toBeGreaterThan(0);
        expect(p.models.every((m) => m.free)).toBe(true);
      }
    }
  });

  it('throws without an authenticated user', async () => {
    await expect(run({}, {})).rejects.toThrow(/authentication required/i);
  });
});
