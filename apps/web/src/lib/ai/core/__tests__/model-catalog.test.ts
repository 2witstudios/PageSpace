import { describe, it, expect, afterEach, vi } from 'vitest';

// Mock the server-only monitoring module so the test never pulls in the DB client.
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  MODEL_CONTEXT_WINDOWS: {
    'openai/gpt-5.3-chat': 400000,
    'anthropic/claude-opus-4.8': 200000,
  },
}));

import { buildModelCatalog } from '../model-catalog';

describe('buildModelCatalog', () => {
  const origNextPublic = process.env.NEXT_PUBLIC_DEPLOYMENT_MODE;
  const origServer = process.env.DEPLOYMENT_MODE;

  afterEach(() => {
    process.env.NEXT_PUBLIC_DEPLOYMENT_MODE = origNextPublic;
    process.env.DEPLOYMENT_MODE = origServer;
  });

  it('returns providers each with provider/name/dynamic/models', () => {
    const catalog = buildModelCatalog();
    const openai = catalog.find((p) => p.provider === 'openai');
    expect(openai).toBeDefined();
    expect(openai!.name).toBe('OpenAI');
    expect(openai!.dynamic).toBe(false);
    expect(openai!.models.length).toBeGreaterThan(0);
  });

  it('populates a known model with id/displayName/free/contextWindow', () => {
    const catalog = buildModelCatalog();
    const openai = catalog.find((p) => p.provider === 'openai')!;
    const model = openai.models.find((m) => m.id === 'openai/gpt-5.3-chat');
    expect(model).toEqual({
      id: 'openai/gpt-5.3-chat',
      displayName: 'GPT-5.3 Chat',
      provider: 'openai',
      free: true,
      contextWindow: 400000,
    });
  });

  it('omits contextWindow when unknown for a model', () => {
    const catalog = buildModelCatalog();
    const openai = catalog.find((p) => p.provider === 'openai')!;
    const noWindow = openai.models.find((m) => m.id === 'openai/gpt-4o');
    expect(noWindow).toBeDefined();
    expect(noWindow!.contextWindow).toBeUndefined();
  });

  it('marks frontier models as not free', () => {
    const catalog = buildModelCatalog();
    const anthropic = catalog.find((p) => p.provider === 'anthropic')!;
    const opus = anthropic.models.find((m) => m.id === 'anthropic/claude-opus-4.8')!;
    expect(opus.free).toBe(false);
  });

  it('marks local providers dynamic with empty models', () => {
    const catalog = buildModelCatalog();
    const ollama = catalog.find((p) => p.provider === 'ollama')!;
    expect(ollama.dynamic).toBe(true);
    expect(ollama.models).toEqual([]);
  });

  it('on-prem mode returns only local/Azure providers', () => {
    process.env.NEXT_PUBLIC_DEPLOYMENT_MODE = 'onprem';
    process.env.DEPLOYMENT_MODE = 'onprem';
    const providers = buildModelCatalog().map((p) => p.provider);
    expect(providers).not.toContain('openai');
    expect(providers).not.toContain('anthropic');
    for (const p of providers) {
      expect(['ollama', 'lmstudio', 'azure_openai']).toContain(p);
    }
  });
});
