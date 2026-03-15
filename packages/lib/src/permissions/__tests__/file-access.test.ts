import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(),
  },
  filePages: { fileId: 'fileId', pageId: 'pageId' },
  eq: vi.fn((_a, _b) => 'eq'),
}));

vi.mock('../permissions', () => ({
  canUserViewPage: vi.fn(),
  isUserDriveMember: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { canUserAccessFile } from '../file-access';
import { db } from '@pagespace/db';
import { canUserViewPage, isUserDriveMember } from '../permissions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @scaffold — ORM chain mock: db.select().from().where() for file-page links */
function setupLinkedPages(pages: Array<{ pageId: string }>) {
  const fromFn = vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(pages),
  });
  vi.mocked(db.select).mockReturnValue({ from: fromFn } as unknown as ReturnType<typeof db.select>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('canUserAccessFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when user can view at least one linked page', async () => {
    setupLinkedPages([{ pageId: 'page-1' }, { pageId: 'page-2' }]);
    vi.mocked(canUserViewPage)
      .mockResolvedValueOnce(false)  // page-1: no access
      .mockResolvedValueOnce(true);  // page-2: has access

    const result = await canUserAccessFile('user-1', 'file-1', 'drive-1');
    expect(result).toBe(true);
  });

  it('returns false when user cannot view any linked page', async () => {
    setupLinkedPages([{ pageId: 'page-1' }, { pageId: 'page-2' }]);
    vi.mocked(canUserViewPage).mockResolvedValue(false);

    const result = await canUserAccessFile('user-1', 'file-1', 'drive-1');
    expect(result).toBe(false);
  });

  it('returns true immediately upon finding first accessible page (short-circuit)', async () => {
    setupLinkedPages([{ pageId: 'page-1' }, { pageId: 'page-2' }]);
    vi.mocked(canUserViewPage).mockResolvedValueOnce(true);

    const result = await canUserAccessFile('user-1', 'file-1', 'drive-1');
    expect(result).toBe(true);
    // Only called once because we short-circuited
    expect(canUserViewPage).toHaveBeenCalledTimes(1);
  });

  it('falls back to drive membership when no linked pages', async () => {
    setupLinkedPages([]);
    vi.mocked(isUserDriveMember).mockResolvedValue(true);

    const result = await canUserAccessFile('user-1', 'file-1', 'drive-1');
    expect(result).toBe(true);
    expect(isUserDriveMember).toHaveBeenCalledWith('user-1', 'drive-1');
  });

  it('returns false via drive membership when no linked pages and not a member', async () => {
    setupLinkedPages([]);
    vi.mocked(isUserDriveMember).mockResolvedValue(false);

    const result = await canUserAccessFile('user-1', 'file-1', 'drive-1');
    expect(result).toBe(false);
  });

  it('does not call isUserDriveMember when linked pages exist', async () => {
    setupLinkedPages([{ pageId: 'page-1' }]);
    vi.mocked(canUserViewPage).mockResolvedValue(false);

    await canUserAccessFile('user-1', 'file-1', 'drive-1');
    expect(isUserDriveMember).not.toHaveBeenCalled();
  });

  it('does not call canUserViewPage when no linked pages', async () => {
    setupLinkedPages([]);
    vi.mocked(isUserDriveMember).mockResolvedValue(false);

    await canUserAccessFile('user-1', 'file-1', 'drive-1');
    expect(canUserViewPage).not.toHaveBeenCalled();
  });
});
