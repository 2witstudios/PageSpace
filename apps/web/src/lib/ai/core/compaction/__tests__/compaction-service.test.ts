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

import { generateText } from 'ai';
import { getState, upsertState } from '../compaction-repository';
import { createAIProvider } from '@/lib/ai/core/provider-factory';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';
import { runCompaction } from '../compaction-service';
import type { CompactionPlan } from '@pagespace/lib/ai/context-window';

const mockGetState = vi.mocked(getState);
const mockUpsertState = vi.mocked(upsertState);
const mockGenerateText = vi.mocked(generateText);
const mockCreateAIProvider = vi.mocked(createAIProvider);
const mockTrackUsage = vi.mocked(AIMonitoring.trackUsage);

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
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  } as never);
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

  it('never throws even when generateText throws', async () => {
    mockGenerateText.mockRejectedValue(new Error('LLM down'));
    await expect(runCompaction(BASE_PARAMS)).resolves.not.toThrow();
    expect(mockUpsertState).not.toHaveBeenCalled();
  });

  it('never throws when upsert loses the race (returns false)', async () => {
    mockUpsertState.mockResolvedValue(false);
    await expect(runCompaction(BASE_PARAMS)).resolves.not.toThrow();
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
        usage: { promptTokens: 50, completionTokens: 10000, totalTokens: 10050 },
      } as never)
      .mockResolvedValueOnce({
        text: 'Condensed summary.',
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      } as never);

    await runCompaction(BASE_PARAMS);
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    const upsertCall = mockUpsertState.mock.calls[0][0];
    expect(upsertCall.summary).toBe('Condensed summary.');
  });

  it('never throws when createAIProvider returns an error', async () => {
    mockCreateAIProvider.mockResolvedValue({ error: 'No provider', status: 503 });
    await expect(runCompaction(BASE_PARAMS)).resolves.not.toThrow();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });
});
