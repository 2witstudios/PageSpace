/**
 * Tests for ai-monitoring.ts
 * Mocks @pagespace/db, logger-database, and logger-config
 *
 * because the source builds Drizzle query chains that must be mimicked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ─────────────────────────────────────────────────────────────
const mockWriteAiUsage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
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

vi.mock('../../logging/logger-config', () => ({
  loggers: {
    ai: mockAiLogger,
  },
}));

vi.mock('@pagespace/db', () => ({
  db: {
    select: mockDbSelectFn,
  },
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
} from '../ai-monitoring';

// ---------------------------------------------------------------------------
// DB chain helpers
// ---------------------------------------------------------------------------

/**
 * @scaffold — ORM chain mock for db.select().from().where().limit()
 * Also supports: db.select().from() → awaitable (no .where() call).
 * Awaitable chain nodes use a plain thenable object (not Promise.resolve
 * extension) so the mock stays a simple object graph.
 */
function setupSelectChain(rows: unknown[]) {
  const resolve = (val: unknown) => ({ then: (fn: (v: unknown) => unknown) => Promise.resolve(fn(val)) });
  const limitFn = vi.fn().mockImplementation(() => resolve(rows));
  const whereFn = vi.fn().mockImplementation(() => ({ limit: limitFn, ...resolve(rows) }));
  const fromFn = vi.fn().mockImplementation(() => ({ where: whereFn, ...resolve(rows) }));

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
});

// ---------------------------------------------------------------------------
// trackAIUsage
// ---------------------------------------------------------------------------
describe('trackAIUsage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteAiUsage.mockResolvedValue(undefined);
  });

  it('should call writeAiUsage with computed cost and totals', async () => {
    await trackAIUsage({
      userId: 'user-1',
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      inputTokens: 1000,
      outputTokens: 500,
    });
    await vi.waitFor(() => { expect(mockWriteAiUsage).toHaveBeenCalledTimes(1); });
    const payload = mockWriteAiUsage.mock.calls[0][0];
    expect(payload.userId).toBe('user-1');
    expect(payload.provider).toBe('anthropic');
    expect(payload.model).toBe('claude-3-5-sonnet-20241022');
    expect(payload.inputTokens).toBe(1000);
    expect(payload.outputTokens).toBe(500);
    expect(payload.totalTokens).toBe(1500);
    expect(payload.success).toBe(true);
    expect(typeof payload.cost).toBe('number');
    expect(payload.cost).toBeGreaterThan(0);
  });

  it('should compute totalTokens from inputTokens + outputTokens', async () => {
    await trackAIUsage({ userId: 'user-1', provider: 'openai', model: 'gpt-4o', inputTokens: 200, outputTokens: 100 });
    await vi.waitFor(() => { expect(mockWriteAiUsage).toHaveBeenCalledTimes(1); });
    expect(mockWriteAiUsage.mock.calls[0][0].totalTokens).toBe(300);
  });

  it('should not override totalTokens when already provided', async () => {
    await trackAIUsage({ userId: 'user-1', provider: 'openai', model: 'gpt-4o', inputTokens: 200, outputTokens: 100, totalTokens: 999 });
    await vi.waitFor(() => { expect(mockWriteAiUsage).toHaveBeenCalledTimes(1); });
    expect(mockWriteAiUsage.mock.calls[0][0].totalTokens).toBe(999);
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
    await vi.waitFor(() => { expect(mockWriteAiUsage).toHaveBeenCalledTimes(1); });
    const payload = mockWriteAiUsage.mock.calls[0][0];
    expect(payload.contextMessages).toEqual(['msg-1', 'msg-2']);
    expect(payload.contextSize).toBe(500);
    expect(payload.systemPromptTokens).toBe(100);
    expect(payload.toolDefinitionTokens).toBe(50);
    expect(payload.conversationTokens).toBe(350);
    expect(payload.messageCount).toBe(2);
    expect(payload.wasTruncated).toBe(false);
    expect(payload.truncationStrategy).toBe('none');
  });

  it('should set success=true when success is not false', async () => {
    await trackAIUsage({ userId: 'user-1', provider: 'openai', model: 'gpt-4o' });
    await vi.waitFor(() => { expect(mockWriteAiUsage).toHaveBeenCalledTimes(1); });
    expect(mockWriteAiUsage.mock.calls[0][0].success).toBe(true);
  });

  it('should set success=false when explicitly set', async () => {
    await trackAIUsage({ userId: 'user-1', provider: 'openai', model: 'gpt-4o', success: false, error: 'fail' });
    await vi.waitFor(() => { expect(mockWriteAiUsage).toHaveBeenCalledTimes(1); });
    const payload = mockWriteAiUsage.mock.calls[0][0];
    expect(payload.success).toBe(false);
    expect(payload.error).toBe('fail');
  });

  it('should merge streamingDuration into metadata', async () => {
    await trackAIUsage({ userId: 'user-1', provider: 'openai', model: 'gpt-4o', streamingDuration: 1234, metadata: { custom: 'value' } });
    await vi.waitFor(() => { expect(mockWriteAiUsage).toHaveBeenCalledTimes(1); });
    expect(mockWriteAiUsage.mock.calls[0][0].metadata).toEqual({ custom: 'value', streamingDuration: 1234 });
  });

  it('should not throw and should log debug when writeAiUsage rejects', async () => {
    mockWriteAiUsage.mockRejectedValueOnce(new Error('db error'));
    await trackAIUsage({ userId: 'user-1', provider: 'openai', model: 'gpt-4o' });
    await vi.waitFor(() => { expect(mockAiLogger.debug).toHaveBeenCalledTimes(1); });
    expect(mockAiLogger.debug).toHaveBeenCalledWith(
      'AI usage tracking failed',
      { error: 'db error', model: 'gpt-4o', provider: 'openai' }
    );
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
    await vi.waitFor(() => { expect(mockWriteAiUsage).toHaveBeenCalledTimes(1); });
    const payload = mockWriteAiUsage.mock.calls[0][0];
    expect(payload.userId).toBe('user-1');
    expect(payload.provider).toBe('openai');
    expect(payload.model).toBe('gpt-4o');
    expect(payload.metadata.type).toBe('tool_call');
    expect(payload.metadata.toolName).toBe('searchPages');
    expect(payload.metadata.toolId).toBe('tool-123');
    expect(payload.metadata.args).toEqual({ query: 'hello' });
    expect(payload.metadata.result).toEqual({ pages: [] });
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
    expect(mockAiLogger.error).toHaveBeenCalledWith('Failed to get AI usage stats', new Error('db failure'));
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
    expect(mockAiLogger.error).toHaveBeenCalledWith('Failed to get popular AI features', new Error('db error'));
  });
});

// ---------------------------------------------------------------------------
// detectAIErrorPatterns
// ---------------------------------------------------------------------------
describe('detectAIErrorPatterns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** @scaffold — ORM chain mock for db.select().from().where() error pattern */
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
    expect(mockAiLogger.error).toHaveBeenCalledWith('Failed to detect AI error patterns', new Error('db failure'));
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
    expect(mockAiLogger.error).toHaveBeenCalledWith('Failed to calculate token efficiency metrics', new Error('db error'));
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
