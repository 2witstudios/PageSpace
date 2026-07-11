import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assert } from '@/lib/ai/core/__tests__/riteway';
import type { ToolExecutionContext } from '@/lib/ai/core/types';

// --- module mocks (no real billing / OpenRouter / S3 / DB) ---
const canConsumeAI = vi.fn<(...a: unknown[]) => unknown>();
const releaseHold = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
const trackUsage = vi.fn<(...a: unknown[]) => Promise<void>>(async () => {});
const generateImageBytes = vi.fn<(...a: unknown[]) => unknown>();
const createImageFilePage = vi.fn<(...a: unknown[]) => unknown>();

vi.mock('@pagespace/lib/billing/credit-gate', () => ({ canConsumeAI: (...a: unknown[]) => canConsumeAI(...a) }));
vi.mock('@pagespace/lib/billing/credit-consume', () => ({ releaseHold: (...a: unknown[]) => releaseHold(...a) }));
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({ AIMonitoring: { trackUsage: (...a: unknown[]) => trackUsage(...a) } }));
vi.mock('../../core/image-generation', async (orig) => ({
  ...(await orig<typeof import('../../core/image-generation')>()),
  generateImageBytes: (...a: unknown[]) => generateImageBytes(...a),
}));
vi.mock('@/lib/upload/create-file-page', () => ({
  createImageFilePage: (...a: unknown[]) => createImageFilePage(...a),
  ImageStorageQuotaError: class ImageStorageQuotaError extends Error {},
}));

import { imageGenerationTools } from '../image-generation-tools';
import { isImageGenerationAllowedForTier } from '@/lib/ai/core/image-gen-access';
import { pageSpaceTools } from '@/lib/ai/core/ai-tools';
import { filterToolsForReadOnly, isWriteTool } from '@/lib/ai/core/tool-filtering';

const run = (input: Record<string, unknown>, ctx: Partial<ToolExecutionContext>) =>
  imageGenerationTools.generate_image.execute!(input as never, {
    toolCallId: 't1',
    messages: [],
    experimental_context: ctx as ToolExecutionContext,
  });

beforeEach(() => {
  canConsumeAI.mockReset();
  releaseHold.mockReset();
  releaseHold.mockResolvedValue(undefined);
  trackUsage.mockReset();
  trackUsage.mockResolvedValue(undefined);
  generateImageBytes.mockReset();
  createImageFilePage.mockReset();
});

describe('isImageGenerationAllowedForTier (pure)', () => {
  it('allows paid tiers, denies free/unknown', () => {
    assert({
      given: 'the four tiers + undefined',
      should: 'allow pro/founder/business only',
      actual: ['free', 'pro', 'founder', 'business', undefined].map(isImageGenerationAllowedForTier),
      expected: [false, true, true, true, false],
    });
  });
});

describe('generate_image registration', () => {
  it('is registered, is a write tool, and is excluded in read-only mode', () => {
    expect(Object.keys(pageSpaceTools)).toContain('generate_image');
    expect(isWriteTool('generate_image')).toBe(true);
    const readOnly = filterToolsForReadOnly(pageSpaceTools, true);
    expect(Object.keys(readOnly)).not.toContain('generate_image');
  });
});

describe('generate_image execute', () => {
  it('generates, files into the drive, settles the hold, and returns a viewUrl', async () => {
    canConsumeAI.mockResolvedValue({ allowed: true, holdId: 'hold-1' });
    generateImageBytes.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: 'image/jpeg',
      providerCostDollars: 0.068,
      generationIds: ['gen-1'],
    });
    createImageFilePage.mockResolvedValue({ pageId: 'page-9', driveId: 'home-1', parentId: 'gallery-1' });

    const res = (await run(
      { prompt: 'a red panda astronaut' },
      { userId: 'u1', subscriptionTier: 'pro', imageGenerationModel: 'google/gemini-3.1-flash-image-preview' },
    )) as { success: boolean; pageId: string; viewUrl: string };

    assert({
      given: 'a Pro user and a working model',
      should: 'return success with the file view URL',
      actual: { success: res.success, viewUrl: res.viewUrl },
      expected: { success: true, viewUrl: '/api/files/page-9/view' },
    });
    expect(trackUsage).toHaveBeenCalledOnce();
    const usage = trackUsage.mock.calls[0][0] as { holdId: string; providerCostDollars: number; source: string };
    expect(usage).toMatchObject({ holdId: 'hold-1', providerCostDollars: 0.068, source: 'image_generation' });
    expect(releaseHold).not.toHaveBeenCalled();
  });

  it('denies a free-tier user without any OpenRouter call or hold', async () => {
    const res = (await run({ prompt: 'x' }, { userId: 'u1', subscriptionTier: 'free' })) as { success: boolean };
    expect(res.success).toBe(false);
    expect(canConsumeAI).not.toHaveBeenCalled();
    expect(generateImageBytes).not.toHaveBeenCalled();
  });

  it('releases the hold and fails softly when generation errors', async () => {
    canConsumeAI.mockResolvedValue({ allowed: true, holdId: 'hold-2' });
    generateImageBytes.mockRejectedValue(new Error('model down'));

    const res = (await run({ prompt: 'x' }, { userId: 'u1', subscriptionTier: 'pro' })) as { success: boolean };
    expect(res.success).toBe(false);
    expect(releaseHold).toHaveBeenCalledWith('hold-2');
    expect(createImageFilePage).not.toHaveBeenCalled();
  });

  it('fails softly when credits are exhausted', async () => {
    canConsumeAI.mockResolvedValue({ allowed: false });
    const res = (await run({ prompt: 'x' }, { userId: 'u1', subscriptionTier: 'pro' })) as { success: boolean };
    expect(res.success).toBe(false);
    expect(generateImageBytes).not.toHaveBeenCalled();
  });
});
