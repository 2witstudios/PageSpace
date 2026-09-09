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
const selectWhere = vi.fn(() => Promise.resolve([] as Array<{ timezone: string | null }>));
const select = vi.fn(() => ({ from: () => ({ where: selectWhere }) }));
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { userPersonalization: { findFirst: (...a: unknown[]) => findFirst(...a) } },
    select: (...a: unknown[]) => select(...(a as [])),
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
    // Default: pointers present, so page content is the source of truth. Tests
    // that exercise the legacy fallback override this with null pointers.
    findFirst.mockResolvedValue({
      enabled: true,
      bio: null,
      writingStyle: null,
      rules: null,
      bioPageId: 'bio-page-1',
      writingStylePageId: 'style-page-1',
      rulesPageId: 'rules-page-1',
    });
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

  it('stops injecting legacy content once the user deletes the memory page', async () => {
    // The user deleted the page precisely to stop this content reaching the
    // AI. `readMemoryPages` omits a trashed page, so keying the fallback on
    // "no content came back" would resurrect the pre-deletion text and keep
    // sending it forever. A present pointer means the page is the source of
    // truth, and an empty result from it means empty.
    findFirst.mockResolvedValue({
      enabled: true,
      bio: 'the content they deleted the page to get rid of',
      writingStyle: null,
      rules: null,
      bioPageId: 'bio-page-1', // pointer still set; the page itself is gone
      writingStylePageId: null,
      rulesPageId: null,
    });
    readMemoryPages.mockResolvedValue({}); // trashed page omitted

    const { getUserPersonalization } = await import('../personalization-utils');

    assert({
      given: 'a deleted memory page whose pointer still exists',
      should: 'inject nothing for that field rather than the stale legacy column',
      actual: await getUserPersonalization('user-1'),
      expected: null,
    });
  });

  it('falls back to the legacy column when the user has no page pointer yet', async () => {
    findFirst.mockResolvedValue({
      enabled: true,
      bio: 'legacy bio from before the backfill',
      writingStyle: null,
      rules: null,
      // No pointers: the backfill has not reached this user, so there is no
      // page yet and the column is all they have.
      bioPageId: null,
      writingStylePageId: null,
      rulesPageId: null,
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
      bioPageId: 'bio-page-1',
      writingStylePageId: null,
      rulesPageId: null,
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

/**
 * The one place the body → profile → UTC order is defined.
 *
 * Every route that turns a naive wall-clock datetime into an instant resolves
 * through this function, so a task due "tomorrow at 7pm" and a calendar event
 * "tomorrow at 7pm" land at the same instant for the same caller. Calendar
 * create used to re-derive the rule as a bare Zod `.default('UTC')` and booked
 * events hours off for anyone who omitted the field (#2404).
 */
describe('resolveTimezone', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectWhere.mockResolvedValue([]);
  });

  it('prefers an explicit timezone over the stored profile', async () => {
    selectWhere.mockResolvedValue([{ timezone: 'America/Chicago' }]);
    const { resolveTimezone } = await import('../personalization-utils');

    assert({
      given: 'a request that names its own timezone',
      should: 'use it verbatim',
      actual: await resolveTimezone('Asia/Tokyo', 'user-1'),
      expected: 'Asia/Tokyo',
    });
  });

  it('does not read the profile when the caller supplied a timezone', async () => {
    const { resolveTimezone } = await import('../personalization-utils');
    await resolveTimezone('Asia/Tokyo', 'user-1');

    assert({
      given: 'an explicit timezone',
      should: 'skip the profile query entirely',
      actual: select.mock.calls.length,
      expected: 0,
    });
  });

  it('trims an explicit timezone', async () => {
    const { resolveTimezone } = await import('../personalization-utils');

    assert({
      given: 'a padded timezone string',
      should: 'return the trimmed zone',
      actual: await resolveTimezone('  Europe/Berlin  ', 'user-1'),
      expected: 'Europe/Berlin',
    });
  });

  it("falls back to the caller's profile when the request omits a timezone", async () => {
    selectWhere.mockResolvedValue([{ timezone: 'America/Chicago' }]);
    const { resolveTimezone } = await import('../personalization-utils');

    assert({
      given: 'no explicit timezone but a profile that has one',
      should: 'use the profile zone rather than UTC',
      actual: await resolveTimezone(undefined, 'user-1'),
      expected: 'America/Chicago',
    });
  });

  it('treats a blank explicit timezone as absent', async () => {
    selectWhere.mockResolvedValue([{ timezone: 'America/Chicago' }]);
    const { resolveTimezone } = await import('../personalization-utils');

    assert({
      given: 'a whitespace-only timezone field',
      should: 'fall through to the profile instead of storing an empty zone',
      actual: await resolveTimezone('   ', 'user-1'),
      expected: 'America/Chicago',
    });
  });

  it('falls back to UTC when the profile has no timezone either', async () => {
    selectWhere.mockResolvedValue([{ timezone: null }]);
    const { resolveTimezone } = await import('../personalization-utils');

    assert({
      given: 'a user who never set a timezone',
      should: 'end at UTC',
      actual: await resolveTimezone(null, 'user-1'),
      expected: 'UTC',
    });
  });

  it('falls back to UTC when the profile lookup fails', async () => {
    selectWhere.mockRejectedValue(new Error('db down'));
    const { resolveTimezone } = await import('../personalization-utils');

    assert({
      given: 'a database error during the profile read',
      should: 'still resolve to UTC rather than failing the write',
      actual: await resolveTimezone(undefined, 'user-1'),
      expected: 'UTC',
    });
  });
});
