import { describe, test } from 'vitest';
import { assert } from './riteway';
import { getProviderTier } from '../ai-providers-config';

describe('getProviderTier', () => {
  test('pagespace standard model', () => {
    assert({
      given: 'pagespace provider with glm-4.7',
      should: 'classify as standard',
      actual: getProviderTier('pagespace', 'glm-4.7'),
      expected: 'standard',
    });
  });

  test('pagespace pro model', () => {
    assert({
      given: 'pagespace provider with glm-5',
      should: 'classify as pro',
      actual: getProviderTier('pagespace', 'glm-5'),
      expected: 'pro',
    });
  });

  test('pagespace alias resolution', () => {
    assert({
      given: 'pagespace provider with the "pro" alias',
      should: 'classify as pro after alias resolution',
      actual: getProviderTier('pagespace', 'pro'),
      expected: 'pro',
    });
  });

  test('Anthropic Opus is pro', () => {
    assert({
      given: 'anthropic provider with claude-opus-4.6',
      should: 'classify as pro',
      actual: getProviderTier('anthropic', 'claude-opus-4.6'),
      expected: 'pro',
    });
  });

  test('Anthropic Sonnet is standard', () => {
    assert({
      given: 'anthropic provider with claude-sonnet-4.6',
      should: 'classify as standard (only Opus is gated as pro)',
      actual: getProviderTier('anthropic', 'claude-sonnet-4.6'),
      expected: 'standard',
    });
  });

  test('Anthropic Haiku is standard', () => {
    assert({
      given: 'anthropic provider with claude-haiku-4.5',
      should: 'classify as standard',
      actual: getProviderTier('anthropic', 'claude-haiku-4.5'),
      expected: 'standard',
    });
  });

  test('OpenAI GPT-5 is pro', () => {
    assert({
      given: 'openai provider with gpt-5',
      should: 'classify as pro',
      actual: getProviderTier('openai', 'gpt-5'),
      expected: 'pro',
    });
  });

  test('OpenAI GPT-5 versioned variants are pro', () => {
    assert({
      given: 'openai provider with gpt-5.4-pro',
      should: 'classify as pro',
      actual: getProviderTier('openai', 'gpt-5.4-pro'),
      expected: 'pro',
    });
  });

  test('OpenAI GPT-5 mini is standard', () => {
    assert({
      given: 'openai provider with gpt-5-mini',
      should: 'classify as standard (mini variants are demoted)',
      actual: getProviderTier('openai', 'gpt-5-mini'),
      expected: 'standard',
    });
  });

  test('OpenAI GPT-5.2 nano is standard', () => {
    assert({
      given: 'openai provider with gpt-5.2-nano',
      should: 'classify as standard',
      actual: getProviderTier('openai', 'gpt-5.2-nano'),
      expected: 'standard',
    });
  });

  test('OpenAI o3 is pro', () => {
    assert({
      given: 'openai provider with o3-deep-research',
      should: 'classify as pro',
      actual: getProviderTier('openai', 'o3-deep-research'),
      expected: 'pro',
    });
  });

  test('OpenAI o4-mini is standard', () => {
    assert({
      given: 'openai provider with o4-mini-deep-research',
      should: 'classify as standard (mini variant)',
      actual: getProviderTier('openai', 'o4-mini-deep-research'),
      expected: 'standard',
    });
  });

  test('OpenAI gpt-4o is standard', () => {
    assert({
      given: 'openai provider with gpt-4o',
      should: 'classify as standard (not in pro allowlist)',
      actual: getProviderTier('openai', 'gpt-4o'),
      expected: 'standard',
    });
  });

  test('OpenRouter namespaced GLM 5 is pro', () => {
    assert({
      given: 'openrouter provider with z-ai/glm-5',
      should: 'classify as pro',
      actual: getProviderTier('openrouter', 'z-ai/glm-5'),
      expected: 'pro',
    });
  });

  test('OpenRouter namespaced Opus is pro', () => {
    assert({
      given: 'openrouter provider with anthropic/claude-opus-4.6',
      should: 'classify as pro',
      actual: getProviderTier('openrouter', 'anthropic/claude-opus-4.6'),
      expected: 'pro',
    });
  });

  test('OpenRouter Sonnet via namespaced ID is standard', () => {
    assert({
      given: 'openrouter provider with anthropic/claude-sonnet-4.6',
      should: 'classify as standard',
      actual: getProviderTier('openrouter', 'anthropic/claude-sonnet-4.6'),
      expected: 'standard',
    });
  });

  test('Gemini Flash is standard', () => {
    assert({
      given: 'google provider with gemini-2.5-flash',
      should: 'classify as standard',
      actual: getProviderTier('google', 'gemini-2.5-flash'),
      expected: 'standard',
    });
  });

  test('Gemini Pro is standard (not in pro allowlist)', () => {
    assert({
      given: 'google provider with gemini-2.5-pro',
      should: 'classify as standard',
      actual: getProviderTier('google', 'gemini-2.5-pro'),
      expected: 'standard',
    });
  });

  test('Grok 4 is standard', () => {
    assert({
      given: 'xai provider with grok-4',
      should: 'classify as standard (not in pro allowlist)',
      actual: getProviderTier('xai', 'grok-4'),
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
      should: 'classify as standard (minimax brand should not match the mini demotion)',
      actual: getProviderTier('openrouter', 'minimax/minimax-m2.5'),
      expected: 'standard',
    });
  });
});
