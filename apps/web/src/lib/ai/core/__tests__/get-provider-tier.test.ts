import { describe, test } from 'vitest';
import { assert } from './riteway';
import { getProviderTier } from '../ai-providers-config';

describe('getProviderTier', () => {
  test('Anthropic Opus is pro', () => {
    assert({
      given: 'anthropic provider with anthropic/claude-opus-4.8',
      should: 'classify as pro',
      actual: getProviderTier('anthropic', 'anthropic/claude-opus-4.8'),
      expected: 'pro',
    });
  });

  test('Anthropic Sonnet is standard', () => {
    assert({
      given: 'anthropic provider with anthropic/claude-sonnet-4.6',
      should: 'classify as standard (only Opus is gated as pro)',
      actual: getProviderTier('anthropic', 'anthropic/claude-sonnet-4.6'),
      expected: 'standard',
    });
  });

  test('Anthropic Haiku is standard', () => {
    assert({
      given: 'anthropic provider with anthropic/claude-haiku-4.5',
      should: 'classify as standard',
      actual: getProviderTier('anthropic', 'anthropic/claude-haiku-4.5'),
      expected: 'standard',
    });
  });

  test('OpenAI GPT-5 is pro', () => {
    assert({
      given: 'openai provider with openai/gpt-5',
      should: 'classify as pro',
      actual: getProviderTier('openai', 'openai/gpt-5'),
      expected: 'pro',
    });
  });

  test('OpenAI GPT-5 versioned variants are pro', () => {
    assert({
      given: 'openai provider with openai/gpt-5.4-pro',
      should: 'classify as pro',
      actual: getProviderTier('openai', 'openai/gpt-5.4-pro'),
      expected: 'pro',
    });
  });

  test('OpenAI GPT-5 mini is standard', () => {
    assert({
      given: 'openai provider with openai/gpt-5-mini',
      should: 'classify as standard (mini variants are demoted)',
      actual: getProviderTier('openai', 'openai/gpt-5-mini'),
      expected: 'standard',
    });
  });

  test('OpenAI GPT-5.4 mini is standard (mini rule wins over gpt-5)', () => {
    assert({
      given: 'openai provider with openai/gpt-5.4-mini',
      should: 'classify as standard because the mini/nano/flash rule is checked first',
      actual: getProviderTier('openai', 'openai/gpt-5.4-mini'),
      expected: 'standard',
    });
  });

  test('default free model gpt-5.3-chat is standard (free-allowlist override)', () => {
    assert({
      given: 'openai provider with the free-allowlisted default openai/gpt-5.3-chat',
      should: 'classify as standard so free users are not 429d by the legacy daily pro quota',
      actual: getProviderTier('openai', 'openai/gpt-5.3-chat'),
      expected: 'standard',
    });
  });

  test('OpenAI GPT-5.4 nano is standard', () => {
    assert({
      given: 'openai provider with openai/gpt-5.4-nano',
      should: 'classify as standard',
      actual: getProviderTier('openai', 'openai/gpt-5.4-nano'),
      expected: 'standard',
    });
  });

  test('OpenAI o3 is pro', () => {
    assert({
      given: 'openai provider with openai/o3-deep-research',
      should: 'classify as pro',
      actual: getProviderTier('openai', 'openai/o3-deep-research'),
      expected: 'pro',
    });
  });

  test('OpenAI o4-mini is standard', () => {
    assert({
      given: 'openai provider with openai/o4-mini-deep-research',
      should: 'classify as standard (mini variant)',
      actual: getProviderTier('openai', 'openai/o4-mini-deep-research'),
      expected: 'standard',
    });
  });

  test('OpenAI gpt-4o is standard', () => {
    assert({
      given: 'openai provider with openai/gpt-4o',
      should: 'classify as standard (not in pro allowlist)',
      actual: getProviderTier('openai', 'openai/gpt-4o'),
      expected: 'standard',
    });
  });

  test('Namespaced Opus is pro', () => {
    assert({
      given: 'anthropic provider with the full OpenRouter id anthropic/claude-opus-4.7',
      should: 'classify as pro',
      actual: getProviderTier('anthropic', 'anthropic/claude-opus-4.7'),
      expected: 'pro',
    });
  });

  test('Namespaced Sonnet is standard', () => {
    assert({
      given: 'anthropic provider with anthropic/claude-sonnet-4.6',
      should: 'classify as standard',
      actual: getProviderTier('anthropic', 'anthropic/claude-sonnet-4.6'),
      expected: 'standard',
    });
  });

  test('Gemini Flash is standard', () => {
    assert({
      given: 'google provider with google/gemini-2.5-flash',
      should: 'classify as standard',
      actual: getProviderTier('google', 'google/gemini-2.5-flash'),
      expected: 'standard',
    });
  });

  test('Gemini Pro is standard (not in pro allowlist)', () => {
    assert({
      given: 'google provider with google/gemini-2.5-pro',
      should: 'classify as standard',
      actual: getProviderTier('google', 'google/gemini-2.5-pro'),
      expected: 'standard',
    });
  });

  test('Grok is standard', () => {
    assert({
      given: 'xai provider with x-ai/grok-4.3',
      should: 'classify as standard (not in pro allowlist)',
      actual: getProviderTier('xai', 'x-ai/grok-4.3'),
      expected: 'standard',
    });
  });

  test('Missing model defaults to standard', () => {
    assert({
      given: 'no model provided',
      should: 'classify as standard',
      actual: getProviderTier('anthropic', undefined),
      expected: 'standard',
    });
  });

  test('Local provider without a model is standard', () => {
    assert({
      given: 'ollama provider with empty model',
      should: 'classify as standard',
      actual: getProviderTier('ollama', ''),
      expected: 'standard',
    });
  });

  test('MiniMax models are not falsely demoted', () => {
    assert({
      given: 'minimax provider with minimax/minimax-m2.5',
      should: 'classify as standard (the minimax brand should not match the mini demotion)',
      actual: getProviderTier('minimax', 'minimax/minimax-m2.5'),
      expected: 'standard',
    });
  });
});
