import { describe, it, vi, beforeEach, expect } from 'vitest';
import { assert } from './riteway';

/**
 * Integration Service Tests
 *
 * The integration service rewrites whole memory pages rather than appending to
 * them. That is what lets the profile correct and forget — and also what makes
 * a bad generation able to wipe a page the user wrote by hand. These tests pin
 * the guards that bound that.
 */

vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn(),
  eq: vi.fn(),
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', content: 'content', isTrashed: 'isTrashed', updatedAt: 'updatedAt' },
}));
vi.mock('@pagespace/db/schema/personalization', () => ({
  userPersonalization: {
    userId: 'userId',
    bioPageId: 'bioPageId',
    writingStylePageId: 'writingStylePageId',
    rulesPageId: 'rulesPageId',
  },
  personalizationCandidates: { id: 'id' },
}));
vi.mock('@pagespace/lib/memory/memory-pages', () => ({
  readMemoryPages: vi.fn(async () => ({})),
}));
vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: vi.fn(),
  isProviderError: vi.fn(() => false),
}));
vi.mock('@/lib/ai/core/ai-providers-config', () => ({
  BACKGROUND_HEAVY_PROVIDER: 'anthropic',
  BACKGROUND_HEAVY_MODEL: 'anthropic/claude-sonnet-5',
}));
vi.mock('@pagespace/lib/monitoring/ai-monitoring', () => ({
  AIMonitoring: { trackUsage: vi.fn() },
  // These are pure-telemetry call sites: they hand the tracking promise to a NAMED
  // discard rather than leaving it to float, so the mocked module has to provide it.
  discardUsageOutcome: (tracking: Promise<unknown>) => {
    void Promise.resolve(tracking).then(
      () => undefined,
      () => undefined,
    );
  },
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('ai', () => ({ generateText: vi.fn() }));

const { mockReserve, mockReleaseMemoryHold } = vi.hoisted(() => {
  const mockReleaseMemoryHold = vi.fn();
  return {
    mockReleaseMemoryHold,
    mockReserve: vi.fn(async () => ({ allowed: true as const, holdId: 'hold-m', walletId: 'w-root', release: mockReleaseMemoryHold })),
  };
});
vi.mock('../memory-credit', () => ({ reserveMemoryCall: mockReserve }));

describe('screenRewrite — deletion guard', () => {
  it('rejects a rewrite that drops more than 40% of the page', async () => {
    const { screenRewrite } = await import('../integration-service');

    const current = 'x'.repeat(1000);
    const gutted = 'x'.repeat(400); // 60% deleted

    assert({
      given: 'a rewrite returning a fragment of an existing page',
      should: 'reject it rather than silently wiping the page',
      actual: screenRewrite('bio', current, gutted),
      expected: { ok: false, reason: 'would delete >40% of existing content' },
    });
  });

  it('allows a rewrite that trims within the deletion budget', async () => {
    const { screenRewrite } = await import('../integration-service');

    const current = 'x'.repeat(1000);
    const trimmed = 'x'.repeat(700); // 30% deleted

    assert({
      given: 'a rewrite that consolidates without gutting',
      should: 'allow it',
      actual: screenRewrite('bio', current, trimmed),
      expected: { ok: true },
    });
  });

  it('allows any first write when the page is empty', async () => {
    const { screenRewrite } = await import('../integration-service');

    assert({
      given: 'an empty existing page',
      should: 'allow the first write, since nothing can be deleted',
      actual: screenRewrite('bio', '', 'A short first entry.'),
      expected: { ok: true },
    });
  });
});

describe('screenRewrite — budget guard', () => {
  it('rejects content over the field budget', async () => {
    const { screenRewrite } = await import('../integration-service');

    const oversized = 'x'.repeat(3001); // bio budget is 3000

    assert({
      given: 'a rewrite exceeding the bio budget',
      should: 'reject it so the injected prompt stays bounded',
      actual: screenRewrite('bio', '', oversized).ok,
      expected: false,
    });
  });

  it('applies the tighter budget to writingStyle than to bio', async () => {
    const { screenRewrite } = await import('../integration-service');

    const content = 'x'.repeat(2750); // over writingStyle's 2500, under bio's 3000

    assert({
      given: 'content between the writingStyle and bio budgets',
      should: 'reject for writingStyle but allow for bio',
      actual: {
        writingStyle: screenRewrite('writingStyle', '', content).ok,
        bio: screenRewrite('bio', '', content).ok,
      },
      expected: { writingStyle: false, bio: true },
    });
  });

  it('accepts content exactly at the budget', async () => {
    const { screenRewrite } = await import('../integration-service');

    assert({
      given: 'content exactly at the bio budget',
      should: 'accept it — the limit is inclusive',
      actual: screenRewrite('bio', '', 'x'.repeat(3000)),
      expected: { ok: true },
    });
  });
});

describe('applyIntegrationDecisions', () => {
  it('reports a rejected field without updating it', async () => {
    const { applyIntegrationDecisions } = await import('../integration-service');

    const result = await applyIntegrationDecisions(
      'user-123',
      { bio: 'x'.repeat(100) },
      { bio: 'x'.repeat(1000) }
    );

    assert({
      given: 'a rewrite that trips the deletion guard',
      should: 'report no update and name the rejected field',
      actual: { updated: result.updated, fields: result.fields, rejected: result.rejected },
      expected: {
        updated: false,
        fields: [],
        rejected: [{ field: 'bio', reason: 'would delete >40% of existing content' }],
      },
    });
  });

  it('reports the rejected field as data, not a formatted string', async () => {
    // The cron decides whether to retire a candidate or retry it next run based
    // on which fields a guard refused. Parsing that back out of a message string
    // would break silently the moment the wording changed.
    const { applyIntegrationDecisions } = await import('../integration-service');

    const result = await applyIntegrationDecisions(
      'user-123',
      { writingStyle: 'x'.repeat(3000) },
      {}
    );

    assert({
      given: 'a rewrite rejected by the budget guard',
      should: 'expose the field as a discrete value',
      actual: result.rejected.map((r) => r.field),
      expected: ['writingStyle'],
    });
  });
});

describe('evaluateAndIntegrate — the credit gate (SPEND-1)', () => {
  const candidate = {
    id: 'cand-1',
    userId: 'user-1',
    field: 'bio',
    claim: 'Prefers terse answers',
    occurrences: 3,
    firstSeenAt: new Date('2026-09-01T00:00:00Z'),
  } as never;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { createAIProvider } = await import('@/lib/ai/core/provider-factory');
    vi.mocked(createAIProvider).mockResolvedValue({ model: {}, provider: 'anthropic', modelName: 'm' } as never);
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockResolvedValue({
      text: JSON.stringify({ bio: 'Prefers terse answers.', writingStyle: null, rules: null, usedInsights: [0] }),
      usage: { inputTokens: 10, outputTokens: 5 },
    } as never);
  });

  it('SPEND-1 (partial) an exhausted person\'s evaluation calls no model, charges nothing, and reaches no decision (candidates stay pending)', async () => {
    mockReserve.mockResolvedValueOnce({ allowed: false, reason: 'out_of_credits' } as never);
    const { generateText } = await import('ai');
    const { AIMonitoring } = await import('@pagespace/lib/monitoring/ai-monitoring');
    const { evaluateAndIntegrate } = await import('../integration-service');

    const outcome = await evaluateAndIntegrate('user-1', [candidate], { bio: 'Existing bio.' });

    expect(outcome.ok).toBe(false);
    expect(generateText).not.toHaveBeenCalled();
    expect(AIMonitoring.trackUsage).not.toHaveBeenCalled();
  });

  it('SPEND-8 (partial) a funded evaluation reserves before the model and settles once on that hold and wallet', async () => {
    const { generateText } = await import('ai');
    const { AIMonitoring } = await import('@pagespace/lib/monitoring/ai-monitoring');
    const { evaluateAndIntegrate } = await import('../integration-service');

    const outcome = await evaluateAndIntegrate('user-1', [candidate], { bio: 'Existing bio.' });

    expect(outcome).toMatchObject({ ok: true, usedCandidateIds: ['cand-1'] });
    expect(mockReserve).toHaveBeenCalledOnce();
    expect(mockReserve.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(generateText).mock.invocationCallOrder[0]);
    expect(AIMonitoring.trackUsage).toHaveBeenCalledOnce();
    expect(vi.mocked(AIMonitoring.trackUsage).mock.calls[0][0]).toMatchObject({ holdId: 'hold-m', walletId: 'w-root', source: 'memory' });
    expect(mockReleaseMemoryHold).not.toHaveBeenCalled();
  });

  it('a model failure after the reservation releases it and reaches no decision', async () => {
    const { generateText } = await import('ai');
    vi.mocked(generateText).mockRejectedValueOnce(new Error('down'));
    const { AIMonitoring } = await import('@pagespace/lib/monitoring/ai-monitoring');
    const { evaluateAndIntegrate } = await import('../integration-service');

    const outcome = await evaluateAndIntegrate('user-1', [candidate], { bio: 'Existing bio.' });

    expect(outcome.ok).toBe(false);
    expect(AIMonitoring.trackUsage).not.toHaveBeenCalled();
    expect(mockReleaseMemoryHold).toHaveBeenCalledOnce();
  });
});
