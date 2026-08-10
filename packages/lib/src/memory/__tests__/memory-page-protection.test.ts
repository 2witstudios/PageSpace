import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Memory pages are structural, not ordinary documents.
 *
 * The cron writes to them by pointer, the settings screen links to them, and
 * provisioning assumes they exist. A user who deletes one is left with a
 * profile that has nowhere to live: the pointer nulls, settings shows a dead
 * link, and the next nightly run silently writes nothing. So deletion is
 * refused — emptying the page erases the content, and the personalization
 * toggle stops it being used. Both are reversible; deletion is not.
 *
 * These tests pin the LOOKUP the three delete paths gate on.
 */

const rows: Record<string, unknown>[] = [];

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Object.assign(Promise.resolve(rows), {
          limit: () => Promise.resolve(rows.slice(0, 1)),
        }),
      }),
    }),
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
  isNull: vi.fn(),
  or: vi.fn(),
  sql: vi.fn(),
}));
vi.mock('@pagespace/db/schema/auth', () => ({ users: {} }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: {} }));
vi.mock('@pagespace/db/schema/personalization', () => ({
  userPersonalization: {
    id: 'id',
    memoryFolderId: 'memoryFolderId',
    bioPageId: 'bioPageId',
    writingStylePageId: 'writingStylePageId',
    rulesPageId: 'rulesPageId',
  },
}));
vi.mock('../../services/drive-service', () => ({ getHomeDrive: vi.fn() }));

describe('memory page deletion protection', () => {
  beforeEach(() => {
    rows.length = 0;
  });

  it('protects a page that a personalization pointer names', async () => {
    rows.push({ id: 'personalization-row' });
    const { isProtectedMemoryPage } = await import('../memory-pages');

    expect(await isProtectedMemoryPage('bio-page-1')).toBe(true);
  });

  it('leaves ordinary pages deletable', async () => {
    // No matching personalization row.
    const { isProtectedMemoryPage } = await import('../memory-pages');

    expect(await isProtectedMemoryPage('some-other-page')).toBe(false);
  });

  it('finds every protected id in a bulk request, and only those', async () => {
    // The bulk path must refuse the WHOLE batch rather than deleting the rest
    // around a memory page — a partial success is how someone loses their
    // profile without noticing which item did it.
    rows.push({
      memoryFolderId: 'folder-1',
      bioPageId: 'bio-1',
      writingStylePageId: 'style-1',
      rulesPageId: 'rules-1',
    });
    const { findProtectedMemoryPages } = await import('../memory-pages');

    const result = await findProtectedMemoryPages(['bio-1', 'ordinary-1', 'folder-1']);

    // 'style-1' and 'rules-1' are pointers but were not requested, so they must
    // not appear — the caller uses this set to name what it refused.
    expect([...result].sort()).toEqual(['bio-1', 'folder-1']);
  });

  it('does not query at all for an empty batch', async () => {
    const { findProtectedMemoryPages } = await import('../memory-pages');

    expect((await findProtectedMemoryPages([])).size).toBe(0);
  });

  it('offers the toggle before the clear-the-page workaround', async () => {
    // Deletion is redundant rather than missing: the toggle already stops the
    // AI using memory entirely, and emptying a page removes its content. The
    // refusal has to say so, strongest option first — a bare "cannot be
    // deleted" leaves someone who wants it gone with no next step, and leading
    // with "clear the page" offers the weaker remedy to someone whose actual
    // intent was to switch the feature off.
    const { MEMORY_PAGE_DELETE_ERROR } = await import('../memory-pages');

    const toggleAt = MEMORY_PAGE_DELETE_ERROR.search(/personalization off/i);
    const clearAt = MEMORY_PAGE_DELETE_ERROR.search(/clear the page/i);

    expect(toggleAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(-1);
    expect(toggleAt).toBeLessThan(clearAt);
  });
});
