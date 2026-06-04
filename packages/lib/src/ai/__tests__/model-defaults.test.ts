import { describe, it, expect } from 'vitest';
import { DEFAULT_AI_PROVIDER, DEFAULT_AI_MODEL } from '../model-defaults';

describe('model-defaults', () => {
  it('defaults to the OpenAI GPT-5.3 Chat product default (OpenRouter-backed)', () => {
    expect(DEFAULT_AI_PROVIDER).toBe('openai');
    expect(DEFAULT_AI_MODEL).toBe('openai/gpt-5.3-chat');
  });

  it('uses a vendor-prefixed (OpenRouter) model id', () => {
    expect(DEFAULT_AI_MODEL.startsWith(`${DEFAULT_AI_PROVIDER}/`)).toBe(true);
  });
});
