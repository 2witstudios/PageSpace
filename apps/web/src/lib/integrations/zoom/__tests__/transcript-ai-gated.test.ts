/**
 * The Zoom transcript enrichments (summary, action items) spend AI on the
 * connection owner, so both go through withZoomAiCredit. A refusal must never
 * reach the provider.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { gate, mockCreateAIProvider, mockGenerateText } = vi.hoisted(() => ({
  gate: { allowed: true, calls: [] as Array<{ userId: string; feature: string }> },
  mockCreateAIProvider: vi.fn(),
  mockGenerateText: vi.fn(),
}));

vi.mock('../zoom-ai-credit', () => ({
  withZoomAiCredit: async <T,>(userId: string, feature: string, run: () => Promise<T>, refused: T) => {
    gate.calls.push({ userId, feature });
    return gate.allowed ? run() : refused;
  },
}));
vi.mock('ai', () => ({ generateText: (...args: unknown[]) => mockGenerateText(...args) }));
vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: (...args: unknown[]) => mockCreateAIProvider(...args),
  isProviderError: () => false,
}));
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: vi.fn() },
  discardUsageOutcome: vi.fn(),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
}));

import { generateTranscriptSummary } from '../generate-summary';
import { extractActionItems } from '../extract-action-items';

describe('Zoom transcript AI enrichment is credit-gated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gate.allowed = true;
    gate.calls = [];
    mockCreateAIProvider.mockResolvedValue({ model: {}, provider: 'openai', modelName: 'm' });
  });

  it('given a refused owner, generateTranscriptSummary should return an empty summary and never resolve a provider', async () => {
    gate.allowed = false;

    expect(await generateTranscriptSummary('agent_1', 'Alice: hi')).toBe('');
    expect(gate.calls).toEqual([{ userId: 'agent_1', feature: 'zoom_summary' }]);
    expect(mockCreateAIProvider).not.toHaveBeenCalled();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('given a refused owner, extractActionItems should return no items and never resolve a provider', async () => {
    gate.allowed = false;

    expect(await extractActionItems('agent_1', 'Alice: hi')).toEqual([]);
    expect(gate.calls).toEqual([{ userId: 'agent_1', feature: 'zoom_action_items' }]);
    expect(mockCreateAIProvider).not.toHaveBeenCalled();
  });

  it('given model output with malformed entries, should keep only objects with a string text and a string assignee', async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: '```json\n[null, 3, {"text": 5}, {"text":"ship","assignee":7}, {"text":"review","assignee":"Ana"}]\n```',
      usage: {},
    });

    expect(await extractActionItems('user_1', 't')).toEqual([{ text: 'ship' }, { text: 'review', assignee: 'Ana' }]);
  });

  it('given model output that is not an array, should return no items', async () => {
    mockGenerateText.mockResolvedValueOnce({ text: '{"text":"ship"}', usage: {} });

    expect(await extractActionItems('user_1', 't')).toEqual([]);
  });

  it('given an allowed owner, both should still call the model', async () => {
    mockGenerateText
      .mockResolvedValueOnce({ text: '- decided', usage: {} })
      .mockResolvedValueOnce({ text: '[{"text":"ship"}]', usage: {} });

    expect(await generateTranscriptSummary('user_1', 't')).toBe('- decided');
    expect(await extractActionItems('user_1', 't')).toEqual([{ text: 'ship' }]);
    expect(mockCreateAIProvider).toHaveBeenCalledTimes(2);
  });
});
