import { describe, it, vi } from 'vitest';
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
