import { describe, it, expect, vi } from 'vitest';
import {
  buildAiProviderErasureManifest,
  eraseAiProviderData,
  type AiProviderForwarder,
} from '../ai-provider-erasure';

describe('buildAiProviderErasureManifest', () => {
  it('given cloud-vendor providers, should rely on the gateway ZDR posture', () => {
    const manifest = buildAiProviderErasureManifest({
      userId: 'u1',
      providers: ['openai', 'anthropic', 'openrouter'],
      deploymentMode: 'cloud',
    });
    const actions = Object.fromEntries(manifest.entries.map((e) => [e.provider, e.action]));
    expect(actions.openai).toBe('rely_on_zdr');
    expect(actions.anthropic).toBe('rely_on_zdr');
    expect(actions.openrouter).toBe('rely_on_zdr');
    expect(manifest.requiresManualReview).toBe(false);
  });

  it('given local providers, should skip them (no external retention)', () => {
    const manifest = buildAiProviderErasureManifest({
      userId: 'u1',
      providers: ['ollama', 'lmstudio'],
      deploymentMode: 'cloud',
    });
    expect(manifest.entries.every((e) => e.action === 'skip_local')).toBe(true);
  });

  it('given an unknown provider, should flag manual review', () => {
    const manifest = buildAiProviderErasureManifest({
      userId: 'u1',
      providers: ['some_new_provider'],
      deploymentMode: 'cloud',
    });
    expect(manifest.entries[0].action).toBe('manual_review');
    expect(manifest.requiresManualReview).toBe(true);
  });

  it('should normalize + dedupe provider names', () => {
    const manifest = buildAiProviderErasureManifest({
      userId: 'u1',
      providers: ['OpenAI', 'openai', ' anthropic '],
      deploymentMode: 'cloud',
    });
    expect(manifest.entries.map((e) => e.provider).sort()).toEqual(['anthropic', 'openai']);
  });

  it('given on-prem, should treat every provider as local skip', () => {
    const manifest = buildAiProviderErasureManifest({
      userId: 'u1',
      providers: ['openai', 'ollama'],
      deploymentMode: 'onprem',
    });
    expect(manifest.entries.every((e) => e.action === 'skip_local')).toBe(true);
    expect(manifest.requiresManualReview).toBe(false);
  });
});

describe('eraseAiProviderData', () => {
  it('given forwardable providers, should invoke the forwarder and count evidence entries', async () => {
    const forwarder: AiProviderForwarder = { forwardDeletion: vi.fn().mockResolvedValue(undefined) };
    const result = await eraseAiProviderData(
      { userId: 'u1', providers: ['openrouter'], deploymentMode: 'cloud' },
      forwarder,
      { forwardZdr: true }
    );
    expect(forwarder.forwardDeletion).toHaveBeenCalledTimes(1);
    expect(result.forwarded).toBe(1);
    expect(result.evidence).toHaveLength(1);
  });

  it('by default, should record ZDR reliance without forwarding (no per-user delete API)', async () => {
    const forwarder: AiProviderForwarder = { forwardDeletion: vi.fn() };
    const result = await eraseAiProviderData(
      { userId: 'u1', providers: ['openai', 'anthropic'], deploymentMode: 'cloud' },
      forwarder
    );
    expect(forwarder.forwardDeletion).not.toHaveBeenCalled();
    expect(result.forwarded).toBe(0);
    expect(result.evidence).toHaveLength(2);
  });

  it('given a forwarder throws, should not block erasure and should count the failure', async () => {
    const forwarder: AiProviderForwarder = {
      forwardDeletion: vi.fn().mockRejectedValue(new Error('gateway 500')),
    };
    const result = await eraseAiProviderData(
      { userId: 'u1', providers: ['openrouter'], deploymentMode: 'cloud' },
      forwarder,
      { forwardZdr: true }
    );
    expect(result.failed).toBe(1);
  });
});
