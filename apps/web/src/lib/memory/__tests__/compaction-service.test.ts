import { describe, it, vi, beforeEach } from 'vitest';
import { assert } from './riteway';

/**
 * Compaction Service Tests
 *
 * Compaction is the mechanism that stops the profile growing without bound.
 * The budgets it enforces are the equilibrium size of each page, so these tests
 * pin the thresholds themselves — not just that some threshold exists.
 */

vi.mock('@pagespace/db/db', () => ({ db: {} }));
vi.mock('@pagespace/db/operators', () => ({ and: vi.fn(), eq: vi.fn() }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: {} }));
vi.mock('@pagespace/db/schema/personalization', () => ({
  userPersonalization: {},
  personalizationCandidates: {},
}));
const readMemoryPages = vi.fn(async () => ({}) as Record<string, string>);
vi.mock('@pagespace/lib/memory/memory-pages', () => ({
  readMemoryPages: (...a: unknown[]) => readMemoryPages(...(a as [])),
}));

// The page writer is the boundary compaction has to respect: it refuses when
// the user edited the page mid-run, or the pointer is stale.
const updatePersonalizationPage = vi.fn(
  async () => ({ written: true }) as { written: boolean; reason?: string }
);
vi.mock('../integration-service', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getCurrentPersonalizationPages: (...a: unknown[]) => readMemoryPages(...(a as [])),
    updatePersonalizationPage: (...a: unknown[]) =>
      updatePersonalizationPage(...(a as [])),
  };
});
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
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('ai', () => ({ generateText: vi.fn() }));

describe('needsCompaction', () => {
  it('leaves a page under its budget alone', async () => {
    const { needsCompaction } = await import('../compaction-service');

    assert({
      given: 'a bio comfortably under budget',
      should: 'not trigger compaction',
      actual: needsCompaction('x'.repeat(2999), 'bio'),
      expected: false,
    });
  });

  it('triggers once a page passes its budget', async () => {
    const { needsCompaction } = await import('../compaction-service');

    assert({
      given: 'a bio one character over budget',
      should: 'trigger compaction',
      actual: needsCompaction('x'.repeat(3001), 'bio'),
      expected: true,
    });
  });

  it('holds writingStyle and rules to a tighter budget than bio', async () => {
    const { needsCompaction } = await import('../compaction-service');

    // Between the 2500 behavioural budget and the 3000 bio budget.
    const content = 'x'.repeat(2750);

    assert({
      given: 'content between the behavioural and bio budgets',
      should: 'compact writingStyle and rules but not bio',
      actual: {
        bio: needsCompaction(content, 'bio'),
        writingStyle: needsCompaction(content, 'writingStyle'),
        rules: needsCompaction(content, 'rules'),
      },
      expected: { bio: false, writingStyle: true, rules: true },
    });
  });

  it('keeps every budget far below the old 20k ceiling', async () => {
    const { needsCompaction } = await import('../compaction-service');

    // The pre-rewrite design compacted at 18000 and targeted 14000, which made
    // ~14k the resting size of every field. Pin that this is gone.
    const oldRestingSize = 'x'.repeat(14000);

    assert({
      given: 'a page at the size the old design settled at',
      should: 'now be over budget for every field',
      actual: {
        bio: needsCompaction(oldRestingSize, 'bio'),
        writingStyle: needsCompaction(oldRestingSize, 'writingStyle'),
        rules: needsCompaction(oldRestingSize, 'rules'),
      },
      expected: { bio: true, writingStyle: true, rules: true },
    });
  });
});

describe('budget coherence across the three consumers', () => {
  it('compacts to a size the write guard will actually accept', async () => {
    // Compaction, the rewrite guard and prompt injection all act on these
    // numbers, and only work if they agree. If compaction targeted a size at or
    // above the guard's ceiling, every compaction result would be refused, the
    // page would stay over budget forever, and the cron would log "compacted"
    // each night while nothing changed. Nothing about that fails loudly.
    const { MAX_FIELD_LENGTH, compactionTarget } = await import('../budgets');

    const fields = ['bio', 'writingStyle', 'rules'] as const;
    assert({
      given: 'each field budget',
      should: 'leave compaction headroom strictly below the ceiling',
      actual: fields.every((f) => compactionTarget(f) < MAX_FIELD_LENGTH[f]),
      expected: true,
    });
  });

  it('keeps the total ceiling below the sum of the per-field budgets', async () => {
    // Equal to the sum, the total check could never fire — three already
    // truncated fields always fit — so it would read as protection while being
    // dead code. A mutation proved exactly that earlier in this branch.
    const { MAX_FIELD_LENGTH, MAX_TOTAL_INJECTION_LENGTH } = await import('../budgets');

    const sum = MAX_FIELD_LENGTH.bio + MAX_FIELD_LENGTH.writingStyle + MAX_FIELD_LENGTH.rules;

    assert({
      given: 'the per-field budgets and the total injection ceiling',
      should: 'make the total strictly smaller, so the total guard can fire',
      actual: MAX_TOTAL_INJECTION_LENGTH < sum,
      expected: true,
    });
  });
});

describe('checkAndCompactIfNeeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updatePersonalizationPage.mockResolvedValue({ written: true });
  });

  it('reports a field as compacted only when the write actually landed', async () => {
    // The page was edited by the user while this run was compacting, so the
    // write is refused. Reporting it as compacted would claim a page had shrunk
    // while it is still over budget — and the next run would do the same thing
    // again, reporting success every night while nothing changed.
    readMemoryPages.mockResolvedValue({ bio: 'x'.repeat(3500) });
    updatePersonalizationPage.mockResolvedValue({
      written: false,
      reason: 'page was edited during this run',
    });

    const { generateText } = await import('ai');
    vi.mocked(generateText).mockResolvedValue({
      text: 'short compacted bio',
      usage: { inputTokens: 10, outputTokens: 5 },
    } as never);
    const { createAIProvider } = await import('@/lib/ai/core/provider-factory');
    vi.mocked(createAIProvider).mockResolvedValue({
      model: {},
      provider: 'anthropic',
      modelName: 'm',
    } as never);

    const { checkAndCompactIfNeeded } = await import('../compaction-service');
    const result = await checkAndCompactIfNeeded('user-1');

    assert({
      given: 'a refused write for an over-budget page',
      should: 'report nothing as compacted',
      actual: { compacted: result.compacted, fields: result.fields },
      expected: { compacted: false, fields: [] },
    });
  });
});
