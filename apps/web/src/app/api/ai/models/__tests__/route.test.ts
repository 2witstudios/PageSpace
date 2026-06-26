import { describe, it, expect, vi } from 'vitest';

// Mock the server-only catalog builder's monitoring dep so no DB client loads.
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  MODEL_CONTEXT_WINDOWS: {
    'openai/gpt-5.3-chat': 400000,
  },
}));

import { GET } from '../route';

describe('GET /api/ai/models', () => {
  it('returns providers, defaultProvider and defaultModel with no auth', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.defaultProvider).toBe('openai');
    expect(body.defaultModel).toBe('openai/gpt-5.3-codex');
  });

  it('includes a known model and never includes pricing', async () => {
    const res = await GET();
    const body = await res.json();
    const openai = body.providers.find((p: { provider: string }) => p.provider === 'openai');
    const model = openai.models.find((m: { id: string }) => m.id === 'openai/gpt-5.3-chat');
    expect(model.free).toBe(true);
    expect(model.contextWindow).toBe(400000);
    expect(model).not.toHaveProperty('pricing');
  });

  it('sets a public Cache-Control header', async () => {
    const res = await GET();
    expect(res.headers.get('Cache-Control')).toMatch(/public/);
  });
});
