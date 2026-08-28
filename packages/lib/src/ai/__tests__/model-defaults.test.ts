import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AI_PROVIDER,
  DEFAULT_AI_MODEL,
  METERING_EXEMPT_PROVIDERS,
  isMeteringExempt,
} from '../model-defaults';

describe('model-defaults', () => {
  it('defaults to the Z.ai GLM-5.3 Flash product default (OpenRouter-backed)', () => {
    expect(DEFAULT_AI_PROVIDER).toBe('zai');
    expect(DEFAULT_AI_MODEL).toBe('z-ai/glm-5.3-flash');
  });

  it('uses a vendor-prefixed (OpenRouter) model id', () => {
    // The internal provider key (e.g. `zai`, `xai`) doesn't always match the
    // OpenRouter vendor slug in the model id (e.g. `z-ai/`, `x-ai/`) — just
    // confirm the model id itself is in OpenRouter's `vendor/model` format.
    expect(DEFAULT_AI_MODEL).toMatch(/^[\w-]+\/[\w.-]+$/);
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
