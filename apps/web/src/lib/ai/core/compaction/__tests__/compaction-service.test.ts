import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../compaction-repository', () => ({
  getState: vi.fn(),
  upsertState: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: vi.fn(),
  isProviderError: vi.fn((r) => typeof r?.error === 'string'),
}));

vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: vi.fn() },
}));

vi.mock('@pagespace/lib/monitoring/ai-context-calculator', () => ({
  estimateTokens: vi.fn((t: string) => Math.ceil(t.length / 4)),
}));

vi.mock('@pagespace/lib/monitoring/chat-pricing', () => ({
  estimateChatHoldCentsForModel: vi.fn(() => 5),
}));

vi.mock('@/lib/ai/core/user-credit-hold', () => ({
  gateUserCall: vi.fn(),
}));

vi.mock('@pagespace/lib/billing/credit-consume', () => ({
  releaseHold: vi.fn(async () => undefined),
}));

import { generateText } from 'ai';
import { getState, upsertState } from '../compaction-repository';
import { createAIProvider } from '@/lib/ai/core/provider-factory';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
import { gateUserCall } from '@/lib/ai/core/user-credit-hold';
import { releaseHold } from '@pagespace/lib/billing/credit-consume';
import { automationSpend, conversationSpend } from '@pagespace/lib/billing/spend-target';
import { runCompaction } from '../compaction-service';
import type { CompactionPlan } from '@pagespace/lib/ai/context-window';

const mockGetState = vi.mocked(getState);
const mockUpsertState = vi.mocked(upsertState);
const mockGenerateText = vi.mocked(generateText);
const mockCreateAIProvider = vi.mocked(createAIProvider);
const mockTrackUsage = vi.mocked(AIMonitoring.trackUsage);
const mockGate = vi.mocked(gateUserCall);
const mockReleaseHold = vi.mocked(releaseHold);

function makePlan(overrides?: Partial<CompactionPlan>): CompactionPlan {
  return {
    reason: 'over-soft-threshold',
    cutBeforeIndex: 2,
    estimatedTailTokens: 100,
    messagesToSummarize: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }], createdAt: new Date('2024-01-01T00:00:01Z') },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'hi' }], createdAt: new Date('2024-01-01T00:00:02Z') },
    ],
    compactedUpToMessageId: 'm2',
    compactedUpToCreatedAt: new Date('2024-01-01T00:00:02Z'),
    currentSummaryVersion: null,
    previousSummary: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetState.mockResolvedValue(null);
  mockUpsertState.mockResolvedValue(true);
  mockCreateAIProvider.mockResolvedValue({
    model: {} as never,
    provider: 'openrouter',
    modelName: 'gpt-4o',
  });
  mockGenerateText.mockResolvedValue({
    text: 'Summary: user said hello, assistant responded.',
    usage: { inputTokens: 10, outputTokens: 20 },
  } as never);
  mockGate.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold-1', walletId: 'w-turn' });
});

