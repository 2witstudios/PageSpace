/**
 * Tests for ai-monitoring.ts
 * Mocks @pagespace/db, logger-database, and logger-config
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mockWriteAiUsage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockConsumeCredits = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockAiLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
}));
const mockDbSelectFn = vi.hoisted(() => vi.fn());

// vi.mock paths are resolved relative to THIS test file.
// ai-monitoring.ts (in src/monitoring/) imports from '../logging/logger-database'
// which resolves to src/logging/logger-database.ts.
// From this test file (src/monitoring/__tests__/) → ../../logging/logger-database
vi.mock('../../logging/logger-database', () => ({
  writeAiUsage: mockWriteAiUsage,
}));

vi.mock('../../billing/credit-consume', () => ({
  consumeCredits: mockConsumeCredits,
}));

vi.mock('../../logging/logger-config', () => ({
  loggers: {
    ai: mockAiLogger,
  },
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: mockDbSelectFn,
  },
}));
vi.mock('@pagespace/db/schema/monitoring', () => ({
  aiUsageLogs: {
    userId: 'userId',
    provider: 'provider',
    model: 'model',
    cost: 'cost',
    totalTokens: 'totalTokens',
    inputTokens: 'inputTokens',
    outputTokens: 'outputTokens',
    duration: 'duration',
    success: 'success',
    timestamp: 'timestamp',
    error: 'error',
    metadata: 'metadata',
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  sql: vi.fn(),
  and: vi.fn((...conditions) => ({ type: 'and', conditions })),
  eq: vi.fn((field, value) => ({ type: 'eq', field, value })),
  gte: vi.fn((field, value) => ({ type: 'gte', field, value })),
  lte: vi.fn((field, value) => ({ type: 'lte', field, value })),
}));

// ── Import module under test AFTER mocks ─────────────────────────────────────
import {
  calculateCost,
  estimateTokens,
  getContextWindow,
  trackAIUsage,
  trackAIToolUsage,
  getUserAIStats,
  getPopularAIFeatures,
  detectAIErrorPatterns,
  getTokenEfficiencyMetrics,
  AI_PRICING,
  MODEL_CONTEXT_WINDOWS,
  AIMonitoring,
  extractOpenRouterCostDollars,
} from '../ai-monitoring';

// ---------------------------------------------------------------------------
// DB chain helpers
// ---------------------------------------------------------------------------

/**
 * Set up db.select().from().where() → resolves to rows.
 * Also supports: db.select().from().where().limit() for detectAIErrorPatterns.
 * Also supports: db.select().from() → resolves to rows (no .where() call).
 */
function setupSelectChain(rows: unknown[]) {
  const limitFn = vi.fn().mockResolvedValue(rows);

  // whereFn result is both a thenable (for direct await) and has .limit()
  const whereResult = {
    limit: limitFn,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
    catch: (reject: (e: unknown) => unknown) =>
      Promise.resolve(rows).catch(reject),
    finally: (cb: () => void) => Promise.resolve(rows).finally(cb),
  };
  const whereFn = vi.fn().mockReturnValue(whereResult);

  // fromFn result is both thenable (no .where() used) and has .where()
  const fromResult = {
    where: whereFn,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
    catch: (reject: (e: unknown) => unknown) =>
      Promise.resolve(rows).catch(reject),
    finally: (cb: () => void) => Promise.resolve(rows).finally(cb),
  };
  const fromFn = vi.fn().mockReturnValue(fromResult);
  mockDbSelectFn.mockReturnValue({ from: fromFn });
  return { fromFn, whereFn, limitFn };
}

