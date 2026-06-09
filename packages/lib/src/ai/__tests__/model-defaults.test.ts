import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AI_PROVIDER,
  DEFAULT_AI_MODEL,
  METERING_EXEMPT_PROVIDERS,
  isMeteringExempt,
} from '../model-defaults';

describe('model-defaults', () => {
  it('defaults to the OpenAI GPT-5.3 Chat product default (OpenRouter-backed)', () => {
    expect(DEFAULT_AI_PROVIDER).toBe('openai');
    expect(DEFAULT_AI_MODEL).toBe('openai/gpt-5.3-chat');
  });

  it('uses a vendor-prefixed (OpenRouter) model id', () => {
    expect(DEFAULT_AI_MODEL.startsWith(`${DEFAULT_AI_PROVIDER}/`)).toBe(true);
  });
});

describe('isMeteringExempt', () => {
  it('exempts the admin Z.ai Coder Plan provider (glm)', () => {
    expect(METERING_EXEMPT_PROVIDERS.has('glm')).toBe(true);
    expect(isMeteringExempt('glm')).toBe(true);
  });

  it('does NOT exempt the public OpenRouter-backed Z.ai provider (zai) or other vendors', () => {
    expect(isMeteringExempt('zai')).toBe(false);
    expect(isMeteringExempt('openai')).toBe(false);
    expect(isMeteringExempt('anthropic')).toBe(false);
  });

  it('treats null/undefined/empty as not exempt', () => {
    expect(isMeteringExempt(null)).toBe(false);
    expect(isMeteringExempt(undefined)).toBe(false);
    expect(isMeteringExempt('')).toBe(false);
  });
});