describe('runCompaction', () => {
  const BASE_PARAMS = {
    conversationId: 'conv-1',
    source: 'page' as const,
    pageId: 'page-1',
    userId: 'user-1',
    provider: 'openrouter',
    model: 'gpt-4o',
    plan: makePlan(),
    spend: { ...conversationSpend('drive-product', 'conv-1'), chosen: 'drive_wallet' as const },
  };

  it('calls generateText and upserts state on happy path', async () => {
    await runCompaction(BASE_PARAMS);
    expect(mockGenerateText).toHaveBeenCalledOnce();
    expect(mockUpsertState).toHaveBeenCalledOnce();
    const call = mockUpsertState.mock.calls[0][0];
    expect(call.conversationId).toBe('conv-1');
    expect(call.expectedVersion).toBeNull();
    expect(call.summary).toContain('Summary');
  });

  it('tracks usage with source=compaction', async () => {
    await runCompaction(BASE_PARAMS);
    expect(mockTrackUsage).toHaveBeenCalledOnce();
    const call = mockTrackUsage.mock.calls[0][0];
    expect(call.source).toBe('compaction');
  });

  describe('the credit gate (SPEND-1: one source chosen and reserved before the call)', () => {
    it('SPEND-1 (partial) an exhausted actor\'s compaction is refused before the model: no model call, no charge, no summary persisted', async () => {
      mockGate.mockResolvedValue({ allowed: false, reason: 'out_of_credits' });
      await expect(runCompaction(BASE_PARAMS)).resolves.toBeUndefined();
      expect(mockGate).toHaveBeenCalledOnce();
      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(mockTrackUsage).not.toHaveBeenCalled();
      expect(mockUpsertState).not.toHaveBeenCalled();
      expect(mockReleaseHold).not.toHaveBeenCalled();
    });

    it('SPEND-1 (partial) a funded compaction reserves on the turn\'s own target before the model, then settles once on that hold and wallet', async () => {
      await runCompaction(BASE_PARAMS);
      expect(mockGate).toHaveBeenCalledOnce();
      const [gateUser, gateOpts] = mockGate.mock.calls[0];
      expect(gateUser).toBe('user-1');
      expect(gateOpts.spend).toEqual(BASE_PARAMS.spend);
      expect(gateOpts.estCostCents).toBeGreaterThan(0);
      expect(mockGate.mock.invocationCallOrder[0]).toBeLessThan(mockGenerateText.mock.invocationCallOrder[0]);
      expect(mockTrackUsage).toHaveBeenCalledOnce();
      expect(mockTrackUsage.mock.calls[0][0]).toMatchObject({ holdId: 'hold-1', walletId: 'w-turn', source: 'compaction' });
      // trackUsage took the hold: nothing else releases it.
      expect(mockReleaseHold).not.toHaveBeenCalled();
      expect(mockUpsertState).toHaveBeenCalledOnce();
    });

    it('SPEND-6 (partial) an automation turn\'s compaction reserves on the drive and, refused, never falls back to a person', async () => {
      mockGate.mockResolvedValue({ allowed: false, reason: 'source_refused', refusal: { source: 'drive_wallet', reason: 'drive_wallet_empty', options: [] } });
      await runCompaction({ ...BASE_PARAMS, spend: automationSpend('drive-product') });
      expect(mockGate).toHaveBeenCalledOnce();
      expect(mockGate.mock.calls[0][1].spend).toEqual(automationSpend('drive-product'));
      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(mockTrackUsage).not.toHaveBeenCalled();
      expect(mockUpsertState).not.toHaveBeenCalled();
    });

    it('SPEND-6 (partial) an automation turn\'s compaction settles on the wallet the gate reserved on', async () => {
      mockGate.mockResolvedValue({ allowed: true, reason: 'ok', holdId: 'hold-a', walletId: 'w-product' });
      await runCompaction({ ...BASE_PARAMS, spend: automationSpend('drive-product') });
      expect(mockTrackUsage.mock.calls[0][0]).toMatchObject({ holdId: 'hold-a', walletId: 'w-product' });
    });

    it('a re-condense pass is part of the same reservation: two model calls, one settle', async () => {
      mockGenerateText
        .mockResolvedValueOnce({ text: 'x'.repeat(40000), usage: { inputTokens: 100, outputTokens: 8000 } } as never)
        .mockResolvedValueOnce({ text: 'Short condensed.', usage: { inputTokens: 30, outputTokens: 10 } } as never);
      await runCompaction(BASE_PARAMS);
      expect(mockGate).toHaveBeenCalledOnce();
      expect(mockGenerateText).toHaveBeenCalledTimes(2);
      expect(mockTrackUsage).toHaveBeenCalledOnce();
      expect(mockTrackUsage.mock.calls[0][0]).toMatchObject({ holdId: 'hold-1', inputTokens: 130, outputTokens: 8010 });
    });

    it('a model failure after the hold releases the reservation and persists nothing', async () => {
      mockGenerateText.mockRejectedValue(new Error('LLM down'));
      await runCompaction(BASE_PARAMS);
      expect(mockTrackUsage).not.toHaveBeenCalled();
      expect(mockReleaseHold).toHaveBeenCalledOnce();
      expect(mockReleaseHold).toHaveBeenCalledWith('hold-1');
      expect(mockUpsertState).not.toHaveBeenCalled();
    });

    it('a re-condense that fails after the first pass settles the spend already made, once, and persists nothing', async () => {
      mockGenerateText
        .mockResolvedValueOnce({ text: 'x'.repeat(40000), usage: { inputTokens: 100, outputTokens: 8000 } } as never)
        .mockRejectedValueOnce(new Error('LLM down'));
      await runCompaction(BASE_PARAMS);
      expect(mockTrackUsage).toHaveBeenCalledOnce();
      expect(mockTrackUsage.mock.calls[0][0]).toMatchObject({ holdId: 'hold-1', walletId: 'w-turn', inputTokens: 100, outputTokens: 8000 });
      expect(mockReleaseHold).not.toHaveBeenCalled();
      expect(mockUpsertState).not.toHaveBeenCalled();
    });

    it('a gate that cannot be checked calls no model and persists nothing', async () => {
      mockGate.mockRejectedValue(new Error('db down'));
      await expect(runCompaction(BASE_PARAMS)).resolves.toBeUndefined();
      expect(mockGenerateText).not.toHaveBeenCalled();
      expect(mockTrackUsage).not.toHaveBeenCalled();
      expect(mockUpsertState).not.toHaveBeenCalled();
    });

    it('takes no hold when there is nothing to summarize or no provider', async () => {
      await runCompaction({ ...BASE_PARAMS, plan: makePlan({ messagesToSummarize: [] }) });
      mockCreateAIProvider.mockResolvedValue({ error: 'No provider', status: 503 });
      await runCompaction(BASE_PARAMS);
      expect(mockGate).not.toHaveBeenCalled();
      expect(mockGenerateText).not.toHaveBeenCalled();
    });

    it('a flat-rate (metering-exempt) provider reserves nothing, as its turn did not', async () => {
      await runCompaction({ ...BASE_PARAMS, provider: 'glm' });
      expect(mockGate).not.toHaveBeenCalled();
      expect(mockGenerateText).toHaveBeenCalledOnce();
      expect(mockTrackUsage.mock.calls[0][0].holdId).toBeUndefined();
    });
  });

  it('never throws even when generateText throws', async () => {
    mockGenerateText.mockRejectedValue(new Error('LLM down'));
    await expect(runCompaction(BASE_PARAMS)).resolves.not.toThrow();
    expect(mockUpsertState).not.toHaveBeenCalled();
  });

  it('never throws when upsert loses the race (returns false)', async () => {
    mockUpsertState.mockResolvedValue(false);
    await expect(runCompaction(BASE_PARAMS)).resolves.not.toThrow();
  });

  it('records provider usage even when the version race is lost', async () => {
    mockUpsertState.mockResolvedValue(false);
    await runCompaction(BASE_PARAMS);
    // The paid model call happened — spend must be tracked regardless of
    // whether the generated summary won persistence.
    expect(mockTrackUsage).toHaveBeenCalledOnce();
  });

  it('refuses to persist an empty summary (pointer must not advance over lost history)', async () => {
    mockGenerateText.mockResolvedValue({ text: '   \n', usage: { inputTokens: 5, outputTokens: 0 } } as never);
    await runCompaction(BASE_PARAMS);
    expect(mockUpsertState).not.toHaveBeenCalled();
    // ...but the spend is still recorded
    expect(mockTrackUsage).toHaveBeenCalledOnce();
  });

  it('bounds generation with maxOutputTokens at the summary cap', async () => {
    await runCompaction(BASE_PARAMS);
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: expect.any(Number) })
    );
  });

  it('skips compaction if lastCompactedAt gap < 60s', async () => {
    const recent = new Date(Date.now() - 10_000); // 10s ago
    mockGetState.mockResolvedValue({
      conversationId: 'conv-1',
      source: 'page',
      pageId: 'page-1',
      summary: 'old',
      summaryTokens: 10,
      compactedUpToMessageId: null,
      compactedUpToCreatedAt: null,
      summaryVersion: 1,
      summarizerModel: null,
      lastCompactedAt: recent,
      createdAt: recent,
      updatedAt: recent,
    });
    await runCompaction(BASE_PARAMS);
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(mockUpsertState).not.toHaveBeenCalled();
  });

  it('proceeds when lastCompactedAt gap >= 60s', async () => {
    const old = new Date(Date.now() - 120_000); // 2min ago
    mockGetState.mockResolvedValue({
      conversationId: 'conv-1',
      source: 'page',
      pageId: 'page-1',
      summary: 'prior summary',
      summaryTokens: 10,
      compactedUpToMessageId: null,
      compactedUpToCreatedAt: null,
      summaryVersion: 2,
      summarizerModel: null,
      lastCompactedAt: old,
      createdAt: old,
      updatedAt: old,
    });
    await runCompaction({ ...BASE_PARAMS, plan: makePlan({ currentSummaryVersion: 2 }) });
    expect(mockGenerateText).toHaveBeenCalledOnce();
    const upsertCall = mockUpsertState.mock.calls[0][0];
    expect(upsertCall.expectedVersion).toBe(2);
  });

  it('does a re-condense pass when output exceeds maxSummaryTokens', async () => {
    // First call returns a very long summary
    const longSummary = 'x'.repeat(40000); // ~10k tokens
    mockGenerateText
      .mockResolvedValueOnce({
        text: longSummary,
        usage: { inputTokens: 50, outputTokens: 10000 },
      } as never)
      .mockResolvedValueOnce({
        text: 'Condensed summary.',
        usage: { inputTokens: 10, outputTokens: 5 },
      } as never);

    await runCompaction(BASE_PARAMS);
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    const upsertCall = mockUpsertState.mock.calls[0][0];
    expect(upsertCall.summary).toBe('Condensed summary.');
  });

  it('accumulates usage across both summarize calls when re-condensing', async () => {
    const longSummary = 'x'.repeat(40000); // triggers re-condense
    mockGenerateText
      .mockResolvedValueOnce({
        text: longSummary,
        usage: { inputTokens: 100, outputTokens: 8000 },
      } as never)
      .mockResolvedValueOnce({
        text: 'Short condensed.',
        usage: { inputTokens: 30, outputTokens: 10 },
      } as never);

    await runCompaction(BASE_PARAMS);
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    expect(mockTrackUsage).toHaveBeenCalledOnce();
    const usageCall = mockTrackUsage.mock.calls[0][0];
    // Both calls' tokens should be summed (100+30=130 in, 8000+10=8010 out)
    expect(usageCall.inputTokens).toBe(130);
    expect(usageCall.outputTokens).toBe(8010);
  });

  it('never throws when createAIProvider returns an error', async () => {
    mockCreateAIProvider.mockResolvedValue({ error: 'No provider', status: 503 });
    await expect(runCompaction(BASE_PARAMS)).resolves.not.toThrow();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});