// ---------------------------------------------------------------------------
// calculateCost
// ---------------------------------------------------------------------------
describe('calculateCost', () => {
  it('should calculate cost for a known model', () => {
    // anthropic/claude-3.5-sonnet: input=3.00, output=15.00 per 1M
    const cost = calculateCost('anthropic/claude-3.5-sonnet', 1_000_000, 1_000_000);
    expect(cost).toBe(Number((18.00).toFixed(6)));
  });

  it('should return 0 for free/local model', () => {
    expect(calculateCost('llama3.2', 100_000, 100_000)).toBe(0);
  });

  it('should fall back to default pricing (0,0) for unknown model', () => {
    expect(calculateCost('completely-unknown-model', 1_000_000, 1_000_000)).toBe(0);
  });

  // Regression guard: every PageSpace-tier backend model must be priced. These are
  // the resolved model ids that createAIProvider returns for the pagespace provider
  // (standard -> glm-4.7, pro -> glm-5) plus the agent/chat default glm-4.5-air. If
  // any of these is missing from AI_PRICING it meters at $0 and the platform eats the
  // spend (see PR #1475 — glm-4.5-air was previously unpriced).
  it.each(['glm-4.5-air', 'glm-4.7', 'glm-5'])(
    'prices PageSpace-tier model "%s" above $0',
    (model) => {
      expect(calculateCost(model, 1_000_000, 1_000_000)).toBeGreaterThan(0);
    }
  );

  it('prices glm-4.5-air at its published rate (0.35 in / 1.55 out per 1M)', () => {
    expect(calculateCost('glm-4.5-air', 1_000_000, 1_000_000)).toBe(
      Number((1.90).toFixed(6))
    );
  });

  it('should handle zero tokens', () => {
    expect(calculateCost('gpt-4o', 0, 0)).toBe(0);
  });

  it('should use default values of 0 for inputTokens and outputTokens', () => {
    expect(calculateCost('gpt-4o')).toBe(0);
  });

  it('should calculate only input cost when outputTokens is 0', () => {
    // gpt-4o: input=2.50 per 1M
    const cost = calculateCost('gpt-4o', 1_000_000, 0);
    expect(cost).toBe(Number((2.50).toFixed(6)));
  });

  it('should calculate only output cost when inputTokens is 0', () => {
    const cost = calculateCost('gpt-4o', 0, 1_000_000);
    expect(cost).toBe(Number((10.00).toFixed(6)));
  });

  it('should return result rounded to 6 decimal places', () => {
    const cost = calculateCost('gpt-4o-mini', 1, 1);
    const str = cost.toString();
    const decimals = str.includes('.') ? str.split('.')[1]!.length : 0;
    expect(decimals).toBeLessThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------
describe('estimateTokens', () => {
  it('should return 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('should return 0 for falsy value', () => {
    // @ts-expect-error intentional runtime test
    expect(estimateTokens(null)).toBe(0);
  });

  it('should return ceil(length/4)', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getContextWindow
// ---------------------------------------------------------------------------
describe('getContextWindow', () => {
  it('should return known context window for a recognised model', () => {
    expect(getContextWindow('gpt-4o')).toBe(MODEL_CONTEXT_WINDOWS['gpt-4o']);
  });

  it('should return default context window for unknown model', () => {
    expect(getContextWindow('totally-unknown-model')).toBe(MODEL_CONTEXT_WINDOWS.default);
  });

  it('should return correct value for anthropic model', () => {
    expect(getContextWindow('claude-3-5-sonnet-20241022')).toBe(200_000);
  });

  // Drift guard: every priced model must declare a context window, otherwise
  // getContextWindow() silently falls back to the 200k default and can truncate
  // or trip provider-side context limits. Keep AI_PRICING and
  // MODEL_CONTEXT_WINDOWS in lockstep when adding/removing models.
  it('should have a MODEL_CONTEXT_WINDOWS entry for every AI_PRICING model', () => {
    const missing = Object.keys(AI_PRICING).filter(
      (model) => model !== 'default' && !(model in MODEL_CONTEXT_WINDOWS)
    );
    expect(missing).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// trackAIUsage
// ---------------------------------------------------------------------------
describe('trackAIUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteAiUsage.mockResolvedValue(undefined);
    mockConsumeCredits.mockResolvedValue(undefined);
  });

  it('debits credits with the returned usage-log id on a successful call', async () => {
    mockWriteAiUsage.mockResolvedValueOnce('aul_42');
    await trackAIUsage({
      userId: 'user-1',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      inputTokens: 1000,
      outputTokens: 500,
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockConsumeCredits).toHaveBeenCalledWith(
      expect.objectContaining({ aiUsageLogId: 'aul_42', userId: 'user-1' }),
    );
    const arg = mockConsumeCredits.mock.calls[0][0] as { costDollars: number };
    expect(arg.costDollars).toBeGreaterThan(0);
  });

  it('awaits persistence before returning so the write/charge cannot be dropped on a serverless freeze', async () => {
    // Durability: trackAIUsage must not return until writeAiUsage AND the consume
    // have settled. We resolve writeAiUsage on a later microtask and assert that,
    // by the time the awaited trackAIUsage resolves, consumeCredits already ran —
    // WITHOUT any post-call setTimeout flush. A fire-and-forget chain would fail this.
    let resolveWrite!: (id: string) => void;
    mockWriteAiUsage.mockReturnValueOnce(new Promise<string>((res) => { resolveWrite = res; }));
    const tracked = trackAIUsage({
      userId: 'user-1',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(mockConsumeCredits).not.toHaveBeenCalled(); // write hasn't resolved yet
    resolveWrite('aul_durable');
    await tracked;
    // No setTimeout(0) flush here — if trackAIUsage were fire-and-forget this would be empty.
    expect(mockConsumeCredits).toHaveBeenCalledWith(
      expect.objectContaining({ aiUsageLogId: 'aul_durable', userId: 'user-1' }),
    );
  });

  it('does not debit credits for a token-less failure (pre-generation error, 0 tokens)', async () => {
    mockWriteAiUsage.mockResolvedValueOnce('aul_43');
    await trackAIUsage({ userId: 'user-1', provider: 'openai', model: 'gpt-4o', success: false, error: 'fail' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockConsumeCredits).not.toHaveBeenCalled();
  });

  it('debits credits for an errored call that still consumed tokens (errored-but-real spend)', async () => {
    // A mid-stream error/abort after tokens were generated: success=false but
    // real provider cost was incurred, so it must be billed.
    mockWriteAiUsage.mockResolvedValueOnce('aul_err');
    await trackAIUsage({
      userId: 'user-1',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      inputTokens: 1000,
      outputTokens: 500,
      success: false,
      error: 'stream aborted',
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockConsumeCredits).toHaveBeenCalledWith(
      expect.objectContaining({ aiUsageLogId: 'aul_err', userId: 'user-1' }),
    );
    const arg = mockConsumeCredits.mock.calls[0][0] as { costDollars: number };
    expect(arg.costDollars).toBeGreaterThan(0);
  });

  it('does not debit credits when no usage-log id is returned (write failed/skipped)', async () => {
    mockWriteAiUsage.mockResolvedValueOnce(null); // writeAiUsage resolves string | null
    await trackAIUsage({ userId: 'user-1', provider: 'openai', model: 'gpt-4o', inputTokens: 10, outputTokens: 10 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockConsumeCredits).not.toHaveBeenCalled();
  });

  it('should call writeAiUsage with computed cost and totals', async () => {
    await trackAIUsage({
      userId: 'user-1',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      inputTokens: 1000,
      outputTokens: 500,
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockWriteAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      })
    );
  });

  it('should compute totalTokens from inputTokens + outputTokens', async () => {
    await trackAIUsage({ userId: 'user-1', provider: 'openai', model: 'gpt-4o', inputTokens: 200, outputTokens: 100 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockWriteAiUsage).toHaveBeenCalledWith(expect.objectContaining({ totalTokens: 300 }));
  });

  it('should not override totalTokens when already provided', async () => {
    await trackAIUsage({ userId: 'user-1', provider: 'openai', model: 'gpt-4o', inputTokens: 200, outputTokens: 100, totalTokens: 999 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockWriteAiUsage).toHaveBeenCalledWith(expect.objectContaining({ totalTokens: 999 }));
  });

  it('should pass through optional context tracking fields', async () => {
    await trackAIUsage({
      userId: 'user-1',
      provider: 'openai',
      model: 'gpt-4o',
      contextMessages: ['msg-1', 'msg-2'],
      contextSize: 500,
      systemPromptTokens: 100,
      toolDefinitionTokens: 50,
      conversationTokens: 350,
      messageCount: 2,
      wasTruncated: false,
      truncationStrategy: 'none',
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockWriteAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        contextMessages: ['msg-1', 'msg-2'],
        contextSize: 500,
        systemPromptTokens: 100,
        messageCount: 2,
        wasTruncated: false,
      })
    );
  });

  it('should set success=true when success is not false', async () => {
    await trackAIUsage({ userId: 'user-1', provider: 'openai', model: 'gpt-4o' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockWriteAiUsage).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('honors an explicit costSource override (voice list_price) instead of the computed openrouter/estimate', async () => {
    // A finite providerCostDollars would normally stamp costSource='openrouter'
    // (mislabeling voice as a live provider-returned cost). The explicit override
    // must win so the admin panel classifies voice coverage as 'list_price'.
    await trackAIUsage({
      userId: 'user-1',
      provider: 'openai_voice',
      model: 'whisper-1',
      providerCostDollars: 0.006,
      costSource: 'list_price',
      metadata: { type: 'voice_stt' },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockWriteAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ type: 'voice_stt', costSource: 'list_price' }),
      }),
    );
  });

  it('should set success=false when explicitly set', async () => {
    await trackAIUsage({ userId: 'user-1', provider: 'openai', model: 'gpt-4o', success: false, error: 'fail' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockWriteAiUsage).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: 'fail' }));
  });

  it('should merge streamingDuration into metadata', async () => {
    await trackAIUsage({ userId: 'user-1', provider: 'openai', model: 'gpt-4o', streamingDuration: 1234, metadata: { custom: 'value' } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockWriteAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ custom: 'value', streamingDuration: 1234 }),
      })
    );
  });

  it('should pass a known feature source through to writeAiUsage', async () => {
    await trackAIUsage({ userId: 'user-1', provider: 'openai', model: 'gpt-4o', source: 'pulse' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockWriteAiUsage).toHaveBeenCalledWith(expect.objectContaining({ source: 'pulse' }));
  });

  it('should default a missing source to "other" via normalizeUsageSource', async () => {
    await trackAIUsage({ userId: 'user-1', provider: 'openai', model: 'gpt-4o' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockWriteAiUsage).toHaveBeenCalledWith(expect.objectContaining({ source: 'other' }));
  });

  it('should not throw and should log debug when writeAiUsage rejects', async () => {
    mockWriteAiUsage.mockRejectedValueOnce(new Error('db error'));
    await trackAIUsage({ userId: 'user-1', provider: 'openai', model: 'gpt-4o' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockAiLogger.debug).toHaveBeenCalledWith(
      'AI usage tracking failed',
      expect.objectContaining({ error: 'db error' })
    );
  });

  it('given AI request completes, should NOT write prompt or completion content to ai_usage_logs (#957 — GDPR data minimization)', async () => {
    await trackAIUsage({
      userId: 'user-1',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      inputTokens: 1000,
      outputTokens: 500,
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(mockWriteAiUsage).toHaveBeenCalledOnce();
    const callArg = mockWriteAiUsage.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg).not.toHaveProperty('prompt');
    expect(callArg).not.toHaveProperty('completion');
    // Token counts must still be present
    expect(callArg.inputTokens).toBe(1000);
    expect(callArg.outputTokens).toBe(500);
  });

  // ── Real provider cost (OpenRouter) vs static estimate ──────────────────────

  it('bills the real provider cost when providerCostDollars is present (preferred over the static estimate)', async () => {
    mockWriteAiUsage.mockResolvedValueOnce('aul_real');
    await trackAIUsage({
      userId: 'user-1',
      provider: 'openrouter',
      model: 'anthropic/claude-3.5-sonnet',
      inputTokens: 1000,
      outputTokens: 500,
      providerCostDollars: 0.0123,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Both the usage log and the charge bill on the real cost, not calculateCost().
    expect(mockWriteAiUsage).toHaveBeenCalledWith(expect.objectContaining({ cost: 0.0123 }));
    const arg = mockConsumeCredits.mock.calls[0][0] as { costDollars: number };
    expect(arg.costDollars).toBe(0.0123);
  });

  it('stamps costSource=openrouter on the usage log when real cost is used', async () => {
    await trackAIUsage({
      userId: 'user-1',
      provider: 'openrouter',
      model: 'anthropic/claude-3.5-sonnet',
      inputTokens: 1000,
      outputTokens: 500,
      providerCostDollars: 0.02,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockWriteAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ costSource: 'openrouter' }) }),
    );
  });

  it('falls back to the static estimate and stamps costSource=estimate when providerCostDollars is absent', async () => {
    mockWriteAiUsage.mockResolvedValueOnce('aul_est');
    await trackAIUsage({
      userId: 'user-1',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const expected = calculateCost('claude-3-5-sonnet-20241022', 1_000_000, 0);
    expect(mockWriteAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ cost: expected, metadata: expect.objectContaining({ costSource: 'estimate' }) }),
    );
    const arg = mockConsumeCredits.mock.calls[0][0] as { costDollars: number };
    expect(arg.costDollars).toBe(expected);
  });

  it('accepts a real cost of exactly 0 (cached/free OpenRouter call) instead of falling back', async () => {
    await trackAIUsage({
      userId: 'user-1',
      provider: 'openrouter',
      model: 'anthropic/claude-3.5-sonnet',
      inputTokens: 1000,
      outputTokens: 500,
      providerCostDollars: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockWriteAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ cost: 0, metadata: expect.objectContaining({ costSource: 'openrouter' }) }),
    );
  });

  it('ignores a non-finite or negative providerCostDollars and falls back to the estimate', async () => {
    await trackAIUsage({
      userId: 'user-1',
      provider: 'openrouter',
      model: 'anthropic/claude-3.5-sonnet',
      inputTokens: 1_000_000,
      outputTokens: 0,
      providerCostDollars: -5,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const expected = calculateCost('anthropic/claude-3.5-sonnet', 1_000_000, 0);
    expect(mockWriteAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({ cost: expected, metadata: expect.objectContaining({ costSource: 'estimate' }) }),
    );
  });

  it('logs a coverage-gap debug when an OpenRouter call is missing cost metadata', async () => {
    await trackAIUsage({
      userId: 'user-1',
      provider: 'openrouter_free',
      model: 'some/model:free',
      inputTokens: 10,
      outputTokens: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockAiLogger.debug).toHaveBeenCalledWith(
      'openrouter cost metadata missing; falling back to estimate',
      expect.objectContaining({ provider: 'openrouter_free' }),
    );
  });

  it('does NOT log a coverage gap for a direct provider (estimate is expected there)', async () => {
    await trackAIUsage({
      userId: 'user-1',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      inputTokens: 10,
      outputTokens: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockAiLogger.debug).not.toHaveBeenCalledWith(
      'openrouter cost metadata missing; falling back to estimate',
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// extractOpenRouterCostDollars
// ---------------------------------------------------------------------------
describe('extractOpenRouterCostDollars', () => {
  function step(cost?: number, upstreamInferenceCost?: number) {
    const usage: Record<string, unknown> = {};
    if (cost !== undefined) usage.cost = cost;
    if (upstreamInferenceCost !== undefined) usage.costDetails = { upstreamInferenceCost };
    return { providerMetadata: { openrouter: { usage } } };
  }

  it('returns the single-step OpenRouter cost', () => {
    expect(extractOpenRouterCostDollars([step(0.0042)])).toBe(0.0042);
  });

  it('sums cost across multiple tool-loop steps', () => {
    expect(extractOpenRouterCostDollars([step(0.001), step(0.002), step(0.003)])).toBeCloseTo(0.006, 10);
  });

  it('adds BYOK upstream inference cost to the OpenRouter fee', () => {
    expect(extractOpenRouterCostDollars([step(0.0001, 0.005)])).toBeCloseTo(0.0051, 10);
  });

  it('treats a zeroed (cached) cost as a real 0, not a missing value', () => {
    expect(extractOpenRouterCostDollars([step(0)])).toBe(0);
  });

  it('returns undefined when no step carries OpenRouter metadata (caller falls back)', () => {
    expect(extractOpenRouterCostDollars([{ providerMetadata: { anthropic: {} } }])).toBeUndefined();
    expect(extractOpenRouterCostDollars([{ providerMetadata: undefined }])).toBeUndefined();
    expect(extractOpenRouterCostDollars([{}])).toBeUndefined();
  });

  it('returns undefined for an empty or undefined steps array', () => {
    expect(extractOpenRouterCostDollars([])).toBeUndefined();
    expect(extractOpenRouterCostDollars(undefined)).toBeUndefined();
  });

  it('ignores malformed (non-numeric / NaN) cost fields', () => {
    const bad = { providerMetadata: { openrouter: { usage: { cost: 'free' } } } } as unknown as { providerMetadata?: Record<string, unknown> };
    expect(extractOpenRouterCostDollars([bad])).toBeUndefined();
    const nan = { providerMetadata: { openrouter: { usage: { cost: Number.NaN } } } };
    expect(extractOpenRouterCostDollars([nan])).toBeUndefined();
  });

  it('counts only the steps that carry cost when some are missing', () => {
    expect(extractOpenRouterCostDollars([step(0.01), { providerMetadata: undefined }, step(0.02)])).toBeCloseTo(0.03, 10);
  });
});

// ---------------------------------------------------------------------------
// trackAIToolUsage
// ---------------------------------------------------------------------------
describe('trackAIToolUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteAiUsage.mockResolvedValue(undefined);
  });

  it('should call trackAIUsage with tool metadata', async () => {
    await trackAIToolUsage({
      userId: 'user-1',
      provider: 'openai',
      model: 'gpt-4o',
      toolName: 'searchPages',
      toolId: 'tool-123',
      args: { query: 'hello' },
      result: { pages: [] },
      duration: 300,
      success: true,
      conversationId: 'conv-1',
      pageId: 'page-1',
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockWriteAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'tool',
        metadata: expect.objectContaining({ type: 'tool_call', toolName: 'searchPages', toolId: 'tool-123' }),
      })
    );
  });

  it('propagates the awaited persistence promise so the tool-call path is durable too', async () => {
    // trackAIToolUsage must RETURN trackAIUsage's promise — otherwise a caller that
    // `await`s trackToolUsage resolves before writeAiUsage settles, and the analytics
    // log can be dropped on a serverless freeze. We hold writeAiUsage open and assert
    // the awaited trackAIToolUsage does NOT resolve until the write settles. A wrapper
    // that didn't return the inner promise would resolve immediately and fail this.
    let resolveWrite!: (id: string) => void;
    mockWriteAiUsage.mockReturnValueOnce(new Promise<string>((res) => { resolveWrite = res; }));
    let resolved = false;
    const tracked = trackAIToolUsage({
      userId: 'user-1',
      provider: 'openai',
      model: 'gpt-4o',
      toolName: 'searchPages',
      success: true,
    }).then(() => { resolved = true; });
    await Promise.resolve(); // flush microtasks — write is still pending
    expect(resolved).toBe(false);
    resolveWrite('aul_tool');
    await tracked;
    expect(resolved).toBe(true);
    expect(mockWriteAiUsage).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getUserAIStats
// ---------------------------------------------------------------------------
describe('getUserAIStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return correct totals from DB records', async () => {
    const rows = [
      { provider: 'openai', model: 'gpt-4o', cost: 0.5, totalTokens: 1000, duration: 200, success: true },
      { provider: 'openai', model: 'gpt-4o', cost: 0.3, totalTokens: 800, duration: 150, success: true },
      { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', cost: 0.1, totalTokens: 500, duration: null, success: false },
    ];
    setupSelectChain(rows);
    const stats = await getUserAIStats('user-1');
    expect(stats.requestCount).toBe(3);
    expect(stats.totalCost).toBeCloseTo(0.9, 5);
    expect(stats.totalTokens).toBe(2300);
    expect(stats.successRate).toBeCloseTo((2 / 3) * 100, 2);
    expect(stats.byProvider['openai']?.requests).toBe(2);
    expect(stats.byProvider['anthropic']?.requests).toBe(1);
    expect(stats.byModel['gpt-4o']?.requests).toBe(2);
  });

  it('should return zero stats when no records exist', async () => {
    setupSelectChain([]);
    const stats = await getUserAIStats('user-1');
    expect(stats.requestCount).toBe(0);
    expect(stats.totalCost).toBe(0);
    expect(stats.successRate).toBe(0);
    expect(stats.averageDuration).toBe(0);
    expect(stats.byProvider).toEqual({});
    expect(stats.byModel).toEqual({});
  });

  it('should handle date filters', async () => {
    setupSelectChain([]);
    const stats = await getUserAIStats('user-1', new Date('2024-01-01'), new Date('2024-01-31'));
    expect(stats.requestCount).toBe(0);
  });

  it('should return empty stats on DB error', async () => {
    mockDbSelectFn.mockImplementation(() => { throw new Error('db failure'); });
    const stats = await getUserAIStats('user-1');
    expect(stats.requestCount).toBe(0);
    expect(mockAiLogger.error).toHaveBeenCalledWith('Failed to get AI usage stats', expect.any(Error));
  });

  it('should compute averageDuration correctly', async () => {
    const rows = [
      { provider: 'openai', model: 'gpt-4o', cost: 0, totalTokens: 0, duration: 100, success: true },
      { provider: 'openai', model: 'gpt-4o', cost: 0, totalTokens: 0, duration: 300, success: true },
    ];
    setupSelectChain(rows);
    const stats = await getUserAIStats('user-1');
    expect(stats.averageDuration).toBe(200);
  });

  it('should handle null cost and totalTokens in records', async () => {
    setupSelectChain([{ provider: 'openai', model: 'gpt-4o', cost: null, totalTokens: null, duration: null, success: true }]);
    const stats = await getUserAIStats('user-1');
    expect(stats.totalCost).toBe(0);
    expect(stats.totalTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getPopularAIFeatures
// ---------------------------------------------------------------------------
describe('getPopularAIFeatures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return feature usage grouped by type', async () => {
    const rows = [
      { metadata: { type: 'tool_call' }, userId: 'user-1' },
      { metadata: { type: 'tool_call' }, userId: 'user-2' },
      { metadata: { type: 'general_chat' }, userId: 'user-1' },
      { metadata: { feature: 'document_search' }, userId: 'user-3' },
    ];
    setupSelectChain(rows);
    const features = await getPopularAIFeatures();
    const toolCallFeature = features.find(f => f.feature === 'tool_call');
    expect(toolCallFeature).toBeDefined();
    expect(toolCallFeature?.users).toBe(2);
  });

  it('should use general_chat fallback when no type or feature in metadata', async () => {
    setupSelectChain([{ metadata: {}, userId: 'user-1' }]);
    const features = await getPopularAIFeatures();
    expect(features.find(f => f.feature === 'general_chat')).toBeDefined();
  });

  it('should skip records with no metadata', async () => {
    setupSelectChain([{ metadata: null, userId: 'user-1' }]);
    const features = await getPopularAIFeatures();
    expect(features).toHaveLength(0);
  });

  it('should respect the limit parameter', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      metadata: { type: `feature-${i}` },
      userId: `user-${i}`,
    }));
    setupSelectChain(rows);
    const features = await getPopularAIFeatures(5);
    expect(features.length).toBeLessThanOrEqual(5);
  });

  it('should apply date filters when provided', async () => {
    setupSelectChain([]);
    const features = await getPopularAIFeatures(10, new Date('2024-01-01'), new Date('2024-01-31'));
    expect(features).toEqual([]);
  });

  it('should apply no conditions when neither startDate nor endDate is provided', async () => {
    setupSelectChain([]);
    const features = await getPopularAIFeatures();
    expect(features).toEqual([]);
  });

  it('should return empty array on error', async () => {
    mockDbSelectFn.mockImplementation(() => { throw new Error('db error'); });
    const features = await getPopularAIFeatures();
    expect(features).toEqual([]);
    expect(mockAiLogger.error).toHaveBeenCalledWith('Failed to get popular AI features', expect.any(Error));
  });
});

// ---------------------------------------------------------------------------
// detectAIErrorPatterns
// ---------------------------------------------------------------------------
describe('detectAIErrorPatterns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setupErrorChain(rows: Array<{ error: string | null; provider: string; model: string }>) {
    const limitFn = vi.fn().mockResolvedValue(rows);
    const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    mockDbSelectFn.mockReturnValue({ from: fromFn });
  }

  it('should classify rate_limit_exceeded pattern', async () => {
    setupErrorChain([{ error: 'Rate limit exceeded on token budget', provider: 'openai', model: 'gpt-4o' }]);
    expect((await detectAIErrorPatterns()).find(p => p.pattern === 'rate_limit_exceeded')).toBeDefined();
  });

  it('should classify request_timeout pattern', async () => {
    setupErrorChain([{ error: 'Request timeout after 30s', provider: 'openai', model: 'gpt-4o' }]);
    expect((await detectAIErrorPatterns()).find(p => p.pattern === 'request_timeout')).toBeDefined();
  });

  it('should classify token_limit_exceeded pattern', async () => {
    setupErrorChain([{ error: 'Token limit exceeded by 500 tokens', provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' }]);
    expect((await detectAIErrorPatterns()).find(p => p.pattern === 'token_limit_exceeded')).toBeDefined();
  });

  it('should classify invalid_api_key pattern', async () => {
    setupErrorChain([{ error: 'Invalid key provided in authorization header', provider: 'openai', model: 'gpt-4o' }]);
    expect((await detectAIErrorPatterns()).find(p => p.pattern === 'invalid_api_key')).toBeDefined();
  });

  it('should classify network_error pattern', async () => {
    setupErrorChain([{ error: 'Network connection failed', provider: 'openai', model: 'gpt-4o' }]);
    expect((await detectAIErrorPatterns()).find(p => p.pattern === 'network_error')).toBeDefined();
  });

  it('should classify model_not_found pattern', async () => {
    setupErrorChain([{ error: 'Model not found: gpt-99', provider: 'openai', model: 'gpt-99' }]);
    expect((await detectAIErrorPatterns()).find(p => p.pattern === 'model_not_found')).toBeDefined();
  });

  it('should classify context_length_exceeded pattern', async () => {
    setupErrorChain([{ error: 'Context window overflow detected', provider: 'openai', model: 'gpt-4o' }]);
    expect((await detectAIErrorPatterns()).find(p => p.pattern === 'context_length_exceeded')).toBeDefined();
  });

  it('should classify unknown_error for unrecognised messages', async () => {
    setupErrorChain([{ error: 'Something unexpected happened', provider: 'openai', model: 'gpt-4o' }]);
    expect((await detectAIErrorPatterns()).find(p => p.pattern === 'unknown_error')).toBeDefined();
  });

  it('should skip records with null error', async () => {
    setupErrorChain([{ error: null, provider: 'openai', model: 'gpt-4o' }]);
    expect(await detectAIErrorPatterns()).toHaveLength(0);
  });

  it('should apply startDate filter when provided', async () => {
    setupErrorChain([]);
    expect(await detectAIErrorPatterns(10, new Date('2024-01-01'))).toHaveLength(0);
  });

  it('should respect the limit parameter', async () => {
    setupErrorChain(Array.from({ length: 3 }, (_, i) => ({ error: `rate limit hit #${i}`, provider: 'openai', model: 'gpt-4o' })));
    const patterns = await detectAIErrorPatterns(5);
    expect(patterns.length).toBeLessThanOrEqual(5);
  });

  it('should truncate sample to 200 chars', async () => {
    setupErrorChain([{ error: 'X'.repeat(300), provider: 'openai', model: 'gpt-4o' }]);
    const patterns = await detectAIErrorPatterns();
    expect(patterns[0]?.sample.length).toBeLessThanOrEqual(200);
  });

  it('should return empty array on error', async () => {
    mockDbSelectFn.mockImplementation(() => { throw new Error('db failure'); });
    const patterns = await detectAIErrorPatterns();
    expect(patterns).toEqual([]);
    expect(mockAiLogger.error).toHaveBeenCalledWith('Failed to detect AI error patterns', expect.any(Error));
  });
});

// ---------------------------------------------------------------------------
// getTokenEfficiencyMetrics
// ---------------------------------------------------------------------------
describe('getTokenEfficiencyMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return zero metrics when no records', async () => {
    setupSelectChain([]);
    const metrics = await getTokenEfficiencyMetrics();
    expect(metrics.averageTokensPerRequest).toBe(0);
    expect(metrics.mostEfficientModel).toBeNull();
    expect(metrics.leastEfficientModel).toBeNull();
  });

  it('should compute averages and efficiency from records', async () => {
    const rows = [
      { model: 'gpt-4o', inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.003 },
      { model: 'gpt-4o-mini', inputTokens: 200, outputTokens: 100, totalTokens: 300, cost: 0.001 },
    ];
    setupSelectChain(rows);
    const metrics = await getTokenEfficiencyMetrics();
    expect(metrics.averageTokensPerRequest).toBe(225);
    expect(metrics.mostEfficientModel).toBe('gpt-4o-mini');
    expect(metrics.leastEfficientModel).toBe('gpt-4o');
  });

  it('should handle records with null tokens and cost', async () => {
    setupSelectChain([{ model: 'gpt-4o', inputTokens: null, outputTokens: null, totalTokens: null, cost: null }]);
    const metrics = await getTokenEfficiencyMetrics();
    expect(metrics.averageTokensPerRequest).toBe(0);
  });

  it('should handle userId filter', async () => {
    setupSelectChain([]);
    const metrics = await getTokenEfficiencyMetrics('user-1');
    expect(metrics.averageTokensPerRequest).toBe(0);
  });

  it('should handle date filters', async () => {
    setupSelectChain([]);
    const metrics = await getTokenEfficiencyMetrics(undefined, new Date('2024-01-01'), new Date('2024-01-31'));
    expect(metrics.averageTokensPerRequest).toBe(0);
  });

  it('should return zero metrics on DB error', async () => {
    mockDbSelectFn.mockImplementation(() => { throw new Error('db error'); });
    const metrics = await getTokenEfficiencyMetrics();
    expect(metrics.averageTokensPerRequest).toBe(0);
    expect(mockAiLogger.error).toHaveBeenCalledWith('Failed to calculate token efficiency metrics', expect.any(Error));
  });

  it('should compute inputOutputRatio', async () => {
    setupSelectChain([{ model: 'gpt-4o', inputTokens: 100, outputTokens: 50, totalTokens: 150, cost: 0.01 }]);
    const metrics = await getTokenEfficiencyMetrics();
    expect(metrics.inputOutputRatio).toBe(Number((50 / 100).toFixed(2)));
  });

  it('should set inputOutputRatio to 0 when inputTokens is 0', async () => {
    setupSelectChain([{ model: 'gpt-4o', inputTokens: 0, outputTokens: 50, totalTokens: 50, cost: 0.01 }]);
    const metrics = await getTokenEfficiencyMetrics();
    expect(metrics.inputOutputRatio).toBe(0);
  });

  it('should not add model to efficiency map when tokens are 0', async () => {
    setupSelectChain([{ model: 'gpt-4o', inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0.01 }]);
    const metrics = await getTokenEfficiencyMetrics();
    expect(metrics.mostEfficientModel).toBeNull();
    expect(metrics.leastEfficientModel).toBeNull();
  });

  it('should handle userId + date filter combination', async () => {
    setupSelectChain([]);
    const metrics = await getTokenEfficiencyMetrics('user-1', new Date('2024-01-01'), new Date('2024-12-31'));
    expect(metrics.averageTokensPerRequest).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AIMonitoring namespace object
// ---------------------------------------------------------------------------
describe('AIMonitoring', () => {
  it('should expose all tracking functions', () => {
    expect(typeof AIMonitoring.trackUsage).toBe('function');
    expect(typeof AIMonitoring.trackToolUsage).toBe('function');
    expect(typeof AIMonitoring.getUserStats).toBe('function');
    expect(typeof AIMonitoring.getPopularFeatures).toBe('function');
    expect(typeof AIMonitoring.detectErrorPatterns).toBe('function');
    expect(typeof AIMonitoring.getEfficiencyMetrics).toBe('function');
    expect(typeof AIMonitoring.calculateCost).toBe('function');
    expect(typeof AIMonitoring.estimateTokens).toBe('function');
    expect(typeof AIMonitoring.getContextWindow).toBe('function');
  });

  it('should expose pricing and context window maps', () => {
    expect(AIMonitoring.pricing).toBe(AI_PRICING);
    expect(AIMonitoring.contextWindows).toBe(MODEL_CONTEXT_WINDOWS);
  });
});
