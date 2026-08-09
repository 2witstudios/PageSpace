import { describe, it, vi, beforeEach } from 'vitest';
import { assert } from '@/lib/memory/__tests__/riteway';

/**
 * Personalization injection tests.
 *
 * Moving the profile to pages removed the only server-side length cap that
 * existed (the settings route's 40k validation). This module is now the sole
 * thing standing between a hand-edited page and every AI request, so the
 * budget behaviour is pinned here.
 */

const findFirst = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { userPersonalization: { findFirst: (...a: unknown[]) => findFirst(...a) } },
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/auth', () => ({ users: { id: 'id', timezone: 'timezone' } }));
vi.mock('@pagespace/db/schema/personalization', () => ({
  userPersonalization: { userId: 'userId' },
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

const readMemoryPages = vi.fn();
vi.mock('@pagespace/lib/memory/memory-pages', () => ({
  readMemoryPages: (...a: unknown[]) => readMemoryPages(...a),
}));

describe('getUserPersonalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findFirst.mockResolvedValue({ enabled: true, bio: null, writingStyle: null, rules: null });
    readMemoryPages.mockResolvedValue({});
  });

  it('returns null when the user has disabled personalization', async () => {
    findFirst.mockResolvedValue({ enabled: false, bio: 'x', writingStyle: null, rules: null });
    const { getUserPersonalization } = await import('../personalization-utils');

    assert({
      given: 'a user with personalization switched off',
      should: 'inject nothing, even though the page has content',
      actual: await getUserPersonalization('user-1'),
      expected: null,
    });
  });

  it('returns null when every page is empty', async () => {
    readMemoryPages.mockResolvedValue({ bio: '   ', writingStyle: '', rules: '' });
    const { getUserPersonalization } = await import('../personalization-utils');

    assert({
      given: 'pages that exist but hold only whitespace',
      should: 'inject nothing rather than an empty header',
      actual: await getUserPersonalization('user-1'),
      expected: null,
    });
  });

  it('truncates a single oversized page to its field budget', async () => {
    readMemoryPages.mockResolvedValue({ bio: 'x'.repeat(9000) });
    const { getUserPersonalization } = await import('../personalization-utils');

    const result = await getUserPersonalization('user-1');

    assert({
      given: 'a hand-edited bio far over its 3000-char budget',
      should: 'truncate it to the budget',
      actual: (result?.bio?.length ?? 0) <= 3000,
      expected: true,
    });
  });

  it('keeps the whole injected block within the total budget', async () => {
    // Every field at its own budget sums to 8000, over the 6000 total ceiling —
    // so this case exercises the total guard, not just the per-field one.
    readMemoryPages.mockResolvedValue({
      bio: 'b'.repeat(3000),
      writingStyle: 'w'.repeat(2500),
      rules: 'r'.repeat(2500),
    });
    const { getUserPersonalization } = await import('../personalization-utils');

    const result = await getUserPersonalization('user-1');
    const total =
      (result?.bio?.length ?? 0) +
      (result?.writingStyle?.length ?? 0) +
      (result?.rules?.length ?? 0);

    assert({
      given: 'all three pages at their individual budgets (8000 total)',
      should: 'cut the block down to the 6000-char total budget',
      actual: total <= 6000,
      expected: true,
    });
  });

  it('spends the total budget on behavioural fields before bio', async () => {
    // Rules and writing style change what the AI does; bio is context. When the
    // budget cannot fit everything, the behavioural fields survive intact and
    // bio absorbs the loss — never the other way round.
    readMemoryPages.mockResolvedValue({
      bio: 'b'.repeat(3000),
      writingStyle: 'w'.repeat(2500),
      rules: 'r'.repeat(2500),
    });
    const { getUserPersonalization } = await import('../personalization-utils');

    const result = await getUserPersonalization('user-1');

    assert({
      given: 'a profile over the total budget',
      should: 'keep rules and writingStyle whole and truncate bio instead',
      actual: {
        rules: result?.rules?.length === 2500,
        writingStyle: result?.writingStyle?.length === 2500,
        bioTruncated: (result?.bio?.length ?? 0) < 3000,
      },
      expected: { rules: true, writingStyle: true, bioTruncated: true },
    });
  });

  it('falls back to the legacy column when a page has no content yet', async () => {
    findFirst.mockResolvedValue({
      enabled: true,
      bio: 'legacy bio from before the backfill',
      writingStyle: null,
      rules: null,
    });
    readMemoryPages.mockResolvedValue({});
    const { getUserPersonalization } = await import('../personalization-utils');

    const result = await getUserPersonalization('user-1');

    assert({
      given: 'a user the backfill has not reached',
      should: 'still inject their legacy column content',
      actual: result?.bio,
      expected: 'legacy bio from before the backfill',
    });
  });

  it('prefers page content over the legacy column once both exist', async () => {
    findFirst.mockResolvedValue({
      enabled: true,
      bio: 'stale legacy bio',
      writingStyle: null,
      rules: null,
    });
    readMemoryPages.mockResolvedValue({ bio: 'current page bio' });
    const { getUserPersonalization } = await import('../personalization-utils');

    const result = await getUserPersonalization('user-1');

    assert({
      given: 'both a page and a legacy column',
      should: 'inject the page, which is what the user can actually edit',
      actual: result?.bio,
      expected: 'current page bio',
    });
  });
});
