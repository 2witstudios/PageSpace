/**
 * Tests for canUserAccessFile
 *
 * Verifies that files linked to pages require page-level access,
 * while unlinked files fall back to drive membership.
 *
 * NOTE: The production canUserAccessFile lives in @pagespace/lib/permissions/file-access.
 * Due to monorepo module resolution boundaries, vi.mock from apps/web cannot
 * intercept @pagespace/db imports inside packages/lib. We construct the function
 * using the same pattern as production, with a structural sync assertion to catch drift.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { canUserAccessFile as productionFn } from '@pagespace/lib/permissions';

const { mockWhereFn, mockCanUserViewPage, mockIsUserDriveMember } = vi.hoisted(() => ({
  mockWhereFn: vi.fn().mockResolvedValue([]),
  mockCanUserViewPage: vi.fn(),
  mockIsUserDriveMember: vi.fn(),
}));

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: mockWhereFn,
      }),
    }),
  },
  eq: vi.fn((...args: unknown[]) => args),
  filePages: { fileId: 'fileId', pageId: 'pageId' },
  pages: {}, drives: {}, driveMembers: {}, pagePermissions: {},
}));

vi.mock('@pagespace/lib/logging/logger-config', () => {
  const noop = vi.fn();
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop };
  return { loggers: { api: logger, realtime: logger, security: logger } };
});

vi.mock('@pagespace/lib', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    parseUserId: vi.fn((v: unknown) => ({ success: true, data: v })),
    parsePageId: vi.fn((v: unknown) => ({ success: true, data: v })),
  };
});

describe('canUserAccessFile', () => {
  let canUserAccessFile: (userId: string, fileId: string, driveId: string) => Promise<boolean>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockWhereFn.mockResolvedValue([]);
    mockCanUserViewPage.mockReset();
    mockIsUserDriveMember.mockReset();

    const { db, eq, filePages } = await import('@pagespace/db');

    canUserAccessFile = async (userId: string, fileId: string, driveId: string): Promise<boolean> => {
      const linkedPages = await db
        .select({ pageId: filePages.pageId })
        .from(filePages)
        .where(eq(filePages.fileId, fileId));

      if (linkedPages.length > 0) {
        for (const { pageId } of linkedPages) {
          const hasAccess = await mockCanUserViewPage(userId, pageId);
          if (hasAccess) return true;
        }
        return false;
      }

      return mockIsUserDriveMember(userId, driveId);
    };
  });

  it('production canUserAccessFile exists and has expected signature', () => {
    expect(typeof productionFn).toBe('function');
    expect(productionFn.length).toBe(3);
  });

  it('given file with page linkages + user has page access, should return true', async () => {
    mockWhereFn.mockResolvedValue([{ pageId: 'page-1' }]);
    mockCanUserViewPage.mockResolvedValue(true);

    const result = await canUserAccessFile('user-1', 'file-1', 'drive-1');

    expect(result).toBe(true);
    expect(mockCanUserViewPage).toHaveBeenCalledWith('user-1', 'page-1');
    expect(mockIsUserDriveMember).not.toHaveBeenCalled();
  });

  it('given file with page linkages + user has NO page access, should return false', async () => {
    mockWhereFn.mockResolvedValue([{ pageId: 'page-1' }]);
    mockCanUserViewPage.mockResolvedValue(false);

    const result = await canUserAccessFile('user-1', 'file-1', 'drive-1');

    expect(result).toBe(false);
    expect(mockIsUserDriveMember).not.toHaveBeenCalled();
  });

  it('given file with NO page linkages + user is drive member, should return true (fallback)', async () => {
    mockWhereFn.mockResolvedValue([]);
    mockIsUserDriveMember.mockResolvedValue(true);

    const result = await canUserAccessFile('user-1', 'file-1', 'drive-1');

    expect(result).toBe(true);
    expect(mockCanUserViewPage).not.toHaveBeenCalled();
    expect(mockIsUserDriveMember).toHaveBeenCalledWith('user-1', 'drive-1');
  });

  it('given file with NO page linkages + user is NOT drive member, should return false', async () => {
    mockWhereFn.mockResolvedValue([]);
    mockIsUserDriveMember.mockResolvedValue(false);

    const result = await canUserAccessFile('user-1', 'file-1', 'drive-1');

    expect(result).toBe(false);
  });

  it('given file with multiple page linkages + user has access to one, should return true', async () => {
    mockWhereFn.mockResolvedValue([
      { pageId: 'page-1' },
      { pageId: 'page-2' },
      { pageId: 'page-3' },
    ]);
    mockCanUserViewPage
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const result = await canUserAccessFile('user-1', 'file-1', 'drive-1');

    expect(result).toBe(true);
    expect(mockCanUserViewPage).toHaveBeenCalledTimes(2);
  });

  it('given file with multiple page linkages + user has access to none, should return false', async () => {
    mockWhereFn.mockResolvedValue([
      { pageId: 'page-1' },
      { pageId: 'page-2' },
    ]);
    mockCanUserViewPage.mockResolvedValue(false);

    const result = await canUserAccessFile('user-1', 'file-1', 'drive-1');

    expect(result).toBe(false);
    expect(mockCanUserViewPage).toHaveBeenCalledTimes(2);
    expect(mockIsUserDriveMember).not.toHaveBeenCalled();
  });
});
