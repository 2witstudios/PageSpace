import { describe, it, vi } from 'vitest';
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
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));
vi.mock('ai', () => ({ generateText: vi.fn() }));

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
